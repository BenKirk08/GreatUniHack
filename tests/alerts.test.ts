import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebPushError } from "web-push";
import {
  ALERT_TIMEOUTS_MS,
  ALERTS_TEXT,
  alertsErrorText,
  alertsView,
  enableAlerts,
  isIos,
  pushSupport,
  settleWithin,
  StepTimeout,
  withTimeout,
  type AlertsBusy,
  type AlertsError,
  type AlertsViewInput,
  type EnableAlertsSteps,
  type PushState,
} from "@/components/protect/protect-app";
import { CUSTOMER_COOKIE, customerCookieValue } from "@/lib/customer-auth";
import { resetEnvCache } from "@/lib/env";
import { testAlertSchema, testPayload } from "@/lib/push";

/* ---------- fakes: the push_subscriptions table and the web-push library ---------- */

interface SubRow {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const fake = vi.hoisted(() => ({
  rows: [] as SubRow[],
  updated: [] as { id: string; patch: Record<string, unknown> }[],
  deleted: [] as string[],
  readError: null as string | null,
  sent: [] as { endpoint: string; keys: unknown; payload: Record<string, unknown>; options: Record<string, unknown> }[],
  pushFailure: null as Error | null,
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== "push_subscriptions") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (column: "endpoint", value: string) => ({
            maybeSingle: async () =>
              fake.readError
                ? { data: null, error: { message: fake.readError } }
                : { data: fake.rows.find((row) => row[column] === value) ?? null, error: null },
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: async (_column: "id", id: string) => {
            fake.updated.push({ id, patch });
            return { error: null };
          },
        }),
        delete: () => ({
          eq: async (_column: "id", id: string) => {
            fake.deleted.push(id);
            fake.rows = fake.rows.filter((row) => row.id !== id);
            return { error: null };
          },
        }),
      };
    },
  }),
}));

vi.mock("web-push", () => {
  class FakeWebPushError extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
      readonly headers: Record<string, string>,
      readonly body: string,
      readonly endpoint: string,
    ) {
      super(message);
    }
  }
  return {
    WebPushError: FakeWebPushError,
    default: {
      setVapidDetails: () => undefined,
      sendNotification: async (sub: { endpoint: string; keys: unknown }, payload: string, options: Record<string, unknown>) => {
        if (fake.pushFailure) throw fake.pushFailure;
        fake.sent.push({ endpoint: sub.endpoint, keys: sub.keys, payload: JSON.parse(payload) as Record<string, unknown>, options });
        return { statusCode: 201, body: "", headers: {} };
      },
    },
  };
});

const pushError = (statusCode: number) => new WebPushError("push service said no", statusCode, {} as never, "", "https://fcm.googleapis.com/fcm/send/x");

/* ---------- which browsers can get notifications ---------- */

describe("push support", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
  const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

  it("recognises iPhone, and iPad even when it says Macintosh", () => {
    expect(isIos(IPHONE, 5)).toBe(true);
    expect(isIos(MAC, 5)).toBe(true); // iPadOS Safari
    expect(isIos(MAC, 0)).toBe(false); // a real Mac
    expect(isIos(ANDROID, 5)).toBe(false);
  });

  it("asks iPhone Safari users to add the Home Screen app, and calls other browsers without push unsupported", () => {
    const none = { serviceWorker: true, pushManager: false, notification: false };
    expect(pushSupport({ ...none, ios: true, standalone: false })).toBe("needs-install");
    expect(pushSupport({ ...none, ios: true, standalone: true })).toBe("unsupported"); // an iOS too old for web push
    expect(pushSupport({ ...none, ios: false, standalone: false })).toBe("unsupported");
    expect(pushSupport({ serviceWorker: true, pushManager: true, notification: true, ios: true, standalone: true })).toBe("supported");
    expect(pushSupport({ serviceWorker: false, pushManager: true, notification: true, ios: false, standalone: false })).toBe("unsupported");
  });
});

/* ---------- timeouts ---------- */

describe("timeouts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("passes a value or an error through, and rejects with StepTimeout when there's no answer", async () => {
    await expect(withTimeout(Promise.resolve(1), 100)).resolves.toBe(1);
    await expect(withTimeout(Promise.reject(new Error("no")), 100)).rejects.toThrow("no");
    const slow = withTimeout(new Promise(() => undefined), 1_500);
    const caught = slow.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await caught).toBeInstanceOf(StepTimeout);
  });

  it("settles to the fallback on a timeout or a failure, never rejecting", async () => {
    const stalled = settleWithin(new Promise<boolean>(() => undefined), 1_500, false);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(stalled).resolves.toBe(false);
    await expect(settleWithin(Promise.reject(new Error("no")), 1_500, false)).resolves.toBe(false);
    await expect(settleWithin(Promise.resolve(true), 1_500, false)).resolves.toBe(true);
  });
});

