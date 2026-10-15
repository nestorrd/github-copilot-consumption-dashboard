import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { ExternalSessionMonitor } from "./external-monitor.js";
import { buildDashboardState } from "./state.js";
import { JsonStore } from "./store.js";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const store = new JsonStore(config.dataFile);
await store.load();
const externalMonitor = new ExternalSessionMonitor(config.copilotSessionStateDir);
await externalMonitor.start();
const sseClients = new Set<http.ServerResponse>();

function dashboardState() {
  return {
    ...buildDashboardState(store.list(), null, externalMonitor.list()),
    sourceError: externalMonitor.error(),
  };
}

externalMonitor.onChange(() => {
  const frame = `event: state\ndata: ${JSON.stringify(dashboardState())}\n\n`;
  for (const res of sseClients) res.write(frame);
});

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

// Local-only guard against DNS rebinding and cross-site requests.
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
  if (method === "GET" && pathname === "/api/state") return send(res, 200, dashboardState());
  if (method === "GET" && pathname === "/api/sessions") return send(res, 200, dashboardState().sessions);

  const detail = pathname.match(/^\/api\/sessions\/([\w.-]+)$/);
  if (method === "GET" && detail) {
    const s = store.get(detail[1]);
    const external = externalMonitor.get(detail[1]);
    if (external) return send(res, 200, external);
    return s
      ? send(res, 200, { ...s, status: "completed", storage: "saved", callCount: s.calls.length, lastError: null })
      : send(res, 404, { error: "Session not found" });
  }

  if (method === "GET" && pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`event: state\ndata: ${JSON.stringify(dashboardState())}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
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
  externalMonitor.stop();
  for (const res of sseClients) res.end();
  server.close();
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
