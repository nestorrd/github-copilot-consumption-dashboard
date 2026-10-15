import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { computeTotals } from "../dist/tracker.js";
import { JsonStore } from "../dist/store.js";
import { buildDashboardState } from "../dist/state.js";
import { ExternalSessionMonitor, parseExternalSession } from "../dist/external-monitor.js";

test("absent telemetry is unavailable, not a free session", () => {
  const totals = computeTotals(undefined, []);
  assert.equal(totals.inputTokens, null);
  assert.equal(totals.outputTokens, null);
  assert.equal(totals.aiCredits, null);
  assert.equal(totals.estimatedUsd, null);
  assert.equal(totals.creditsStatus, "unavailable");
});

test("empty token metrics do not imply reported AI Credits", () => {
  const totals = computeTotals({ modelMetrics: {} }, []);
  assert.equal(totals.inputTokens, 0);
  assert.equal(totals.aiCredits, null);
  assert.equal(totals.estimatedUsd, null);
});

test("SDK unavailable status makes numeric zero unavailable", () => {
  const totals = computeTotals({ modelMetrics: {}, totalNanoAiu: 0, aiCreditsStatus: "unavailable" }, []);
  assert.equal(totals.aiCredits, null);
  assert.equal(totals.estimatedUsd, null);
});

test("numeric zero without coverage status is not a zero-cost claim", () => {
  assert.equal(computeTotals({ modelMetrics: {}, totalNanoAiu: 0 }, []).aiCredits, null);
});

test("explicit complete zero remains a legitimate reported zero", () => {
  const totals = computeTotals({ modelMetrics: {}, totalNanoAiu: 0, aiCreditsStatus: "complete" }, []);
  assert.equal(totals.aiCredits, 0);
  assert.equal(totals.estimatedUsd, 0);
  assert.equal(totals.creditsStatus, "complete");
});

test("partial zero remains partial", () => {
  assert.equal(computeTotals({ modelMetrics: {}, totalNanoAiu: 0, aiCreditsStatus: "partial" }, []).creditsStatus, "partial");
});

test("failed disk writes never publish a session as persisted", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "copilot-cost-store-"));
  try {
    const file = path.join(temp, "sessions.json");
    const store = new JsonStore(file);
    await store.load();
    await mkdir(file);
    const summary = {
      id: "unavailable-telemetry-regression", startTime: new Date().toISOString(),
      endTime: new Date().toISOString(), durationMs: 0, ...computeTotals(undefined, []),
      calls: [], telemetryWarnings: [], context: null, usageInfoEventCount: 0,
      totalsSource: "captured assistant.usage events", endReason: "user",
    };
    await assert.rejects(store.add(summary));
    assert.deepEqual(store.list(), []);
    await rm(file, { recursive: true });
    await store.add(summary);
    const reloaded = new JsonStore(file);
    await reloaded.load();
    assert.deepEqual(reloaded.get(summary.id), summary);
  } finally {
    await rm(temp, { recursive: true });
  }
});

function liveSnapshot(overrides = {}) {
  return {
    id: "live-session",
    startTime: "2026-01-01T00:00:00.000Z",
    elapsedMs: 1000,
    requestedModel: "test-model",
    busy: false,
    ending: false,
    completed: false,
    lastError: null,
    telemetryWarnings: [],
    usageInfoEventCount: 0,
    callCount: 0,
    calls: [],
    context: null,
    metricsSource: "captured assistant.usage events",
    updatedAt: "2026-01-01T00:00:01.000Z",
    models: [],
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    aiCredits: null,
    creditsStatus: "unavailable",
    estimatedUsd: null,
    ...overrides,
  };
}

function savedSummary(overrides = {}) {
  return {
    id: "live-session",
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2026-01-01T00:01:00.000Z",
    durationMs: 60000,
    models: ["test-model"],
    inputTokens: 30,
    outputTokens: 12,
    cachedTokens: 4,
    aiCredits: 2,
    creditsStatus: "complete",
    estimatedUsd: 0.02,
    totalsSource: "session.usage.getMetrics",
    endReason: "user",
    calls: [],
    telemetryWarnings: [],
    context: null,
    usageInfoEventCount: 0,
    ...overrides,
  };
}

test("new live sessions appear immediately with unavailable metrics", () => {
  const state = buildDashboardState([], liveSnapshot());
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].status, "active");
  assert.equal(state.sessions[0].storage, "live");
  assert.equal(state.sessions[0].aiCredits, null);
});

