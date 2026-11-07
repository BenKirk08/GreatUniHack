import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkBasicAuth, checkToolSecret, isMachinePath, safeEqual } from "@/lib/auth";
import { signElevenLabsPayload, verifyElevenLabsSignature } from "@/lib/elevenlabs/webhook";
import { NextRequest } from "next/server";
import {
  checkCustomerCookie,
  checkLinkToken,
  CUSTOMER_COOKIE,
  customerCookieValue,
  isCustomerPath,
  isPublicAppFile,
  readCookie,
} from "@/lib/customer-auth";
import { recordDetailsSchema } from "@/lib/validation";

const SECRET = "wsec_test_0123456789abcdef";
const body = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv_1" } });

describe("ElevenLabs HMAC verification", () => {
  const now = Date.UTC(2026, 10, 5, 12, 0, 0);
  const t = Math.floor(now / 1000);

  it("accepts a correctly signed body", () => {
    const header = signElevenLabsPayload(body, SECRET, t);
    expect(header).toMatch(/^t=\d+,v0=[0-9a-f]{64}$/);
    expect(verifyElevenLabsSignature(body, header, SECRET, { nowMs: now })).toEqual({ ok: true });
  });

  it("matches the documented algorithm: HMAC-SHA256 over `${t}.${rawBody}`, hex, v0= prefix", async () => {
    const { createHmac } = await import("node:crypto");
    const hex = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
    expect(verifyElevenLabsSignature(body, `t=${t},v0=${hex}`, SECRET, { nowMs: now }).ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const header = signElevenLabsPayload(body, SECRET, t);
    expect(verifyElevenLabsSignature(body.replace("conv_1", "conv_2"), header, SECRET, { nowMs: now })).toEqual({
      ok: false,
      reason: "signature mismatch",
    });
  });

  it("rejects the wrong secret", () => {
    const header = signElevenLabsPayload(body, "another-secret", t);
    expect(verifyElevenLabsSignature(body, header, SECRET, { nowMs: now }).ok).toBe(false);
  });

  it("rejects stale and future timestamps", () => {
    const old = signElevenLabsPayload(body, SECRET, t - 61 * 60);
    expect(verifyElevenLabsSignature(body, old, SECRET, { nowMs: now })).toEqual({ ok: false, reason: "timestamp too old" });
    const future = signElevenLabsPayload(body, SECRET, t + 10 * 60);
    expect(verifyElevenLabsSignature(body, future, SECRET, { nowMs: now })).toEqual({ ok: false, reason: "timestamp in the future" });
    const withinTolerance = signElevenLabsPayload(body, SECRET, t - 40 * 60); // a late retry
    expect(verifyElevenLabsSignature(body, withinTolerance, SECRET, { nowMs: now }).ok).toBe(true);
  });

  it("rejects missing or malformed headers and a missing secret", () => {
    expect(verifyElevenLabsSignature(body, null, SECRET).ok).toBe(false);
    expect(verifyElevenLabsSignature(body, "garbage", SECRET).ok).toBe(false);
    expect(verifyElevenLabsSignature(body, `t=${t}`, SECRET, { nowMs: now }).ok).toBe(false);
    expect(verifyElevenLabsSignature(body, `t=abc,v0=00`, SECRET, { nowMs: now }).ok).toBe(false);
    expect(verifyElevenLabsSignature(body, signElevenLabsPayload(body, SECRET, t), undefined).ok).toBe(false);
  });

  it("tolerates whitespace and extra schemes in the header", () => {
    const header = signElevenLabsPayload(body, SECRET, t).replace(",", ", ") + ",v1=ignored";
    expect(verifyElevenLabsSignature(body, header, SECRET, { nowMs: now }).ok).toBe(true);
  });
});

describe("tool secret check", () => {
  it("accepts only the exact secret", () => {
    expect(checkToolSecret("s3cret-value-1234", "s3cret-value-1234")).toBe(true);
    expect(checkToolSecret(" s3cret-value-1234 ", "s3cret-value-1234")).toBe(true);
    expect(checkToolSecret("s3cret-value-1235", "s3cret-value-1234")).toBe(false);
    expect(checkToolSecret("s3cret", "s3cret-value-1234")).toBe(false);
    expect(checkToolSecret("", "s3cret-value-1234")).toBe(false);
    expect(checkToolSecret(null, "s3cret-value-1234")).toBe(false);
    expect(checkToolSecret("anything", "")).toBe(false);
    expect(checkToolSecret(undefined, undefined)).toBe(false);
  });

  it("compares in constant time regardless of length", () => {
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "aa")).toBe(false);
  });
});