/* ---------- "Turn on alerts": the steps, in order, each with a timeout ---------- */

interface FakeSub {
  endpoint: string;
}

function steps(overrides: Partial<EnableAlertsSteps<string, FakeSub>> = {}) {
  const calls: string[] = [];
  const all: EnableAlertsSteps<string, FakeSub> = {
    permission: Promise.resolve("granted"),
    serviceWorker: async () => {
      calls.push("service-worker");
      return "registration";
    },
    subscribe: async (reg) => {
      calls.push(`subscribe:${reg}`);
      return { endpoint: "https://web.push.apple.com/abc" };
    },
    save: async (sub) => {
      calls.push(`save:${sub.endpoint}`);
      return { ok: true };
    },
    ...overrides,
  };
  return { all, calls };
}

const never = <T,>() => new Promise<T>(() => undefined);

describe("enableAlerts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Run the flow, advancing fake time by `ms`, and report whether it had finished just before then. */
  async function runFor(input: EnableAlertsSteps<string, FakeSub>, ms: number) {
    let done = false;
    const result = enableAlerts(input).finally(() => (done = true));
    await vi.advanceTimersByTimeAsync(ms - 1);
    const finishedEarly = done;
    await vi.advanceTimersByTimeAsync(1);
    return { finishedEarly, result: await result };
  }

  it("asks permission, then starts the service worker, subscribes and saves", async () => {
    const { all, calls } = steps();
    await expect(enableAlerts(all)).resolves.toEqual({ state: "on", endpoint: "https://web.push.apple.com/abc" });
    expect(calls).toEqual(["service-worker", "subscribe:registration", "save:https://web.push.apple.com/abc"]);
  });

  it("does nothing else until permission is granted", async () => {
    const { all, calls } = steps({ permission: never() });
    void enableAlerts(all);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toEqual([]);
  });

  it("reports a refusal as denied, and a closed question as not allowed", async () => {
    const denied = steps({ permission: Promise.resolve("denied") });
    await expect(enableAlerts(denied.all)).resolves.toEqual({ state: "denied" });
    expect(denied.calls).toEqual([]);
    const closed = steps({ permission: Promise.resolve("default") });
    await expect(enableAlerts(closed.all)).resolves.toEqual({ state: "error", error: { step: "permission", reason: "dismissed" } });
  });

  it("waits up to 60 s for the customer to answer the permission question", async () => {
    const { all } = steps({ permission: never() });
    const { finishedEarly, result } = await runFor(all, ALERT_TIMEOUTS_MS.permission);
    expect(ALERT_TIMEOUTS_MS.permission).toBe(60_000);
    expect(finishedEarly).toBe(false);
    expect(result).toEqual({ state: "error", error: { step: "permission", reason: "timed-out" } });
  });

  it("gives up on a service worker that doesn't start within 10 s", async () => {
    const { all } = steps({ serviceWorker: () => never() });
    const { finishedEarly, result } = await runFor(all, 10_000);
    expect(finishedEarly).toBe(false);
    expect(result).toEqual({ state: "error", error: { step: "service-worker", reason: "timed-out" } });
  });

  it("gives up on a subscription that takes more than 20 s, and reports one that fails", async () => {
    const slow = await runFor(steps({ subscribe: () => never() }).all, 20_000);
    expect(slow.finishedEarly).toBe(false);
    expect(slow.result).toEqual({ state: "error", error: { step: "subscribe", reason: "timed-out" } });
    const broken = steps({
      subscribe: async () => {
        throw new DOMException("Registration failed - push service error", "AbortError");
      },
    });
    await expect(enableAlerts(broken.all)).resolves.toEqual({ state: "error", error: { step: "subscribe", reason: "failed" } });
  });

  it("gives up on saving after 15 s, and passes on the server's own reason", async () => {
    const slow = await runFor(steps({ save: () => never() }).all, 15_000);
    expect(slow.finishedEarly).toBe(false);
    expect(slow.result).toEqual({ state: "error", error: { step: "save", reason: "timed-out" } });
    const refused = steps({ save: async () => ({ ok: false, error: "Open your Call Guard link again to sign in." }) });
    await expect(enableAlerts(refused.all)).resolves.toEqual({
      state: "error",
      error: { step: "save", reason: "failed", detail: "Open your Call Guard link again to sign in." },
    });
  });

  it("catches a step that throws straight away", async () => {
    const { all } = steps({
      serviceWorker: () => {
        throw new TypeError("navigator.serviceWorker is undefined");
      },
    });
    await expect(enableAlerts(all)).resolves.toEqual({ state: "error", error: { step: "service-worker", reason: "failed" } });
  });
});