test("usage updates accumulate into the same live row without double counting", () => {
  const first = buildDashboardState([], liveSnapshot({
    busy: true, callCount: 1, inputTokens: 10, outputTokens: 4, aiCredits: 0.5, estimatedUsd: 0.005,
  }));
  const second = buildDashboardState([], liveSnapshot({
    callCount: 2, inputTokens: 30, outputTokens: 12, aiCredits: 2, estimatedUsd: 0.02,
  }));
  assert.equal(first.sessions[0].status, "processing");
  assert.equal(second.sessions.length, 1);
  assert.equal(second.sessions[0].id, first.sessions[0].id);
  assert.equal(second.sessions[0].inputTokens, 30);
  assert.equal(second.sessions[0].callCount, 2);
});

test("a saved record replaces the matching live row by session ID", () => {
  const saved = savedSummary();
  const whileSaving = buildDashboardState([saved], liveSnapshot({ completed: true }));
  assert.equal(whileSaving.sessions.length, 1);
  assert.equal(whileSaving.sessions[0].storage, "live");

  const completed = buildDashboardState([saved], null);
  assert.equal(completed.sessions.length, 1);
  assert.equal(completed.sessions[0].id, saved.id);
  assert.equal(completed.sessions[0].storage, "saved");
  assert.equal(completed.sessions[0].status, "completed");
});

test("save failures remain completed live rows with an explicit error", () => {
  const state = buildDashboardState([], liveSnapshot({
    completed: true,
    lastError: "Could not save session",
  }));
  assert.equal(state.sessions[0].status, "completed");
  assert.equal(state.sessions[0].storage, "live");
  assert.equal(state.sessions[0].lastError, "Could not save session");
});

test("external Copilot logs combine checkpoints with subsequent live usage", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "copilot-external-session-"));
  const id = "12345678-1234-1234-1234-123456789abc";
  const directory = path.join(temp, id);
  const file = path.join(directory, "events.jsonl");
  await mkdir(directory);
  const events = [
    {
      type: "session.start", id: "start", timestamp: "2026-10-15T10:00:00.000Z",
      data: { sessionId: id, startTime: "2026-10-15T10:00:00.000Z", selectedModel: "test-model" },
    },
    {
      type: "session.usage_record", id: "usage-1", timestamp: "2026-10-15T10:00:01.000Z",
      data: { usage: {
        model: "test-model", inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1,
        aiCreditsStatus: "complete", copilotUsage: { totalNanoAiu: 2_000_000_000 },
        accounting: { sourceSessionId: id, sequence: 1 },
      } },
    },
    {
      type: "session.usage_checkpoint", id: "checkpoint", timestamp: "2026-10-15T10:00:02.000Z",
      data: {
        totalNanoAiu: 2_000_000_000,
        usageAccountingWatermarks: { [id]: 1 },
        providerModelMetrics: [{
          modelId: "test-model",
          metrics: {
            requests: { count: 1 }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
            totalNanoAiu: 2_000_000_000, aiCreditsStatus: "complete",
          },
        }],
      },
    },
    {
      type: "assistant.turn_start", id: "turn", timestamp: new Date().toISOString(), data: {},
    },
    {
      type: "session.usage_record", id: "usage-2", timestamp: new Date().toISOString(),
      data: { usage: {
        model: "test-model", inputTokens: 20, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 1,
        aiCreditsStatus: "complete", copilotUsage: { totalNanoAiu: 3_000_000_000 },
        accounting: { sourceSessionId: id, sequence: 2 },
      } },
    },
  ];
  try {
    await writeFile(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    const session = await parseExternalSession(file, id);
    assert.equal(session.status, "processing");
    assert.equal(session.inputTokens, 30);
    assert.equal(session.outputTokens, 12);
    assert.equal(session.cachedTokens, 5);
    assert.equal(session.aiCredits, 5);
    assert.equal(session.callCount, 2);

    const monitor = new ExternalSessionMonitor(temp, 60_000);
    await monitor.start();
    assert.equal(monitor.list().length, 1);
    assert.equal(monitor.get(id)?.aiCredits, 5);
    monitor.stop();
  } finally {
    await rm(temp, { recursive: true });
  }
});

test("external session rows replace stale dashboard copies with the same ID", () => {
  const saved = savedSummary();
  const external = {
    ...buildDashboardState([saved], null).sessions[0],
    origin: "copilot",
    inputTokens: 99,
  };
  const state = buildDashboardState([saved], null, [external]);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].origin, "copilot");
  assert.equal(state.sessions[0].inputTokens, 99);
});
