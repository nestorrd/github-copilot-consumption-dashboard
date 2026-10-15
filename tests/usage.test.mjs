import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { computeTotals } from "../dist/tracker.js";
import { JsonStore } from "../dist/store.js";

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
