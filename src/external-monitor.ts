import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { config } from "./config.js";
import type { CallRecord, CreditsStatus, DashboardSession, Totals } from "./types.js";

interface UsageRecord {
  call: CallRecord;
  sourceSessionId: string | null;
  sequence: number | null;
}

interface CheckpointMetric {
  modelId?: unknown;
  metrics?: {
    requests?: { count?: unknown };
    usage?: {
      inputTokens?: unknown;
      outputTokens?: unknown;
      cacheReadTokens?: unknown;
    };
    totalNanoAiu?: unknown;
    aiCreditsStatus?: unknown;
  };
}

interface UsageCheckpoint {
  timestamp: string;
  totalNanoAiu: number;
  providerModelMetrics: CheckpointMetric[];
  watermarks: Record<string, number>;
}

export interface ExternalSessionDetail extends DashboardSession {
  calls: CallRecord[];
  telemetryWarnings: string[];
  totalsSource: "Copilot session event log";
  endReason: "shutdown" | "inferred" | null;
  updatedAt: string;
}

interface CachedSession {
  file: string;
  size: number;
  modifiedMs: number;
  detail: ExternalSessionDetail;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_GRACE_MS = 30 * 60_000;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function creditsStatus(value: unknown): CreditsStatus {
  return value === "complete" || value === "partial" ? value : "unavailable";
}

function sum(values: Array<number | null>): number | null {
  return values.length && values.every((value) => value !== null)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
    : null;
}

function callFromEvent(event: Record<string, unknown>, sessionId: string): UsageRecord | null {
  const data = object(event.data);
  const usage = object(data.usage);
  const model = string(usage.model);
  if (!model) return null;
  const copilotUsage = object(usage.copilotUsage);
  const nano = finite(copilotUsage.totalNanoAiu);
  const status = creditsStatus(usage.aiCreditsStatus);
  const accounting = object(usage.accounting);
  const sourceSessionId = string(accounting.sourceSessionId);
  const sequence = finite(accounting.sequence);
  const eventId = string(event.id) ?? `${sessionId}:${string(event.timestamp) ?? "unknown"}:${model}`;
  return {
    sourceSessionId,
    sequence,
    call: {
      eventId,
      timestamp: string(event.timestamp) ?? new Date(0).toISOString(),
      model,
      apiCallId: string(usage.apiCallId),
      inputTokens: finite(usage.inputTokens),
      outputTokens: finite(usage.outputTokens),
      cacheReadTokens: finite(usage.cacheReadTokens),
      cacheWriteTokens: finite(usage.cacheWriteTokens),
      aiCredits: nano === null || status === "unavailable" ? null : nano / config.nanoAiuPerCredit,
      totalNanoAiu: nano,
      creditsStatus: nano === null ? "unavailable" : status,
      durationMs: finite(usage.duration),
      initiator: string(usage.initiator),
      interactionType: string(usage.interactionType),
    },
  };
}

function checkpointFromEvent(event: Record<string, unknown>): UsageCheckpoint | null {
  const data = object(event.data);
  const totalNanoAiu = finite(data.totalNanoAiu);
  if (totalNanoAiu === null) return null;
  const rawMetrics = Array.isArray(data.providerModelMetrics) ? data.providerModelMetrics : [];
  const rawWatermarks = object(data.usageAccountingWatermarks);
  const watermarks: Record<string, number> = {};
  for (const [id, value] of Object.entries(rawWatermarks)) {
    const sequence = finite(value);
    if (sequence !== null) watermarks[id] = sequence;
  }
  return {
    timestamp: string(event.timestamp) ?? new Date(0).toISOString(),
    totalNanoAiu,
    providerModelMetrics: rawMetrics.map((metric) => object(metric) as CheckpointMetric),
    watermarks,
  };
}

function totalsFromUsage(records: UsageRecord[], checkpoint: UsageCheckpoint | null): Totals & { callCount: number } {
  let models: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let tokenDataAvailable = false;
  let totalNanoAiu = 0;
  let creditDataAvailable = false;
  let status: CreditsStatus = "complete";
  let callCount = 0;

  if (checkpoint) {
    totalNanoAiu = checkpoint.totalNanoAiu;
    creditDataAvailable = true;
    for (const raw of checkpoint.providerModelMetrics) {
      const model = string(raw.modelId);
      const metrics = raw.metrics;
      if (model) models.push(model);
      const usage = metrics?.usage;
      const input = finite(usage?.inputTokens);
      const output = finite(usage?.outputTokens);
      const cached = finite(usage?.cacheReadTokens);
      if (input !== null && output !== null && cached !== null) {
        inputTokens += input;
        outputTokens += output;
        cachedTokens += cached;
        tokenDataAvailable = true;
      }
      callCount += finite(metrics?.requests?.count) ?? 0;
      const metricStatus = creditsStatus(metrics?.aiCreditsStatus);
      if (metricStatus !== "complete") status = metricStatus;
    }
  }

  const tail = checkpoint
    ? records.filter((record) => {
      if (record.sourceSessionId && record.sequence !== null) {
        return record.sequence > (checkpoint.watermarks[record.sourceSessionId] ?? 0);
      }
      return record.call.timestamp > checkpoint.timestamp;
    })
    : records;

  for (const record of tail) {
    const call = record.call;
    models.push(call.model);
    const input = call.inputTokens;
    const output = call.outputTokens;
    const cached = call.cacheReadTokens;
    if (input !== null && output !== null && cached !== null) {
      inputTokens += input;
      outputTokens += output;
      cachedTokens += cached;
      tokenDataAvailable = true;
    }
    if (call.totalNanoAiu !== null && call.creditsStatus !== "unavailable") {
      totalNanoAiu += call.totalNanoAiu;
      creditDataAvailable = true;
      if (call.creditsStatus !== "complete") status = call.creditsStatus;
    } else {
      status = "partial";
    }
    callCount++;
  }

  models = [...new Set(models)];
  const aiCredits = creditDataAvailable ? totalNanoAiu / config.nanoAiuPerCredit : null;
  return {
    models,
    inputTokens: tokenDataAvailable ? inputTokens : sum(records.map((record) => record.call.inputTokens)),
    outputTokens: tokenDataAvailable ? outputTokens : sum(records.map((record) => record.call.outputTokens)),
    cachedTokens: tokenDataAvailable ? cachedTokens : sum(records.map((record) => record.call.cacheReadTokens)),
    aiCredits,
    creditsStatus: aiCredits === null ? "unavailable" : status,
    estimatedUsd: aiCredits === null ? null : aiCredits * config.usdPerCredit,
    callCount: Math.max(callCount, records.length),
  };
}

export async function parseExternalSession(
  file: string,
  sessionId = path.basename(path.dirname(file)),
  now = Date.now(),
): Promise<ExternalSessionDetail> {
  let startTime: string | null = null;
  let endTime: string | null = null;
  let updatedAt: string | null = null;
  let selectedModel: string | null = null;
  let checkpoint: UsageCheckpoint | null = null;
  let turnDepth = 0;
  const records: UsageRecord[] = [];
  const seenUsage = new Set<string>();
  const warnings: string[] = [];

  const lines = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      warnings.push("An incomplete event line was ignored; it will be retried on the next refresh.");
      continue;
    }
    const type = string(event.type);
    const timestamp = string(event.timestamp);
    if (timestamp) updatedAt = timestamp;
    if (type === "session.start") {
      const data = object(event.data);
      startTime = string(data.startTime) ?? timestamp ?? startTime;
      selectedModel = string(data.selectedModel) ?? selectedModel;
    } else if (type === "session.model_change") {
      const data = object(event.data);
      selectedModel = string(data.model) ?? string(data.selectedModel) ?? selectedModel;
    } else if (type === "assistant.turn_start") {
      turnDepth++;
    } else if (type === "assistant.turn_end") {
      turnDepth = Math.max(0, turnDepth - 1);
    } else if (type === "session.shutdown") {
      endTime = timestamp ?? updatedAt;
      turnDepth = 0;
    } else if (type === "session.usage_checkpoint") {
      checkpoint = checkpointFromEvent(event) ?? checkpoint;
    } else if (type === "session.usage_record") {
      const record = callFromEvent(event, sessionId);
      if (!record) continue;
      const identity = record.sourceSessionId && record.sequence !== null
        ? `${record.sourceSessionId}:${record.sequence}`
        : record.call.eventId;
      if (!seenUsage.has(identity)) {
        seenUsage.add(identity);
        records.push(record);
      }
    }
  }

  const stats = await fsp.stat(file);
  const fallbackTime = stats.birthtime.toISOString();
  startTime ??= fallbackTime;
  updatedAt ??= stats.mtime.toISOString();
  const lastTime = new Date(updatedAt).getTime();
  const inferredCompleted = !endTime && now - lastTime > ACTIVE_GRACE_MS;
  const status = endTime || inferredCompleted ? "completed" : turnDepth > 0 ? "processing" : "active";
  const effectiveEnd = endTime ?? (inferredCompleted ? updatedAt : null);
  const totals = totalsFromUsage(records, checkpoint);
  if (!totals.models.length && selectedModel) totals.models = [selectedModel];

  return {
    id: sessionId,
    startTime,
    endTime: effectiveEnd,
    durationMs: Math.max(0, new Date(effectiveEnd ?? updatedAt).getTime() - new Date(startTime).getTime()),
    status,
    storage: status === "completed" ? "saved" : "live",
    callCount: totals.callCount,
    lastError: null,
    origin: "copilot",
    models: totals.models,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cachedTokens: totals.cachedTokens,
    aiCredits: totals.aiCredits,
    creditsStatus: totals.creditsStatus,
    estimatedUsd: totals.estimatedUsd,
    calls: records.map((record) => record.call),
    telemetryWarnings: warnings,
    totalsSource: "Copilot session event log",
    endReason: endTime ? "shutdown" : inferredCompleted ? "inferred" : null,
    updatedAt,
  };
}