describe("dashboard basic auth", () => {
  const header = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  it("checks the password and ignores the username", () => {
    expect(checkBasicAuth(header("analyst", "pw-123456"), "pw-123456")).toBe(true);
    expect(checkBasicAuth(header("", "pw-123456"), "pw-123456")).toBe(true);
    expect(checkBasicAuth(header("analyst", "pw:with:colons"), "pw:with:colons")).toBe(true);
    expect(checkBasicAuth(header("analyst", "wrong"), "pw-123456")).toBe(false);
    expect(checkBasicAuth("Bearer abc", "pw-123456")).toBe(false);
    expect(checkBasicAuth(null, "pw-123456")).toBe(false);
    expect(checkBasicAuth(header("a", "b"), undefined)).toBe(false);
  });
  it("exempts only the machine routes", () => {
    expect(isMachinePath("/api/tools/record-details")).toBe(true);
    expect(isMachinePath("/api/webhooks/elevenlabs")).toBe(true);
    expect(isMachinePath("/api/twilio/voice")).toBe(true);
    expect(isMachinePath("/api/twilio/transcription")).toBe(true);
    expect(isMachinePath("/api/twilio/dial-status")).toBe(true);
    expect(isMachinePath("/api/cron/voice-twin-purge")).toBe(true);
    expect(isMachinePath("/api/reports/x/send")).toBe(false);
    expect(isMachinePath("/api/toolsx")).toBe(false);
    expect(isMachinePath("/api/cronx")).toBe(false);
    expect(isMachinePath("/api/cron")).toBe(false);
    expect(isMachinePath("/api/protect/voice-twin")).toBe(false);
    expect(isMachinePath("/")).toBe(false);
  });

  it("keeps proxy.ts's matcher in step with isMachinePath (Vercel Cron and Twilio skip basic auth)", async () => {
    const { config } = await import("@/proxy");
    const [pattern] = config.matcher;
    const matches = (path: string) => new RegExp(`^${pattern}$`).test(path);
    for (const p of ["/api/cron/voice-twin-purge", "/api/twilio/dial-status", "/api/tools/record-details", "/api/webhooks/elevenlabs"]) {
      expect(matches(p)).toBe(false);
    }
    for (const p of ["/", "/api/calls/x/takeover", "/api/protect/voice-twin", "/protect"]) expect(matches(p)).toBe(true);
  });
});

describe("customer link and cookie", () => {
  const token = "tok_0123456789abcdef0123456789";
  it("accepts only the exact link token", () => {
    expect(checkLinkToken(token, token)).toBe(true);
    expect(checkLinkToken(`${token}x`, token)).toBe(false);
    expect(checkLinkToken("", token)).toBe(false);
    expect(checkLinkToken(token, "")).toBe(false);
  });
  it("derives the cookie from the token, never storing the token itself", () => {
    const cookie = customerCookieValue(token);
    expect(cookie).not.toContain(token);
    expect(checkCustomerCookie(cookie, token)).toBe(true);
    expect(checkCustomerCookie(cookie, `${token}-rotated`)).toBe(false);
    expect(checkCustomerCookie(token, token)).toBe(false);
    expect(checkCustomerCookie(undefined, token)).toBe(false);
  });
  it("covers /protect, /protect/* and /api/protect/* only", () => {
    for (const p of ["/protect", "/protect/x", "/protect/settings", "/api/protect/takeover", "/api/protect/subscribe", "/api/protect/test-alert"]) {
      expect(isCustomerPath(p)).toBe(true);
    }
    for (const p of ["/", "/protected", "/api/calls/x/takeover", "/api/twilio/voice", "/sw.js", "/manifest.webmanifest", "/sw.jsx"]) {
      expect(isCustomerPath(p)).toBe(false);
    }
  });
  it("makes only the manifest and the service worker script public, by exact path", () => {
    expect(isPublicAppFile("/manifest.webmanifest")).toBe(true);
    expect(isPublicAppFile("/sw.js")).toBe(true);
    for (const p of ["/sw.jsx", "/sw.js/x", "/protect/sw.js", "/manifest.webmanifest/x", "/manifest.json", "/protect", "/api/protect/state", "/"]) {
      expect(isPublicAppFile(p)).toBe(false);
    }
  });
  it("reads a cookie from a Cookie header", () => {
    expect(readCookie("a=1; northgate_guard=abc%3D; b=2", "northgate_guard")).toBe("abc=");
    expect(readCookie(null, "northgate_guard")).toBeUndefined();
  });
});