/* ---------- what the alerts card says ---------- */

const view = (input: Partial<AlertsViewInput>) =>
  alertsView({ pushState: "off", soundArmed: false, busy: null, lastError: null, tapped: false, test: null, ...input });

describe("alertsView", () => {
  it("starts with Turn on alerts and an explanation", () => {
    for (const pushState of ["unknown", "off"] as const) {
      const v = view({ pushState });
      expect(v).toMatchObject({ label: "Turn on alerts", disabled: false, busy: false, on: false });
      expect(v.message).toEqual({ role: "status", tone: "info", text: ALERTS_TEXT.intro });
      expect(v.test.show).toBe(false);
    }
  });

  it("responds to the tap straight away: busy, disabled and saying what's happening", () => {
    for (const pushState of ["unknown", "off", "on", "needs-install", "denied", "error"] as const) {
      const v = view({ pushState, busy: "turning-on", tapped: true });
      expect(v).toMatchObject({ label: "Turning on alerts…", disabled: true, busy: true });
      expect(v.message).toEqual({ role: "status", tone: "info", text: "Turning on alerts… If your phone asks, tap Allow." });
      expect(v.test.show).toBe(false);
    }
  });

  it("says Alerts on and offers a test alert once notifications work", () => {
    const v = view({ pushState: "on", soundArmed: true, tapped: true });
    expect(v).toMatchObject({ label: "Alerts on", on: true, disabled: false });
    expect(v.message).toMatchObject({ role: "status", tone: "ok" });
    expect(v.message.text).toBe(`${ALERTS_TEXT.on} ${ALERTS_TEXT.soundArmed}`);
    expect(v.test).toMatchObject({ show: true, label: "Send a test alert", disabled: false, busy: false, message: null });
    // Sound couldn't be unlocked (e.g. a call holds the audio): notifications are still on.
    expect(view({ pushState: "on", soundArmed: false, tapped: true }).message.text).toBe(ALERTS_TEXT.on);
  });

  it("says notifications are already on after a reload, and how to arm sound too", () => {
    const v = view({ pushState: "on" });
    expect(v.label).toBe("Alerts on");
    expect(v.message.text).toBe(`${ALERTS_TEXT.onAlready} ${ALERTS_TEXT.armSoundToo}`);
  });

  it("gives iPhone Safari users the Home Screen steps, and says sound is armed after the tap", () => {
    const before = view({ pushState: "needs-install" });
    expect(before.label).toBe("Turn on alerts");
    expect(before.message.text).toBe(
      "On iPhone, notifications only work in the Call Guard Home Screen app: tap Share → Add to Home Screen, then open Call Guard from the new icon and tap Turn on alerts there.",
    );
    const after = view({ pushState: "needs-install", soundArmed: true, tapped: true });
    expect(after.label).toBe("Sound alerts on");
    expect(after.message).toMatchObject({ role: "status" });
    expect(after.message.text).toBe(`${ALERTS_TEXT.needsInstall} Sound and vibration are armed while this page is open.`);
    expect(after.test.show).toBe(false);
    // Even when sound couldn't be unlocked, the tap still says something new.
    const noSound = view({ pushState: "needs-install", tapped: true });
    expect(noSound.label).toBe("Turn on alerts");
    expect(noSound.message.text).toBe(`${ALERTS_TEXT.needsInstall} ${ALERTS_TEXT.pageAlerts}`);
  });

  it("says a browser without notifications still alerts while open", () => {
    const v = view({ pushState: "unsupported", soundArmed: true, tapped: true });
    expect(v.label).toBe("Sound alerts on");
    expect(v.message.text).toContain("This browser can't get notifications.");
    expect(v.message.text).toContain("it still alerts you while it's open");
    expect(v.message.text).toContain(ALERTS_TEXT.soundArmed);
  });

  it("explains how to allow notifications again when they're blocked", () => {
    const v = view({ pushState: "denied", soundArmed: true, tapped: true });
    expect(v).toMatchObject({ label: "Sound alerts on", disabled: false });
    expect(v.message).toMatchObject({ role: "alert", tone: "error" });
    expect(v.message.text).toContain("Settings → Notifications → Call Guard");
    expect(v.message.text).toContain("On Android or a computer, open this site's settings");
    expect(v.message.text).toContain(ALERTS_TEXT.soundArmed);
    // Known from the page load: shown, but not announced as an alert.
    expect(view({ pushState: "denied" }).message.role).toBe("status");
  });

  it("says which step failed, and to try again", () => {
    const lastError: AlertsError = { step: "subscribe", reason: "timed-out" };
    const v = view({ pushState: "error", lastError, tapped: true });
    expect(v).toMatchObject({ label: "Turn on alerts", disabled: false });
    expect(v.message).toEqual({
      role: "alert",
      tone: "error",
      text: "This phone's notification service took too long to answer. Tap Turn on alerts to try again. This page still alerts you while it's open.",
    });
    expect(view({ pushState: "error" }).message.text).toBe(`${ALERTS_TEXT.checkFailed} ${ALERTS_TEXT.tryAgain} ${ALERTS_TEXT.pageAlerts}`);
  });

  it("shows the test alert being sent, then the outcome", () => {
    const sending = view({ pushState: "on", busy: "testing" });
    expect(sending).toMatchObject({ label: "Alerts on", disabled: true, busy: false });
    expect(sending.test).toMatchObject({ show: true, label: "Sending a test alert…", disabled: true, busy: true });
    expect(view({ pushState: "on", test: { ok: true } }).test.message).toEqual({
      role: "status",
      tone: "ok",
      text: "Sent: you should see a notification in a few seconds. If nothing appears, check the phone's notification settings for Call Guard.",
    });
    // Not signed up any more: the button goes back to Turn on alerts, and the reason stays visible.
    const gone = view({ pushState: "off", test: { ok: false, text: ALERTS_TEXT.notSignedUp } });
    expect(gone.label).toBe("Turn on alerts");
    expect(gone.test).toMatchObject({ show: false, message: { role: "alert", tone: "error", text: ALERTS_TEXT.notSignedUp } });
  });

  it("always has a label and a message, and only says Alerts on when notifications are on", () => {
    const states: PushState[] = ["unknown", "unsupported", "needs-install", "off", "on", "denied", "error"];
    const busies: AlertsBusy[] = [null, "turning-on", "testing"];
    for (const pushState of states)
      for (const soundArmed of [false, true])
        for (const busy of busies)
          for (const tapped of [false, true]) {
            const v = view({ pushState, soundArmed, busy, tapped, lastError: pushState === "error" ? { step: "save", reason: "failed" } : null });
            expect(v.label.length).toBeGreaterThan(0);
            expect(v.message.text.length).toBeGreaterThan(0);
            expect(v.disabled).toBe(busy !== null);
            if (v.label === "Alerts on") expect(pushState).toBe("on");
            if (v.label === "Sound alerts on") expect(soundArmed).toBe(true);
          }
  });
});

