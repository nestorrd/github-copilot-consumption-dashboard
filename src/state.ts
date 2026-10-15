import type {
  DashboardSession,
  DashboardState,
  LiveSnapshot,
  SessionStatus,
  SessionSummary,
} from "./types.js";

function liveStatus(live: LiveSnapshot): SessionStatus {
  if (live.completed) return "completed";
  return live.busy || live.ending ? "processing" : "active";
}

export function toLiveSession(live: LiveSnapshot): DashboardSession {
  return {
    id: live.id,
    startTime: live.startTime,
    endTime: live.completed ? live.updatedAt : null,
    durationMs: live.elapsedMs,
    status: liveStatus(live),
    storage: "live",
    callCount: live.callCount,
    lastError: live.lastError,
    origin: "dashboard",
    models: live.models.length
      ? live.models
      : live.requestedModel
        ? [live.requestedModel]
        : [],
    inputTokens: live.inputTokens,
    outputTokens: live.outputTokens,
    cachedTokens: live.cachedTokens,
    aiCredits: live.aiCredits,
    creditsStatus: live.creditsStatus,
    estimatedUsd: live.estimatedUsd,
  };
}

export function toSavedSession(summary: SessionSummary): DashboardSession {
  return {
    id: summary.id,
    startTime: summary.startTime,
    endTime: summary.endTime,
    durationMs: summary.durationMs,
    status: "completed",
    storage: "saved",
    callCount: summary.calls.length,
    lastError: null,
    origin: "dashboard",
    models: summary.models,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    cachedTokens: summary.cachedTokens,
    aiCredits: summary.aiCredits,
    creditsStatus: summary.creditsStatus,
    estimatedUsd: summary.estimatedUsd,
  };
}

export function buildDashboardState(
  saved: SessionSummary[],
  live: LiveSnapshot | null,
  external: DashboardSession[] = [],
  updatedAt = new Date().toISOString(),
): DashboardState {
  const liveRow = live ? toLiveSession(live) : null;
  const byId = new Map(saved.map((session) => [session.id, toSavedSession(session)]));
  for (const session of external) byId.set(session.id, session);
  if (liveRow) byId.set(liveRow.id, liveRow);
  const sessions = [...byId.values()];
  sessions.sort((a, b) => b.startTime.localeCompare(a.startTime));
  return { sessions, live, updatedAt };
}
