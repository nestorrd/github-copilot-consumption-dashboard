import type { AiCreditsStatus, ShutdownData, UsageGetMetricsResult } from "@github/copilot-sdk";

export type CreditsStatus = AiCreditsStatus;

/** One model/API call, captured from the ephemeral `assistant.usage` event. null = not reported by the SDK. */
export interface CallRecord {
  eventId: string;
  timestamp: string;
  model: string;
  apiCallId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  aiCredits: number | null;
  totalNanoAiu: number | null;
  creditsStatus: CreditsStatus;
  durationMs: number | null;
  initiator: string | null;
  interactionType: string | null;
}

export interface Totals {
  models: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  aiCredits: number | null;
  creditsStatus: CreditsStatus;
  estimatedUsd: number | null;
}

/** Persisted summary of a completed session. */
export interface SessionSummary extends Totals {
  id: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  /** Where the totals came from. */
  totalsSource: "session.shutdown" | "session.usage.getMetrics" | "captured assistant.usage events";
  endReason: "user" | "app-shutdown" | "error";
  calls: CallRecord[];
  telemetryWarnings: string[];
  metricsSnapshot?: UsageGetMetricsResult;
  shutdownMetrics?: ShutdownData;
  context: LiveSnapshot["context"];
  usageInfoEventCount: number;
}

/** Live (non-persisted) snapshot of the running session. */
export interface LiveSnapshot extends Totals {
  id: string;
  startTime: string;
  elapsedMs: number;
  requestedModel: string | null;
  busy: boolean;
  ending: boolean;
  lastError: string | null;
  telemetryWarnings: string[];
  usageInfoEventCount: number;
  callCount: number;
  calls: CallRecord[];
  context: { currentTokens: number; tokenLimit: number; messagesLength: number } | null;
  metricsSource: "session.usage.getMetrics" | "captured assistant.usage events";
  updatedAt: string;
}