describe("alertsErrorText", () => {
  it("names the step in plain words", () => {
    expect(alertsErrorText({ step: "permission", reason: "dismissed" })).toContain("without choosing Allow");
    expect(alertsErrorText({ step: "permission", reason: "timed-out" })).toBe("Your phone's question about notifications wasn't answered in time.");
    expect(alertsErrorText({ step: "service-worker", reason: "failed" })).toBe("Call Guard's notification helper couldn't start on this phone.");
    expect(alertsErrorText({ step: "service-worker", reason: "timed-out" })).toContain("took too long to start");
    expect(alertsErrorText({ step: "subscribe", reason: "failed" })).toBe("This phone's notification service wouldn't sign Call Guard up.");
    expect(alertsErrorText({ step: "save", reason: "timed-out" })).toBe("Northgate took too long to answer when saving this phone.");
    expect(alertsErrorText({ step: "save", reason: "failed" })).toBe("Couldn't save this phone with Northgate. Check your signal.");
    expect(alertsErrorText({ step: "save", reason: "failed", detail: "Open your Call Guard link again to sign in." })).toBe(
      "Couldn't save this phone with Northgate. Open your Call Guard link again to sign in.",
    );
    expect(alertsErrorText({ step: "save", reason: "failed", detail: "Could not turn on alerts" })).toBe(
      "Couldn't save this phone with Northgate. Could not turn on alerts.",
    );
  });
});

