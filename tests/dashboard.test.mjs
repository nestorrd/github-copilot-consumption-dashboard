import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("monitoring UI has no session controls or Source column and contains scrollable tables", () => {
  assert.doesNotMatch(html, /id="(?:startBtn|sendBtn|endBtn|promptInput|modelSelect)"/);
  assert.doesNotMatch(html, /<th>Source<\/th>/);
  assert.match(html, /class="table-scroll"/);
  assert.doesNotMatch(source, /\/api\/session\/(?:start|prompt|end)|\/api\/models/);
});

function dashboard() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        value: "", hidden: id === "detailPanel", innerHTML: "", textContent: "",
        style: {}, classList: { toggle() {} }, listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
        scrollIntoView() {},
      });
    }
    return elements.get(id);
  }
  const requests = [];
  const context = vm.createContext({
    document: {
      getElementById: element,
      body: { classList: { toggle() {} } },
      addEventListener() {},
    },
    window: { addEventListener() {} },
    setInterval() {},
    fetch(url) {
      return new Promise((resolve) => requests.push({ url, resolve }));
    },
  });
  vm.runInContext(source, context);
  return { element, requests, run: (code) => vm.runInContext(code, context) };
}

function row(id, startTime, overrides = {}) {
  return {
    id, startTime, durationMs: 1000, models: ["model"],
    inputTokens: 10, outputTokens: 2, cachedTokens: 3,
    aiCredits: 1, estimatedUsd: 0.01, creditsStatus: "complete",
    status: "active", storage: "live", origin: "copilot",
    ...overrides,
  };
}

test("the dashboard defaults to today and excludes all other dates from rows and totals", () => {
  const app = dashboard();
  const today = app.run("localDay(new Date())");
  assert.equal(app.element("fDate").value, today);
  const sessions = [
    row("today-session", `${today}T12:00:00`),
    row("old-session", "2020-01-01T12:00:00", { aiCredits: 999 }),
  ];
  app.run(`applyState(${JSON.stringify({ sessions, live: null })})`);
  assert.match(app.element("rows").innerHTML, /today-session/);
  assert.doesNotMatch(app.element("rows").innerHTML, /old-session/);
  assert.doesNotMatch(app.element("cards").innerHTML, /999/);

  app.element("fDate").value = "2020-01-01";
  app.element("fDate").listeners.change();
  assert.match(app.element("rows").innerHTML, /old-session/);
  assert.doesNotMatch(app.element("rows").innerHTML, /today-session/);
  app.element("fClear").onclick();
  assert.equal(app.element("fDate").value, "2020-01-01");
});

test("individual session consumption opens and refreshes on external live events", async () => {
  const app = dashboard();
  const today = app.element("fDate").value;
  const session = row("external-session", `${today}T12:00:00`);
  const state = { sessions: [session], live: null };
  app.run(`applyState(${JSON.stringify(state)})`);
  assert.match(app.element("rows").innerHTML, /data-session-id="external-session"/);
  const opening = app.run('showDetail("external-session")');
  const request = app.requests.find((request) => request.url === "/api/sessions/external-session");
  const detail = { ...session, calls: [], totalsSource: "Copilot session event log" };
  request.resolve({ ok: true, json: async () => detail });
  await opening;
  assert.equal(app.element("detailPanel").hidden, false);
  assert.match(app.element("detailBody").innerHTML, /external-session/);

  app.run(`applyState(${JSON.stringify(state)})`);
  const refresh = app.requests.at(-1);
  assert.equal(refresh.url, "/api/sessions/external-session");
  refresh.resolve({ ok: true, json: async () => ({ ...detail, inputTokens: 54321 }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(app.element("detailBody").innerHTML, /54[,. ]?321/);

  app.element("fDate").value = "2020-01-01";
  app.element("fDate").listeners.change();
  assert.equal(app.element("detailPanel").hidden, true);
  assert.equal(app.element("emptyMsg").hidden, false);
});

test("removing a selected session closes its details without breaking state reconciliation", async () => {
  const app = dashboard();
  app.run('selectedId = "removed"; $("detailPanel").hidden = false');
  assert.doesNotThrow(() => app.run('applyState({ sessions: [], live: null })'));
  assert.equal(app.element("detailPanel").hidden, true);
});