describe("proxy access decisions", () => {
  const token = "tok_0123456789abcdef0123456789";
  const password = "pw-123456";
  const saved = { token: process.env.CUSTOMER_LINK_TOKEN, password: process.env.DASHBOARD_PASSWORD };
  beforeAll(() => {
    process.env.CUSTOMER_LINK_TOKEN = token;
    process.env.DASHBOARD_PASSWORD = password;
  });
  afterAll(() => {
    for (const [key, value] of [["CUSTOMER_LINK_TOKEN", saved.token], ["DASHBOARD_PASSWORD", saved.password]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const run = async (path: string, headers: Record<string, string> = {}) => {
    const { proxy } = await import("@/proxy");
    return proxy(new NextRequest(`https://granny-agent.vercel.app${path}`, { headers }));
  };
  const passed = (res: Response) => res.headers.get("x-middleware-next") === "1";
  const withCookie = (value: string) => ({ cookie: `${CUSTOMER_COOKIE}=${value}` });
  const basic = (pass: string) => ({ authorization: `Basic ${Buffer.from(`a:${pass}`).toString("base64")}` });

  it("serves the manifest and the service worker with no cookie and no password", async () => {
    for (const path of ["/manifest.webmanifest", "/sw.js"]) {
      const res = await run(path);
      expect(passed(res), path).toBe(true);
      expect(res.status).toBe(200);
    }
  });

  it("keeps /protect and /protect/* behind the customer cookie", async () => {
    for (const path of ["/protect", "/protect/settings"]) {
      const denied = await run(path);
      expect(passed(denied), path).toBe(false);
      expect(denied.status).toBe(401);
      expect(denied.headers.get("content-type")).toContain("text/html");
      expect(passed(await run(path, withCookie("forged")))).toBe(false);
      // The dashboard password is no way in either.
      expect(passed(await run(path, basic(password)))).toBe(false);
      expect(passed(await run(path, withCookie(customerCookieValue(token))))).toBe(true);
    }
  });

  it("keeps every /api/protect/* route behind the customer cookie, test-alert included", async () => {
    for (const path of ["/api/protect/state", "/api/protect/subscribe", "/api/protect/takeover", "/api/protect/test-alert", "/api/protect/voice-twin"]) {
      const denied = await run(path);
      expect(passed(denied), path).toBe(false);
      expect(denied.status).toBe(401);
      expect(await denied.json()).toMatchObject({ ok: false });
      expect(passed(await run(path, withCookie("forged")))).toBe(false);
      expect(passed(await run(path, withCookie(customerCookieValue(token))))).toBe(true);
    }
  });

  it("still signs the customer in from their link, and only with the right token", async () => {
    const res = await run(`/protect?k=${token}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://granny-agent.vercel.app/protect");
    expect(res.cookies.get(CUSTOMER_COOKIE)?.value).toBe(customerCookieValue(token));
    expect((await run(`/protect?k=${token}x`)).status).toBe(401);
  });

  it("keeps lookalike paths and everything else behind the dashboard password (the customer cookie doesn't open them)", async () => {
    for (const path of ["/", "/sw.jsx", "/sw.js/x", "/manifest.webmanifest/x", "/manifest.json", "/api/calls/x/takeover"]) {
      for (const headers of [{}, withCookie(customerCookieValue(token))]) {
        const denied = await run(path, headers);
        expect(passed(denied), path).toBe(false);
        expect(denied.status).toBe(401);
        expect(denied.headers.get("www-authenticate")).toContain("Basic");
      }
      expect(passed(await run(path, basic(password))), path).toBe(true);
    }
    // Under /protect a lookalike is still a customer page.
    expect((await run("/protect/sw.js")).status).toBe(401);
  });
});

describe("record_details body validation", () => {
  it("accepts the tool payload, with nulls and numbers for optional fields", () => {
    const parsed = recordDetailsSchema.parse({
      conversation_id: "conv_123",
      caller_id: null,
      conversation_history: '{"x-elevenlabs-history":true,"entries":[]}',
      payee_name: "Daniel Price",
      amount: 4800,
      sort_code: null,
      unexpected: "dropped",
    });
    expect(parsed.amount).toBe("4800");
    expect(parsed.sort_code).toBeUndefined();
    expect("unexpected" in parsed).toBe(false);
  });
  it("requires a conversation id", () => {
    expect(recordDetailsSchema.safeParse({ payee_name: "x" }).success).toBe(false);
    expect(recordDetailsSchema.safeParse({ conversation_id: "" }).success).toBe(false);
  });
});

describe("dashboard action route guard (CSRF)", () => {
  const ok = () => `Basic ${Buffer.from("a:pw-123456").toString("base64")}`;
  const make = (headers: Record<string, string>) =>
    new Request("https://granny-agent.vercel.app/api/settings/auto-send", { method: "POST", headers: { host: "granny-agent.vercel.app", ...headers } });

  it("detects cross-site requests by Sec-Fetch-Site and Origin", async () => {
    const { isCrossSiteRequest } = await import("@/lib/http");
    expect(isCrossSiteRequest(make({ "sec-fetch-site": "same-origin", origin: "https://granny-agent.vercel.app" }))).toBe(false);
    expect(isCrossSiteRequest(make({}))).toBe(false); // scripts / curl
    expect(isCrossSiteRequest(make({ "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isCrossSiteRequest(make({ origin: "https://evil.example" }))).toBe(true);
    expect(isCrossSiteRequest(make({ origin: "null" }))).toBe(true);
  });

  it("requires auth, same origin and a JSON body", async () => {
    process.env.DASHBOARD_PASSWORD = "pw-123456";
    const { resetEnvCache } = await import("@/lib/env");
    const { requireDashboardAuth } = await import("@/lib/http");
    const prev = { ...process.env };
    // Minimal valid env for serverEnv(); restored afterwards.
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "x", ANTHROPIC_MODEL: "x", ANTHROPIC_FAST_MODEL: "x", ELEVENLABS_API_KEY: "x",
      TWILIO_AUTH_TOKEN: "x",
      CUSTOMER_PHONE_NUMBER: "+447700900999", CUSTOMER_FIRST_NAME: "Ben", CUSTOMER_LINK_TOKEN: "0123456789abcdef01234567",
      NEXT_PUBLIC_VAPID_PUBLIC_KEY: "x", VAPID_PRIVATE_KEY: "x", RISK_THRESHOLD: "",
      TWILIO_ACCOUNT_SID: "x", TWILIO_API_KEY_SID: "x", TWILIO_API_KEY_SECRET: "x",
      TWILIO_PHONE_NUMBER: "+14155550100", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "x",
      SUPABASE_SERVICE_ROLE_KEY: "x", RESEND_API_KEY: "x", REPORT_FROM_EMAIL: "a@b.co", REPORT_TO_EMAIL: "a@b.co",
      TOOL_SECRET: "0123456789abcdef0123", DASHBOARD_PASSWORD: "pw-123456", PUBLIC_BASE_URL: "",
    });
    resetEnvCache();
    try {
      expect(requireDashboardAuth(make({ "content-type": "application/json" }))?.status).toBe(401);
      expect(requireDashboardAuth(make({ authorization: ok(), "content-type": "text/plain" }))?.status).toBe(415);
      expect(requireDashboardAuth(make({ authorization: ok(), "content-type": "application/json", origin: "https://evil.example" }))?.status).toBe(403);
      expect(requireDashboardAuth(make({ authorization: ok(), "content-type": "application/json; charset=utf-8" }))).toBeNull();
    } finally {
      process.env = prev;
      resetEnvCache();
    }
  });
});
