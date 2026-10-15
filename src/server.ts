import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { JsonStore } from "./store.js";
import { SessionTracker } from "./tracker.js";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const store = new JsonStore(config.dataFile);
await store.load();
const tracker = new SessionTracker(store);
const sseClients = new Set<http.ServerResponse>();

tracker.onChange((snap) => {
  const frame = `event: live\ndata: ${JSON.stringify(snap)}\n\n`;
  for (const res of sseClients) res.write(frame);
});

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

// Local-only guard against DNS rebinding and cross-site requests (the app can start billable sessions).
function isAllowedRequest(req: http.IncomingMessage): boolean {
  const ok = (h: string) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h);
  if (!ok(req.headers.host ?? "")) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      return ok(new URL(origin).host);
    } catch {
      return false;
    }
  }
  return true;
}

function publicConfig() {
  return {
    sessionCreditBudget: config.sessionCreditBudget,
    warnRatio: config.warnRatio,
    usdPerCredit: config.usdPerCredit,
    nanoAiuPerCredit: config.nanoAiuPerCredit,
    approveAllTools: config.approveAllTools,
    defaultModel: config.defaultModel ?? null,
  };
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/api/config") return send(res, 200, publicConfig());
  if (method === "GET" && pathname === "/api/live") return send(res, 200, tracker.snapshot());
  if (method === "GET" && pathname === "/api/sessions") return send(res, 200, store.list().map(({ calls, ...s }) => ({ ...s, callCount: calls.length })));
  if (method === "GET" && pathname === "/api/models") return send(res, 200, await tracker.listModels());

  const detail = pathname.match(/^\/api\/sessions\/([\w.-]+)$/);
  if (method === "GET" && detail) {
    const s = store.get(detail[1]);
    return s ? send(res, 200, s) : send(res, 404, { error: "Session not found" });
  }

  if (method === "GET" && pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`event: live\ndata: ${JSON.stringify(tracker.snapshot())}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (method === "POST" && pathname === "/api/session/start") {
    const body = await readJson(req);
    const model = typeof body.model === "string" && body.model ? body.model : undefined;
    return send(res, 200, await tracker.start(model));
  }
  if (method === "POST" && pathname === "/api/session/prompt") {
    const body = await readJson(req);
    if (typeof body.prompt !== "string" || !body.prompt.trim()) return send(res, 400, { error: "prompt is required" });
    tracker.prompt(body.prompt);
    return send(res, 202, { accepted: true });
  }
  if (method === "POST" && pathname === "/api/session/end") {
    const { calls, ...summary } = await tracker.end("user");
    return send(res, 200, { ...summary, callCount: calls.length });
  }
  send(res, 404, { error: "Not found" });
}

async function handleStatic(res: http.ServerResponse, pathname: string): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep)) return send(res, 403, { error: "Forbidden" });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    send(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!isAllowedRequest(req)) return send(res, 403, { error: "Forbidden origin" });
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else await handleStatic(res, url.pathname);
  } catch (e) {
    console.error("Request failed:", e);
    if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Copilot Session Cost Dashboard: http://${config.host}:${config.port}`);
});

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  let code = 0;
  try {
    await tracker.shutdown();
  } catch (error) {
    console.error("Shutdown failed; the active session may not have been saved:", error);
    code = 1;
  }
  for (const res of sseClients) res.end();
  server.close(() => { process.exitCode = code; });
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