/* ---------- POST /api/protect/test-alert ---------- */

const TOKEN = "0123456789abcdef01234567";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-1";
const OTHER = "https://web.push.apple.com/device-2";
const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };

describe("testAlertSchema", () => {
  it("accepts only an https endpoint at a browser push service, and nothing else", () => {
    expect(testAlertSchema.safeParse({ endpoint: ENDPOINT }).success).toBe(true);
    expect(testAlertSchema.safeParse({ endpoint: OTHER }).success).toBe(true);
    for (const bad of [
      {},
      { endpoint: "" },
      { endpoint: 42 },
      { endpoint: "http://fcm.googleapis.com/fcm/send/x" },
      { endpoint: "https://evil.example/fcm/send/x" },
      { endpoint: "https://fcm.googleapis.com.evil.example/x" },
      { endpoint: `https://fcm.googleapis.com/${"x".repeat(2000)}` },
      { endpoint: ENDPOINT, keys: KEYS },
      { endpoint: ENDPOINT, callId: "x" },
    ]) {
      expect(testAlertSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  it("is a plain notification payload with no handover", () => {
    const payload = testPayload();
    expect(payload).toMatchObject({ type: "test", title: "Call Guard test alert", body: "Alerts are working on this phone.", tag: "call-guard-test", url: "/protect" });
    expect(payload).not.toHaveProperty("callId");
    expect(payload).not.toHaveProperty("actions");
  });
});

describe("POST /api/protect/test-alert", () => {
  const prev = { ...process.env };
  beforeAll(() => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "x", ANTHROPIC_MODEL: "x", ANTHROPIC_FAST_MODEL: "x", ELEVENLABS_API_KEY: "x",
      TWILIO_AUTH_TOKEN: "x",
      CUSTOMER_PHONE_NUMBER: "+447700900999", CUSTOMER_FIRST_NAME: "Ben", CUSTOMER_LINK_TOKEN: TOKEN,
      NEXT_PUBLIC_VAPID_PUBLIC_KEY: "x", VAPID_PRIVATE_KEY: "x", RISK_THRESHOLD: "",
      TWILIO_ACCOUNT_SID: "x", TWILIO_API_KEY_SID: "x", TWILIO_API_KEY_SECRET: "x",
      TWILIO_PHONE_NUMBER: "+14155550100", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "x",
      SUPABASE_SERVICE_ROLE_KEY: "x", RESEND_API_KEY: "x", REPORT_FROM_EMAIL: "a@b.co", REPORT_TO_EMAIL: "a@b.co",
      TOOL_SECRET: "0123456789abcdef0123", DASHBOARD_PASSWORD: "pw-123456", PUBLIC_BASE_URL: "",
    });
    resetEnvCache();
  });
  afterAll(() => {
    process.env = prev;
    resetEnvCache();
  });
  beforeEach(() => {
    fake.rows = [
      { id: "sub-1", endpoint: ENDPOINT, keys: KEYS },
      { id: "sub-2", endpoint: OTHER, keys: KEYS },
    ];
    fake.updated = [];
    fake.deleted = [];
    fake.sent = [];
    fake.readError = null;
    fake.pushFailure = null;
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  const request = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://granny-agent.vercel.app/api/protect/test-alert", {
      method: "POST",
      headers: {
        host: "granny-agent.vercel.app",
        "content-type": "application/json",
        cookie: `${CUSTOMER_COOKIE}=${customerCookieValue(TOKEN)}`,
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const { POST } = await import("@/app/api/protect/test-alert/route");
    const res = await POST(request(body, headers));
    return { status: res.status, body: (await res.json()) as { ok: boolean; outcome?: string; error?: string } };
  };

  it("sends one test alert, to this device only", async () => {
    const res = await post({ endpoint: ENDPOINT });
    expect(res).toEqual({ status: 200, body: { ok: true, outcome: "sent" } });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ endpoint: ENDPOINT, keys: KEYS, options: { urgency: "high" } });
    expect(fake.sent[0].payload).toEqual(JSON.parse(JSON.stringify(testPayload())));
    expect(fake.updated).toEqual([{ id: "sub-1", patch: { last_success_at: expect.any(String) } }]);
    expect(fake.deleted).toEqual([]);
  });

  it("refuses an endpoint that isn't signed up (404), sending nothing", async () => {
    const res = await post({ endpoint: "https://fcm.googleapis.com/fcm/send/someone-else" });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false, outcome: "not_found" });
    expect(res.body.error).toContain("Tap Turn on alerts");
    expect(fake.sent).toEqual([]);
  });

  it("deletes an expired subscription and asks for alerts to be turned on again", async () => {
    for (const statusCode of [404, 410]) {
      fake.rows = [{ id: "sub-1", endpoint: ENDPOINT, keys: KEYS }];
      fake.deleted = [];
      fake.pushFailure = pushError(statusCode);
      const res = await post({ endpoint: ENDPOINT });
      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ ok: false, outcome: "expired" });
      expect(res.body.error).toContain("Tap Turn on alerts");
      expect(fake.deleted).toEqual(["sub-1"]);
    }
  });

  it("keeps the subscription when the push service fails for another reason (502)", async () => {
    fake.pushFailure = pushError(500);
    const res = await post({ endpoint: ENDPOINT });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ ok: false, outcome: "failed" });
    expect(fake.deleted).toEqual([]);
    fake.pushFailure = new Error("socket hang up");
    expect((await post({ endpoint: ENDPOINT })).status).toBe(502);
  });

  it("answers 500 if the database can't be read", async () => {
    fake.readError = "connection refused";
    const res = await post({ endpoint: ENDPOINT });
    expect(res).toEqual({ status: 500, body: { ok: false, error: "Couldn't send a test alert. Please try again." } });
    expect(fake.sent).toEqual([]);
  });

  it("validates the body: 400 for anything but { endpoint } at a push service", async () => {
    for (const bad of [{}, { endpoint: "https://evil.example/x" }, { endpoint: ENDPOINT, extra: 1 }, "not json", { endpoint: "http://fcm.googleapis.com/x" }]) {
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(fake.sent).toEqual([]);
  });

  it("needs the customer cookie, same origin and JSON", async () => {
    expect((await post({ endpoint: ENDPOINT }, { cookie: "" })).status).toBe(401);
    expect((await post({ endpoint: ENDPOINT }, { cookie: `${CUSTOMER_COOKIE}=forged` })).status).toBe(401);
    expect((await post({ endpoint: ENDPOINT }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ endpoint: ENDPOINT }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post({ endpoint: ENDPOINT }, { "content-type": "text/plain" })).status).toBe(415);
    expect(fake.sent).toEqual([]);
  });
});

