"use strict";

const $ = (id) => document.getElementById(id);
const NA = '<span class="na">Not available</span>';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let cfg = { sessionCreditBudget: 100, warnRatio: 0.8, usdPerCredit: 0.01 };
let sessions = [];
let selectedId = null;
let selectedStorage = null;
let refreshInFlight = null;
let eventsConnected = false;
let detailRequest = 0;

const fmtInt = (n) => (n === null || n === undefined ? NA : Math.round(n).toLocaleString());
const fmtCredits = (n) => (n === null || n === undefined ? NA : n.toLocaleString(undefined, { maximumFractionDigits: 6 }));
const fmtUsd = (n) => (n === null || n === undefined ? NA : "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }));
const fmtModels = (m) => (m && m.length ? esc(m.join(", ")) : NA);
const fmtDate = (iso) => new Date(iso).toLocaleString();
const partialLabel = (s) => s.creditsStatus === "partial" ? ' <span class="muted">(reported subtotal)</span>' : "";

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${m}m ${r}s` : m ? `${m}m ${r}s` : `${r}s`;
}

// green: normal, amber: >= warn ratio of budget, red: budget exceeded
function level(credits) {
  if (credits === null || credits === undefined) return "";
  if (credits > cfg.sessionCreditBudget) return "over";
  if (credits >= cfg.sessionCreditBudget * cfg.warnRatio) return "warn";
  return "ok";
}
async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function connectEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => {
    eventsConnected = true;
    setStale(false);
    applyState(JSON.parse(e.data));
  });
  es.onerror = () => {
    eventsConnected = false;
    setStale(true, "Live connection lost; displayed telemetry may be stale. Reconnecting...");
  };
  es.onopen = () => {
    eventsConnected = true;
    refreshState().catch(showPageError);
  };
}
function setStale(stale, message = "") {
  document.body.classList.toggle("data-stale", stale);
  $("connectionStatus").classList.toggle("stale", stale);
  $("connectionStatus").textContent = message;
}
function showPageError(error) {
  setStale(true, `State refresh failed; displayed data may be stale. ${error.message}`);
}

function applyState(state) {
  sessions = state.sessions;
  refreshModelFilter();
  renderTable();
  if (state.sourceError) {
    setStale(true, `Copilot session discovery failed; displayed data may be incomplete. ${state.sourceError}`);
  }

  if (selectedId && !$("detailPanel").hidden) {
    const selected = sessions.find((session) => session.id === selectedId);
    if (!selected) {
      closeDetail();
    } else {
      loadDetail(selectedId).catch(showPageError);
    }
    if (selected) selectedStorage = selected.storage;
  }
}

async function refreshState() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = api("/api/state")
    .then((state) => {
      applyState(state);
      if (!state.sourceError) {
        setStale(
          !eventsConnected,
          eventsConnected ? "" : "Live connection unavailable; state refreshed via fallback and may become stale.",
        );
      }
      return state;
    })
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

// ---- history ----
function filtered() {
  const d = $("fDate").value || localDay(new Date()), m = $("fModel").value, q = $("fSession").value.trim().toLowerCase();
  return sessions.filter((s) => {
    if (localDay(s.startTime) !== d) return false;
    if (m && !s.models.includes(m)) return false;
    if (q && !s.id.toLowerCase().includes(q)) return false;
    return true;
  });
}

function sumField(rows, f) {
  const vals = rows.map((r) => r[f]).filter((v) => v !== null && v !== undefined);
  return { total: vals.length ? vals.reduce((a, b) => a + b, 0) : null, missing: rows.length - vals.length };
}

function renderCards(rows) {
  const credits = sumField(rows, "aiCredits"), usd = sumField(rows, "estimatedUsd");
  const inp = sumField(rows, "inputTokens"), out = sumField(rows, "outputTokens");
  const note = (x) => (x.missing && rows.length ? `<div class="note">${x.missing} session(s) without data</div>` : "");
  const partial = rows.some((s) => s.creditsStatus === "partial")
    ? '<div class="note">Includes reported subtotals; actual total is not available.</div>' : "";
  const card = (label, value, extra) => `<div class="card"><span class="label">${label}</span><div class="value">${value}</div>${extra || ""}</div>`;
  $("cards").innerHTML =
    card("Total AI Credits", fmtCredits(credits.total), note(credits) + partial) +
    card("Estimated total cost", fmtUsd(usd.total), note(usd) + partial) +
    card("Total sessions", rows.length, '<div class="note">live and saved' + (rows.length !== sessions.length ? " (filtered)" : "") + "</div>") +
    card("Total input tokens", fmtInt(inp.total), note(inp)) +
    card("Total output tokens", fmtInt(out.total), note(out));
}

function localDay(iso) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderTable() {
  const rows = filtered();
  renderCards(rows);
  $("emptyMsg").hidden = rows.length > 0;
  $("rows").innerHTML = rows.map((s) => {
    const lv = level(s.aiCredits);
    const status = s.status[0].toUpperCase() + s.status.slice(1);
    return `<tr data-id="${esc(s.id)}" class="${s.id === selectedId ? "selected" : ""}">
      <td><button class="mono" data-session-id="${esc(s.id)}" title="Open session ${esc(s.id)}">${esc(s.id.slice(0, 8))} - View usage</button></td>
      <td><span class="chip ${esc(s.status)}">${esc(status)}</span></td>
      <td title="${esc(fmtDate(s.startTime))}">${esc(new Date(s.startTime).toLocaleTimeString())}</td>
      <td>${fmtDuration(s.durationMs)}</td>
      <td>${fmtModels(s.models)}</td>
      <td class="num">${fmtInt(s.inputTokens)}</td>
      <td class="num">${fmtInt(s.outputTokens)}</td>
      <td class="num ${lv}">${fmtCredits(s.aiCredits)}${partialLabel(s)}</td>
      <td class="num ${lv}">${fmtUsd(s.estimatedUsd)}${partialLabel(s)}</td></tr>`;
  }).join("");
}

function refreshModelFilter() {
  const current = $("fModel").value;
  const models = [...new Set(sessions.flatMap((s) => s.models))].sort();
  $("fModel").innerHTML = '<option value="">All models</option>' + models.map((m) => `<option>${esc(m)}</option>`).join("");
  $("fModel").value = models.includes(current) ? current : "";
}

async function loadSessions() {
  return refreshState();
}

// ---- details ----
function renderDetail(s) {
  const lv = level(s.aiCredits);
  const meta = [
    ["Session ID", `<span class="mono">${esc(s.id)}</span>`],
    ["Status", esc(s.status[0].toUpperCase() + s.status.slice(1))],
    ["Start", esc(fmtDate(s.startTime))],
    ["End", s.endTime ? esc(fmtDate(s.endTime)) : NA],
    ["Duration", fmtDuration(s.durationMs)],
    ["Models", fmtModels(s.models)],
    ["Input / Output / Cached tokens", `${fmtInt(s.inputTokens)} / ${fmtInt(s.outputTokens)} / ${fmtInt(s.cachedTokens)}`],
    ["AI Credits", `<span class="${lv}">${fmtCredits(s.aiCredits)}</span>` + partialLabel(s)],
    ["Estimated cost", `<span class="${lv}">${fmtUsd(s.estimatedUsd)}</span>` + partialLabel(s)],
    ["Totals source", esc(s.totalsSource)],
    ["Ended", s.endReason ? esc(s.endReason) : NA],
  ].map(([k, v]) => `<div><span class="k">${k}</span>${v}</div>`).join("");

  const calls = s.calls?.length
    ? `<table><thead><tr><th>#</th><th>Time</th><th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Cache write</th><th class="num">AI Credits</th><th class="num">Cost</th><th class="num">Duration</th><th>Initiator</th></tr></thead><tbody>` +
      s.calls.map((c, i) => `<tr style="cursor:default"><td>${i + 1}</td><td>${esc(new Date(c.timestamp).toLocaleTimeString())}</td><td>${esc(c.model)}</td>
        <td class="num">${fmtInt(c.inputTokens)}</td><td class="num">${fmtInt(c.outputTokens)}</td><td class="num">${fmtInt(c.cacheReadTokens)}</td><td class="num">${fmtInt(c.cacheWriteTokens)}</td>
        <td class="num">${fmtCredits(c.aiCredits)}${partialLabel(c)}</td><td class="num">${fmtUsd(c.aiCredits === null ? null : c.aiCredits * cfg.usdPerCredit)}${partialLabel(c)}</td>
        <td class="num">${c.durationMs === null ? NA : c.durationMs + " ms"}</td><td>${c.initiator || c.interactionType ? esc(c.initiator || c.interactionType) : NA}</td></tr>`).join("") +
      "</tbody></table>"
    : '<p class="muted">No per-call usage records are available in the local telemetry for this session.</p>';

  const warnings = (s.telemetryWarnings || []).map((w) => `<p class="error">${esc(w)}</p>`).join("");
  const unavailable = s.aiCredits === null
    ? '<p class="muted">AI Credits and USD cost: Not available. No usable AI-credit amount was reported by the SDK; token prices and premium request multipliers are not substituted.</p>' : "";
  $("detailBody").innerHTML = `<div class="detail-meta">${meta}</div>${warnings}${unavailable}<h3>Model / API calls</h3><div class="table-scroll" role="region" aria-label="API call usage" tabindex="0">${calls}</div>`;
  $("detailIndicator").textContent = s.storage === "live" ? "LIVE" : "SAVED";
  $("detailIndicator").className = `chip ${s.storage === "live" ? "live" : "persisted"}`;
  $("detailPanel").hidden = false;
}

