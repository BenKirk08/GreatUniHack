import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Values Vercel stores as "sensitive" (write-only: never readable again from the dashboard or API). */
export const SENSITIVE_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_WEBHOOK_SECRET",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_AUTH_TOKEN",
  "CUSTOMER_PHONE_NUMBER",
  "CUSTOMER_LINK_TOKEN",
  "VAPID_PRIVATE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "VERCEL_TOKEN",
  "RESEND_API_KEY",
  "TOOL_SECRET",
  "DASHBOARD_PASSWORD",
  "NGROK_AUTHTOKEN",
]);

/** Keys from .env.example — the only ones synced to Vercel (VERCEL_OIDC_TOKEN etc. are local-only). */
export function projectEnvKeys(root = process.cwd()): string[] {
  return readFileSync(path.join(root, ".env.example"), "utf8")
    .split("\n")
    .map((l) => l.split("=")[0].trim())
    .filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k));
}

export function linkedProject(root = process.cwd()): { projectId: string; orgId: string; projectName?: string } {
  const file = path.join(root, ".vercel", "project.json");
  if (!existsSync(file)) throw new Error("Not linked to Vercel yet: run `vercel link` first.");
  return JSON.parse(readFileSync(file, "utf8"));
}

async function vercelApi<T>(token: string, method: string, apiPath: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.vercel.com${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vercel ${method} ${apiPath.split("?")[0]} → ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Create or overwrite env vars on the linked project (production + preview). Never logs values. */
export async function upsertVercelEnv(vars: Record<string, string>, opts: { token: string; root?: string }) {
  const { projectId, orgId } = linkedProject(opts.root);
  const entries = Object.entries(vars).filter(([, v]) => v !== "");
  if (entries.length === 0) return [];
  const body = entries.map(([key, value]) => ({
    key,
    value,
    type: SENSITIVE_KEYS.has(key) ? "sensitive" : "encrypted",
    target: ["production", "preview"],
  }));
  await vercelApi(opts.token, "POST", `/v10/projects/${projectId}/env?upsert=true&teamId=${orgId}`, body);
  return entries.map(([k]) => k);
}

export async function getVercelProject(token: string, root?: string) {
  const { projectId, orgId } = linkedProject(root);
  return vercelApi<{
    name: string;
    ssoProtection: unknown;
    passwordProtection: unknown;
    targets?: { production?: { alias?: string[]; url?: string } };
    alias?: { domain: string }[];
  }>(token, "GET", `/v9/projects/${projectId}?teamId=${orgId}`);
}

/** Set (or add) KEY=value in .env.local without touching other lines. */
export function writeLocalEnv(key: string, value: string, root = process.cwd()) {
  const file = path.join(root, ".env.local");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.splice(lines[lines.length - 1] === "" ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
  writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  process.env[key] = value;
}