export class ExternalSessionMonitor {
  private readonly sessions = new Map<string, CachedSession>();
  private readonly listeners = new Set<() => void>();
  private timer?: NodeJS.Timeout;
  private scanPromise?: Promise<void>;
  private lastError: string | null = null;

  constructor(
    private readonly directory: string,
    private readonly intervalMs = 1000,
  ) {}

  async start(): Promise<void> {
    await this.scan();
    this.timer = setInterval(() => void this.scan(), this.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): DashboardSession[] {
    return [...this.sessions.values()]
      .map(({ detail: { calls, telemetryWarnings, totalsSource, endReason, updatedAt, ...row } }) => row)
      .sort((a, b) => b.startTime.localeCompare(a.startTime));
  }

  get(id: string): ExternalSessionDetail | undefined {
    return this.sessions.get(id)?.detail;
  }

  error(): string | null {
    return this.lastError;
  }

  private scan(): Promise<void> {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.scanInternal()
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        console.error("External Copilot session scan failed:", error);
      })
      .finally(() => { this.scanPromise = undefined; });
    return this.scanPromise;
  }

  private async scanInternal(): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Copilot session state directory not found: ${this.directory}`);
      }
      throw error;
    }

    const candidates: Array<{ id: string; file: string; stats: fs.Stats }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
      const file = path.join(this.directory, entry.name, "events.jsonl");
      try {
        candidates.push({ id: entry.name, file, stats: await fsp.stat(file) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    let changed = false;
    const present = new Set(candidates.map(({ id }) => id));
    for (const id of this.sessions.keys()) {
      if (!present.has(id)) {
        this.sessions.delete(id);
        changed = true;
      }
    }

    const pending = candidates.filter(({ id, stats }) => {
      const cached = this.sessions.get(id);
      return !cached || cached.size !== stats.size || cached.modifiedMs !== stats.mtimeMs;
    });
    const workers = Array.from({ length: Math.min(8, pending.length) }, async () => {
      while (pending.length) {
        const candidate = pending.shift();
        if (!candidate) return;
        const detail = await parseExternalSession(candidate.file, candidate.id);
        this.sessions.set(candidate.id, {
          file: candidate.file,
          size: candidate.stats.size,
          modifiedMs: candidate.stats.mtimeMs,
          detail,
        });
        changed = true;
      }
    });
    await Promise.all(workers);
    this.lastError = null;
    if (changed) for (const listener of this.listeners) listener();
  }
}
