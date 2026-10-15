import {
  CopilotClient, approveAll, type CopilotSession, type ModelBillingTokenPrices,
  type ShutdownData, type UsageGetMetricsResult,
} from "@github/copilot-sdk";
import { config } from "./config.js";
import type { JsonStore } from "./store.js";
import type { CallRecord, CreditsStatus, LiveSnapshot, SessionSummary, Totals } from "./types.js";

/*
 * SDK APIs used (verified against @github/copilot-sdk 1.0.22 type definitions):
 *   CopilotClient.start/stop/createSession/listModels   - available in 1.0.22
 *   CopilotSession.on / sendAndWait / abort / disconnect - available in 1.0.22
 *   session event "assistant.usage"       - ephemeral per-model-call usage (tokens, cache tokens,
 *                                           copilotUsage.totalNanoAiu; `cost` is @experimental)
 *   session event "session.usage_info"    - ephemeral context-window usage (NOT billing)
 *   session event "session.shutdown"      - final usage/metrics at shutdown (totalNanoAiu is @experimental)
 *   session.rpc.usage.getMetrics()        - @experimental: accumulated session metrics
 *   Model.billing.tokenPrices (models.list) - @experimental: AI Credits per token batch
 */

type MetricsLike = Pick<UsageGetMetricsResult, "modelMetrics" | "totalNanoAiu" | "aiCreditsStatus">
  | Pick<ShutdownData, "modelMetrics" | "totalNanoAiu">;

const nanoToCredits = (n: number) => n / config.nanoAiuPerCredit;
const toUsd = (credits: number | null) => (credits === null ? null : credits * config.usdPerCredit);

