import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time string comparison (hashing first so differing lengths don't leak timing). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** The `x-tool-secret` check for ElevenLabs webhook tool calls. */
export function checkToolSecret(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false;
  return safeEqual(provided.trim(), expected);
}

/** HTTP Basic auth: any username, password must equal DASHBOARD_PASSWORD. */
export function checkBasicAuth(authorization: string | null | undefined, password: string | null | undefined): boolean {
  if (!authorization || !password) return false;
  const match = authorization.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!match) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  return safeEqual(decoded.slice(colon + 1), password);
}

export const BASIC_AUTH_REALM = 'Basic realm="Northgate Fraud Operations", charset="UTF-8"';

/**
 * Paths that bypass dashboard auth because they carry their own checks (tool secret / HMAC / Twilio signature /
 * CRON_SECRET bearer token for Vercel Cron).
 */
export function isMachinePath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/tools/") ||
    pathname.startsWith("/api/webhooks/") ||
    pathname.startsWith("/api/twilio/") ||
    pathname.startsWith("/api/cron/")
  );
}