/* ---------- public/sw.js: the test notification ---------- */

function loadServiceWorker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: { title: string; options: Record<string, unknown> & { data: Record<string, unknown> } }[] = [];
  const fetches: string[] = [];
  const opened: string[] = [];
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => undefined,
    registration: {
      showNotification: async (title: string, options: (typeof shown)[number]["options"]) => {
        shown.push({ title, options });
      },
    },
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async (url: string) => opened.push(url) },
  };
  const fetch = async (url: string) => {
    fetches.push(url);
    return new Response(null, { status: 200 });
  };
  vm.runInNewContext(readFileSync("public/sw.js", "utf8"), { self, fetch, URL, console });
  const fire = async (type: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  };
  const push = (payload: unknown) => fire("push", { data: { json: () => payload, text: () => "" } });
  const click = (action: string) => {
    const last = shown[shown.length - 1];
    return fire("notificationclick", { action, notification: { close: () => undefined, data: last.options.data } });
  };
  return { push, click, shown, fetches, opened };
}

describe("service worker test notification", () => {
  it("shows a plain notification with no handover actions", async () => {
    const sw = loadServiceWorker();
    await sw.push(JSON.parse(JSON.stringify(testPayload())));
    expect(sw.shown).toHaveLength(1);
    const [{ title, options }] = sw.shown;
    expect(title).toBe("Call Guard test alert");
    expect(options).toMatchObject({ body: "Alerts are working on this phone.", tag: "call-guard-test" });
    expect(options.actions).toBeUndefined();
    expect(options.requireInteraction).toBeUndefined();
  });

  it("only opens Call Guard when tapped, never handing a call over", async () => {
    const sw = loadServiceWorker();
    await sw.push(JSON.parse(JSON.stringify(testPayload())));
    await sw.click("");
    await sw.click("handover"); // not offered, and refused anyway
    expect(sw.fetches).toEqual([]);
    expect(sw.opened).toEqual(["/protect", "/protect"]);
  });

  it("still shows a notification for every push", async () => {
    const sw = loadServiceWorker();
    await sw.push({ type: "test" });
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].title).toBe("Call Guard test alert");
    expect(sw.shown[0].options.body).toBe("Alerts are working on this phone.");
  });
});