function sumNullable(values: Array<number | null | undefined>): number | null {
  if (!values.length || values.some((v) => v == null || !Number.isFinite(v))) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/** Builds totals from SDK metrics when available, otherwise from captured assistant.usage events. */
export function computeTotals(metrics: MetricsLike | undefined, calls: CallRecord[]): Totals {
  const entries = metrics ? Object.entries(metrics.modelMetrics).filter((entry) => entry[1] !== undefined) : [];
  let models: string[];
  let input: number | null;
  let output: number | null;
  let cached: number | null;
  if (entries.length) {
    models = entries.map(([k]) => k);
    input = sumNullable(entries.map(([, v]) => v?.usage.inputTokens));
    output = sumNullable(entries.map(([, v]) => v?.usage.outputTokens));
    cached = sumNullable(entries.map(([, v]) => v?.usage.cacheReadTokens));
  } else {
    models = [...new Set(calls.map((c) => c.model))];
    input = sumNullable(calls.map((c) => c.inputTokens));
    output = sumNullable(calls.map((c) => c.outputTokens));
    cached = sumNullable(calls.map((c) => c.cacheReadTokens));
    if (!calls.length && metrics) input = output = cached = 0;
  }

  let credits: number | null = null;
  let status: CreditsStatus = "unavailable";
  const metricStatus = metrics && "aiCreditsStatus" in metrics ? metrics.aiCreditsStatus : undefined;
  if (metrics?.totalNanoAiu !== undefined && Number.isFinite(metrics.totalNanoAiu) &&
    metricStatus !== "unavailable" &&
    (metrics.totalNanoAiu > 0 || metricStatus === "complete" || metricStatus === "partial")) {
    credits = nanoToCredits(metrics.totalNanoAiu);
    // ShutdownData has no aiCreditsStatus in 1.0.22; never assume full billing coverage.
    status = metricStatus ?? "partial";
  } else if (!metrics || metricStatus !== "unavailable") {
    const reported = calls.filter((c) => c.aiCredits !== null && c.creditsStatus !== "unavailable");
    if (reported.length) {
      credits = reported.reduce((sum, c) => sum + (c.aiCredits ?? 0), 0);
      status = reported.length === calls.length && reported.every((c) => c.creditsStatus === "complete")
        ? "complete" : "partial";
    }
  }
  return {
    models,
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
    aiCredits: credits,
    creditsStatus: status,
    estimatedUsd: toUsd(credits),
  };
}

interface Live {
  session: CopilotSession;
  id: string;
  start: Date;
  requestedModel: string | null;
  calls: CallRecord[];
  metrics?: UsageGetMetricsResult;
  context: LiveSnapshot["context"];
  busy: boolean;
  lastError: string | null;
  warnings: Set<string>;
  usageInfoEventCount: number;
  ending: boolean;
  turn?: Promise<void>;
  refresh?: Promise<void>;
  usageRevision: number;
  seenEvents: Set<string>;
  shutdown?: ShutdownData;
  completedSummary?: SessionSummary;
  refreshTimer?: NodeJS.Timeout;
  unsubscribe: () => void;
}

export interface ModelOption {
  id: string;
  name: string;
  tokenPrices: ModelBillingTokenPrices | null;
}

export class SessionTracker {
  private client?: CopilotClient;
  private clientPromise?: Promise<CopilotClient>;
  private starting = false;
  private live?: Live;
  private listeners = new Set<(snap: LiveSnapshot | null) => void>();

  constructor(private readonly store: JsonStore) { }

  onChange(fn: (snap: LiveSnapshot | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async getClient(): Promise<CopilotClient> {
    if (!this.clientPromise) {
      const client = new CopilotClient(config.githubToken ? { gitHubToken: config.githubToken } : {});
      this.clientPromise = client.start().then(() => {
        this.client = client;
        return client;
      }).catch((error: unknown) => {
        this.clientPromise = undefined;
        throw error;
      });
    }
    return this.clientPromise;
  }

  async listModels(): Promise<ModelOption[]> {
    const models = await (await this.getClient()).listModels();
    return models.map((m) => ({ id: m.id, name: m.name, tokenPrices: m.billing?.tokenPrices ?? null }));
  }

  async start(model?: string): Promise<LiveSnapshot> {
    if (this.live || this.starting) throw new Error("A session is already running or starting. End it first.");
    this.starting = true;
    try {
      const client = await this.getClient();
      const requested = model || config.defaultModel;
      const session = await client.createSession({
        ...(requested ? { model: requested } : {}),
        // Tool requests are rejected unless explicitly opted in, because prompts run on this machine.
        onPermissionRequest: config.approveAllTools ? approveAll : () => ({ kind: "reject" }),
      });
      const live: Live = {
        session,
        id: session.sessionId,
        start: new Date(),
        requestedModel: requested ?? null,
        calls: [],
        context: null,
        busy: false,
        lastError: null,
        warnings: new Set(),
        usageInfoEventCount: 0,
        ending: false,
        usageRevision: 0,
        seenEvents: new Set(),
        unsubscribe: () => undefined,
      };

      const offUsage = session.on("assistant.usage", (e) => {
        const d = e.data;
        const identity = d.accounting
          ? `${d.accounting.sourceSessionId}:${d.accounting.usageId}`
          : e.id;
        if (live.seenEvents.has(identity)) return;
        live.seenEvents.add(identity);
        live.usageRevision++;
        live.metrics = undefined;
        const nano = d.copilotUsage?.totalNanoAiu;
        const hasCredits = nano !== undefined && Number.isFinite(nano) && d.aiCreditsStatus !== "unavailable";
        live.calls.push({
          eventId: e.id,
          timestamp: e.timestamp,
          model: d.model,
          apiCallId: d.apiCallId ?? null,
          inputTokens: d.inputTokens ?? null,
          outputTokens: d.outputTokens ?? null,
          cacheReadTokens: d.cacheReadTokens ?? null,
          cacheWriteTokens: d.cacheWriteTokens ?? null,
          aiCredits: hasCredits ? nanoToCredits(nano) : null,
          totalNanoAiu: nano ?? null,
          creditsStatus: hasCredits ? d.aiCreditsStatus ?? "complete" : "unavailable",
          durationMs: d.duration ?? null,
          initiator: d.initiator ?? null,
          interactionType: d.interactionType ?? null,
        });
        this.scheduleRefresh(live);
      });
      const offInfo = session.on("session.usage_info", (e) => {
        if (e.agentId) return;
        live.usageInfoEventCount++;
        live.context = {
          currentTokens: e.data.currentTokens,
          tokenLimit: e.data.tokenLimit,
          messagesLength: e.data.messagesLength,
        };
        this.emit();
      });
      const offShutdown = session.on("session.shutdown", (e) => {
        if (e.agentId) return;
        live.shutdown = e.data;
      });
      const offError = session.on("session.error", (e) => {
        live.lastError = e.data.message;
        this.emit();
      });
      live.unsubscribe = () => {
        offUsage();
        offInfo();
        offShutdown();
        offError();
      };

      this.live = live;
      this.emit();
      await this.refreshMetrics(live);
      return this.snapshot()!;
    } finally {
      this.starting = false;
    }
  }

  /** Starts the prompt and returns immediately; progress arrives through usage events. */
  prompt(text: string): void {
    const live = this.live;
    if (!live) throw new Error("No active session.");
    if (live.completedSummary) throw new Error("The session has ended. Retry End & save to persist it.");
    if (live.ending) throw new Error("The session is ending.");
    if (live.busy) throw new Error("The session is still processing a prompt.");
    live.busy = true;
    live.lastError = null;
    this.emit();
    live.turn = live.session
      .sendAndWait({ prompt: text }, 10 * 60_000)
      .then(() => undefined)
      .catch((e: unknown) => {
        live.lastError = e instanceof Error ? e.message : String(e);
        console.error(`Prompt failed for ${live.id}:`, e);
      })
      .finally(async () => {
        live.busy = false;
        if (!live.ending) await this.refreshMetrics(live);
      });
  }

  async end(reason: SessionSummary["endReason"] = "user"): Promise<SessionSummary> {
    const live = this.live;
    if (!live) throw new Error("No active session.");
    if (live.ending) throw new Error("The session is already ending.");
    live.ending = true;
    this.emit();
    try {
      if (!live.completedSummary) {
        clearTimeout(live.refreshTimer);
        if (live.busy) {
          await live.session.abort();
          await live.turn;
        }
        await live.refresh;
        await this.refreshMetrics(live, false);
        await live.session.disconnect();
        live.unsubscribe();

        const end = new Date();
        const authoritative = live.metrics ?? live.shutdown;
        const totals = computeTotals(authoritative, live.calls);
        const summary: SessionSummary = {
          id: live.id,
          startTime: live.start.toISOString(),
          endTime: end.toISOString(),
          durationMs: end.getTime() - live.start.getTime(),
          ...totals,
          totalsSource: live.metrics
            ? "session.usage.getMetrics"
            : live.shutdown
              ? "session.shutdown"
              : "captured assistant.usage events",
          endReason: live.lastError && reason === "user" ? "error" : reason,
          calls: live.calls,
          telemetryWarnings: [...live.warnings],
          metricsSnapshot: live.metrics,
          shutdownMetrics: live.shutdown,
          context: live.context,
          usageInfoEventCount: live.usageInfoEventCount,
        };
        live.completedSummary = summary;
      }
      const summary = live.completedSummary;
      await this.store.add(summary);
      this.live = undefined;
      this.emit();
      return summary;
    } catch (error) {
      live.ending = false;
      live.lastError = error instanceof Error ? error.message : String(error);
      this.emit();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    try {
      if (this.live) await this.end("app-shutdown");
    } finally {
      if (this.client) {
        const errors = await this.client.stop();
        if (errors.length) throw new AggregateError(errors, "Copilot runtime shutdown failed");
      }
    }
  }

  snapshot(): LiveSnapshot | null {
    const live = this.live;
    if (!live) return null;
    const totals = computeTotals(live.metrics, live.calls);
    return {
      id: live.id,
      startTime: live.start.toISOString(),
      elapsedMs: Date.now() - live.start.getTime(),
      requestedModel: live.requestedModel,
      busy: live.busy,
      ending: live.ending,
      completed: live.completedSummary !== undefined,
      lastError: live.lastError,
      telemetryWarnings: [...live.warnings],
      usageInfoEventCount: live.usageInfoEventCount,
      callCount: live.calls.length,
      calls: live.calls,
      context: live.context,
      metricsSource: live.metrics ? "session.usage.getMetrics" : "captured assistant.usage events",
      updatedAt: new Date().toISOString(),
      ...totals,
    };
  }

  private scheduleRefresh(live: Live): void {
    clearTimeout(live.refreshTimer);
    if (!live.ending) live.refreshTimer = setTimeout(() => void this.refreshMetrics(live), 250);
    this.emit();
  }

  private async refreshMetrics(live: Live, notify = true): Promise<void> {
    const previous = live.refresh;
    const refresh = (async () => {
      await previous;
      const revision = live.usageRevision;
      try {
        const metrics = await live.session.rpc.usage.getMetrics(); // @experimental
        if (revision === live.usageRevision) live.metrics = metrics;
        const start = new Date(metrics.sessionStartTime);
        if (!Number.isNaN(start.getTime())) live.start = start;
      } catch (error) {
        live.metrics = undefined;
        const warning = `session.usage.getMetrics unavailable: ${error instanceof Error ? error.message : String(error)}. Using captured events; missing values remain Not available.`;
        live.warnings.add(warning);
        console.warn(warning);
      }
    })();
    live.refresh = refresh;
    await refresh;
    if (notify && this.live === live) this.emit();
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }
}