async function loadDetail(id) {
  const request = ++detailRequest;
  const s = await api("/api/sessions/" + encodeURIComponent(id));
  if (selectedId === id && request === detailRequest) {
    selectedStorage = s.storage;
    renderDetail(s);
  }
}

async function showDetail(id) {
  selectedId = id;
  selectedStorage = sessions.find((session) => session.id === id)?.storage ?? null;
  renderTable();
  await loadDetail(id);
  if (selectedId === id) $("detailPanel").scrollIntoView({ behavior: "smooth" });
}

// ---- wiring ----
$("rows").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-session-id]");
  const tr = e.target.closest("tr[data-id]");
  const id = button?.dataset.sessionId ?? tr?.dataset.id;
  if (id) showDetail(id).catch(showPageError);
});
function closeDetail() {
  $("detailPanel").hidden = true;
  selectedId = null;
  selectedStorage = null;
  detailRequest++;
}
$("closeDetail").onclick = () => {
  closeDetail();
  renderTable();
};
$("fDate").value = localDay(new Date());
$("fDate").addEventListener("change", () => {
  if (!$("fDate").value) $("fDate").value = localDay(new Date());
  closeDetail();
  refreshModelFilter();
  renderTable();
});
["fModel", "fSession"].forEach((id) => $(id).addEventListener("input", renderTable));
$("fClear").onclick = () => {
  $("fModel").value = "";
  $("fSession").value = "";
  renderTable();
};

(async function init() {
  cfg = await api("/api/config");
  $("budgetInfo").textContent = `Session budget: ${cfg.sessionCreditBudget} AI Credits = ${fmtUsd(cfg.sessionCreditBudget * cfg.usdPerCredit).replace(/<[^>]+>/g, "")} (amber at ${Math.round(cfg.warnRatio * 100)}%, red when exceeded).`;
  await refreshState();
  connectEvents();
})().catch(showPageError);

window.addEventListener("focus", () => { refreshState().catch(showPageError); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshState().catch(showPageError);
});
setInterval(() => { refreshState().catch(showPageError); }, 15000);
