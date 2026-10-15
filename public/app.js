"use strict";

const $ = (id) => document.getElementById(id);
const NA = '<span class="na">Not available</span>';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let cfg = { sessionCreditBudget: 100, warnRatio: 0.8, usdPerCredit: 0.01 };
let sessions = [];
let live = null;
let selectedId = null;

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
const colorVar = { ok: "var(--green)", warn: "var(--amber)", over: "var(--red)", "": "var(--muted)" };

async function api(path, opts) {
  const res = await fetch(path, opts && { ...opts, headers: { "Content-Type": "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });

// ---- live session ----
function renderLive() {
  const active = !!live;
  $("liveIdle").hidden = active;
  $("liveActive").hidden = !active;
  $("liveStatus").textContent = active ? (live.ending ? "Ending and saving..." : live.busy ? "Processing prompt..." : "Idle, waiting for a prompt") : "";
  if (!active) return;
  $("liveId").textContent = live.id;
  $("liveModel").innerHTML = live.models.length ? fmtModels(live.models) : esc(live.requestedModel || "Default (no calls yet)");
  $("liveTokens").innerHTML = `${fmtInt(live.inputTokens)} / ${fmtInt(live.outputTokens)} / ${fmtInt(live.cachedTokens)}`;
  $("liveCalls").textContent = live.callCount;
  $("liveContext").innerHTML = live.context
    ? `${live.context.currentTokens.toLocaleString()} / ${live.context.tokenLimit.toLocaleString()} tokens`
    : NA;
  const lv = level(live.aiCredits);
  $("liveCredits").innerHTML = fmtCredits(live.aiCredits) + partialLabel(live);
  $("liveCredits").className = "big " + lv;
  $("liveCost").innerHTML = fmtUsd(live.estimatedUsd) + partialLabel(live);
  $("liveCost").className = "big " + lv;
  const pct = live.aiCredits === null ? 0 : Math.min(100, (live.aiCredits / cfg.sessionCreditBudget) * 100);
  $("liveBar").style.width = pct + "%";
  $("liveBar").style.background = colorVar[lv];
  $("liveBarLabel").textContent = live.aiCredits === null
    ? "AI Credits not reported by the SDK for this session yet."
    : `${pct.toFixed(0)}% of the ${cfg.sessionCreditBudget} AI Credit session budget` +
      (lv === "over" ? " - BUDGET EXCEEDED" : lv === "warn" ? " - approaching budget" : "") +
      ` (source: ${live.metricsSource})`;
  $("liveError").textContent = [live.lastError, ...(live.telemetryWarnings || [])].filter(Boolean).join("\n");
  $("sendBtn").disabled = live.busy || live.ending;
  $("endBtn").disabled = live.ending;
  tickElapsed();
}
function tickElapsed() {
  if (live) $("liveElapsed").textContent = fmtDuration(Date.now() - new Date(live.startTime).getTime());
}
setInterval(tickElapsed, 1000);

function connectEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("live", (e) => {
    $("connectionStatus").textContent = "";
    const wasLive = !!live;
    live = JSON.parse(e.data);
    renderLive();
    if (wasLive && !live) loadSessions().catch(showPageError);
  });
  es.onerror = () => { $("connectionStatus").textContent = "Live connection lost; displayed telemetry may be stale. Reconnecting..."; };
  es.onopen = () => { loadSessions().catch(showPageError); };
}
function showPageError(error) { $("connectionStatus").textContent = error.message; }

// ---- history ----
function filtered() {
  const d = $("fDate").value, m = $("fModel").value, q = $("fSession").value.trim().toLowerCase();
  return sessions.filter((s) => {
    if (d) {
      const local = new Date(s.startTime);
      const key = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
      if (key !== d) return false;
    }
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
    card("Total sessions", rows.length, '<div class="note">persisted' + (rows.length !== sessions.length ? " (filtered)" : "") + "</div>") +
    card("Total input tokens", fmtInt(inp.total), note(inp)) +
    card("Total output tokens", fmtInt(out.total), note(out));
}

function renderTable() {
  const rows = filtered();
  renderCards(rows);
  $("emptyMsg").hidden = rows.length > 0;
  $("rows").innerHTML = rows.map((s) => {
    const lv = level(s.aiCredits);
    return `<tr data-id="${esc(s.id)}" class="${s.id === selectedId ? "selected" : ""}">
      <td class="mono" title="${esc(s.id)}">${esc(s.id.slice(0, 8))}</td>
      <td>${esc(fmtDate(s.startTime))}</td>
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
  sessions = await api("/api/sessions");
  refreshModelFilter();
  renderTable();
}

// ---- details ----
async function showDetail(id) {
  selectedId = id;
  renderTable();
  const s = await api("/api/sessions/" + encodeURIComponent(id));
  const lv = level(s.aiCredits);
  const meta = [
    ["Session ID", `<span class="mono">${esc(s.id)}</span>`],
    ["Start", esc(fmtDate(s.startTime))], ["End", esc(fmtDate(s.endTime))], ["Duration", fmtDuration(s.durationMs)],
    ["Models", fmtModels(s.models)],
    ["Input / Output / Cached tokens", `${fmtInt(s.inputTokens)} / ${fmtInt(s.outputTokens)} / ${fmtInt(s.cachedTokens)}`],
    ["AI Credits", `<span class="${lv}">${fmtCredits(s.aiCredits)}</span>` + partialLabel(s)],
    ["Estimated cost", `<span class="${lv}">${fmtUsd(s.estimatedUsd)}</span>` + partialLabel(s)],
    ["Totals source", esc(s.totalsSource)], ["Ended", esc(s.endReason)],
  ].map(([k, v]) => `<div><span class="k">${k}</span>${v}</div>`).join("");

  const calls = s.calls.length
    ? `<table><thead><tr><th>#</th><th>Time</th><th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Cache write</th><th class="num">AI Credits</th><th class="num">Cost</th><th class="num">Duration</th><th>Initiator</th></tr></thead><tbody>` +
      s.calls.map((c, i) => `<tr style="cursor:default"><td>${i + 1}</td><td>${esc(new Date(c.timestamp).toLocaleTimeString())}</td><td>${esc(c.model)}</td>
        <td class="num">${fmtInt(c.inputTokens)}</td><td class="num">${fmtInt(c.outputTokens)}</td><td class="num">${fmtInt(c.cacheReadTokens)}</td><td class="num">${fmtInt(c.cacheWriteTokens)}</td>
        <td class="num">${fmtCredits(c.aiCredits)}${partialLabel(c)}</td><td class="num">${fmtUsd(c.aiCredits === null ? null : c.aiCredits * cfg.usdPerCredit)}${partialLabel(c)}</td>
        <td class="num">${c.durationMs === null ? NA : c.durationMs + " ms"}</td><td>${c.initiator || c.interactionType ? esc(c.initiator || c.interactionType) : NA}</td></tr>`).join("") +
      "</tbody></table>"
    : '<p class="muted">No assistant.usage events were captured for this session (the event is ephemeral and is only available while the app is running the session).</p>';

  const warnings = (s.telemetryWarnings || []).map((w) => `<p class="error">${esc(w)}</p>`).join("");
  const unavailable = s.aiCredits === null
    ? '<p class="muted">AI Credits and USD cost: Not available. No usable AI-credit amount was reported by the SDK; token prices and premium request multipliers are not substituted.</p>' : "";
  $("detailBody").innerHTML = `<div class="detail-meta">${meta}</div>${warnings}${unavailable}<h3>Model / API calls (assistant.usage)</h3>${calls}`;
  $("detailPanel").hidden = false;
  $("detailPanel").scrollIntoView({ behavior: "smooth" });
}

// ---- wiring ----
$("rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (tr) showDetail(tr.dataset.id).catch((err) => alert(err.message));
});
$("closeDetail").onclick = () => { $("detailPanel").hidden = true; selectedId = null; renderTable(); };
["fDate", "fModel", "fSession"].forEach((id) => $(id).addEventListener("input", renderTable));
$("fClear").onclick = () => { $("fDate").value = ""; $("fModel").value = ""; $("fSession").value = ""; renderTable(); };

$("startBtn").onclick = async () => {
  $("startError").textContent = "";
  $("startBtn").disabled = true;
  try { live = await post("/api/session/start", { model: $("modelSelect").value }); renderLive(); }
  catch (e) { $("startError").textContent = e.message; }
  finally { $("startBtn").disabled = false; }
};
async function sendPrompt() {
  const text = $("promptInput").value.trim();
  if (!text) return;
  try { await post("/api/session/prompt", { prompt: text }); $("promptInput").value = ""; }
  catch (e) { $("liveError").textContent = e.message; }
}
$("sendBtn").onclick = sendPrompt;
$("promptInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendPrompt(); });
$("endBtn").onclick = async () => {
  try { await post("/api/session/end"); await loadSessions(); }
  catch (e) { $("liveError").textContent = e.message; }
};

async function loadModels() {
  try {
    const models = await api("/api/models"); // models.list
    $("modelSelect").innerHTML = '<option value="">Default model</option>' +
      models.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} (${esc(m.id)})</option>`).join("");
  } catch (e) {
    $("startError").textContent = "Could not list models: " + e.message;
  }
}

(async function init() {
  cfg = await api("/api/config");
  $("budgetInfo").textContent = `Session budget: ${cfg.sessionCreditBudget} AI Credits = ${fmtUsd(cfg.sessionCreditBudget * cfg.usdPerCredit).replace(/<[^>]+>/g, "")} (amber at ${Math.round(cfg.warnRatio * 100)}%, red when exceeded).`;
  await loadSessions();
  connectEvents();
  loadModels();
})().catch(showPageError);
