import path from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number (got "${raw}")`);
  return v;
}

export const USD_PER_AI_CREDIT = 0.01; // 1 GitHub AI Credit = $0.01 USD

export const config = {
  port: num("PORT", 3000),
  host: "127.0.0.1",
  sessionCreditBudget: num("SESSION_CREDIT_BUDGET", 100),
  warnRatio: num("SESSION_CREDIT_WARN_RATIO", 0.8),
  dataFile: path.resolve(process.env.DATA_FILE || "./data/sessions.json"),
  nanoAiuPerCredit: num("NANO_AIU_PER_AI_CREDIT", 1_000_000_000),
  githubToken: process.env.COPILOT_GITHUB_TOKEN || undefined,
  defaultModel: process.env.DEFAULT_MODEL || undefined,
  approveAllTools: process.env.COPILOT_APPROVE_ALL_TOOLS === "true",
  usdPerCredit: USD_PER_AI_CREDIT,
};

if (!Number.isInteger(config.port) || config.port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
if (config.warnRatio > 1) throw new Error("SESSION_CREDIT_WARN_RATIO must be at most 1");

export type Config = typeof config;
