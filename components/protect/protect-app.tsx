"use client";

import { BellRing, CheckCircle2, ChevronRight, Loader2, PhoneCall, PhoneOff, Send, ShieldCheck, Smartphone, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScamAlert, type ScamAlertProps } from "@/components/protect/scam-alert";
import { VoiceTwinCard } from "@/components/protect/voice-twin-card";
import { RiskGauge } from "@/components/risk-gauge";
import type { CustomerCall } from "@/lib/customer-view";
import { useChangeSignals } from "@/lib/supabase/change-signals";
import type { TakeoverChoice } from "@/lib/types";
import { AGE_BAND_WORDS, type VoiceMatchSetting } from "@/lib/voice-match";
import type { CustomerTwinView } from "@/lib/voice-twin/view";

type GuardCall = CustomerCall;

type View = "idle" | "screening" | "offered" | "requested" | "connected" | "failed";
export type PushState = "unknown" | "unsupported" | "needs-install" | "off" | "on" | "denied" | "error";

/** How long the "Northgate has this call" screen stays up after a taken-over call ends. */
const CONNECTED_LINGER_MS = 15 * 60_000;
/** A handover still "requested" after this has died (the server allows 30 s): tell the customer they're still on. */
const REQUEST_STALE_MS = 40_000;

export function viewFor(call: GuardCall | null, now: number): View {
  if (!call) return "idle";
  if (call.handoff_status === "connected") {
    if (call.status === "live" || !call.ended_at || now === 0 || now - Date.parse(call.ended_at) < CONNECTED_LINGER_MS) return "connected";
    return "idle";
  }
  if (call.status !== "live") return "idle";
  if (call.handoff_status === "offered") return "offered";
  if (call.handoff_status === "requested") {
    const since = call.handoff_requested_at ? Date.parse(call.handoff_requested_at) : NaN;
    return now > 0 && Number.isFinite(since) && now - since > REQUEST_STALE_MS ? "failed" : "requested";
  }
  if (call.handoff_status === "failed") return "failed";
  return "screening";
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

const NO_CONNECTION = "Couldn't reach Northgate. Check your signal and try again. If you're unsure, hang up.";

/** A customer route's JSON reply: `ok`, `error` and `outcome` plus whatever the route returns. */
export type PostReply<T> = Partial<T> & { ok?: boolean; error?: string; outcome?: string };

/** POST to a customer route. Never throws: network failures come back as a plain-language error. */
export async function postJson<T extends object = Record<string, never>>(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; error?: string; outcome?: string; data: PostReply<T> }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    });
    const data = (await res.json().catch(() => ({}))) as PostReply<T>;
    return {
      ok: res.ok && data.ok !== false,
      error: data.error ?? (res.ok ? undefined : "Something went wrong. Please try again."),
      outcome: data.outcome,
      data,
    };
  } catch {
    return { ok: false, error: NO_CONNECTION, data: {} as PostReply<T> };
  }
}

/* ---------- alerts: pure logic (unit tested in tests/alerts.test.ts) ---------- */

/** Whether this browser can get notifications as it's open now. */
export type PushSupport = "supported" | "needs-install" | "unsupported";

/** iPhone, iPod or iPad (iPadOS Safari says "Macintosh" but has a touch screen). */
export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  return /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** iOS only offers notifications to a Home Screen app: Safari itself has no Notification or PushManager. */
export function pushSupport(env: { serviceWorker: boolean; pushManager: boolean; notification: boolean; ios: boolean; standalone: boolean }): PushSupport {
  if (env.serviceWorker && env.pushManager && env.notification) return "supported";
  return env.ios && !env.standalone ? "needs-install" : "unsupported";
}

/** How long each step of "Turn on alerts" may take before the customer is told which one didn't finish. */
export interface AlertTimeouts {
  /** The permission question waits for the customer. */
  permission: number;
  serviceWorker: number;
  subscribe: number;
  save: number;
}

export const ALERT_TIMEOUTS_MS: AlertTimeouts = { permission: 60_000, serviceWorker: 10_000, subscribe: 20_000, save: 15_000 };
/** The in-page alarm's unlock never holds anything up for longer than this (iOS can stall it during a call). */
export const SOUND_UNLOCK_MS = 1_500;

export class StepTimeout extends Error {
  constructor(ms: number) {
    super(`no answer within ${ms / 1000} s`);
    this.name = "StepTimeout";
  }
}

/** `promise`, or a StepTimeout rejection after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** `promise`'s value, or `fallback` if it fails or takes longer than `ms`. Never rejects. */
export function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return withTimeout(promise, ms).catch(() => fallback);
}

export type AlertsStep = "permission" | "service-worker" | "subscribe" | "save";

/** Which step of "Turn on alerts" didn't work, and how. `detail` is the server's own plain-language reason. */
export interface AlertsError {
  step: AlertsStep;
  reason: "failed" | "timed-out" | "dismissed";
  detail?: string;
}

export type EnableAlertsResult = { state: "on"; endpoint: string } | { state: "denied" } | { state: "error"; error: AlertsError };

/** The browser steps of "Turn on alerts", injected so the order and timeouts can be tested. */
export interface EnableAlertsSteps<R, S extends { endpoint: string }> {
  /** Notification.requestPermission(), already started inside the tap (iOS requires the user gesture). */
  permission: Promise<NotificationPermission>;
  /** Register (or find) the service worker and wait until it's running. */
  serviceWorker: () => Promise<R>;
  /** This device's push subscription: the existing one, or a new one. */
  subscribe: (registration: R) => Promise<S>;
  /** Save it on the server. */
  save: (subscription: S) => Promise<{ ok: boolean; error?: string }>;
}

/** Permission, service worker, subscription, save: each with its own timeout. Never throws. */
export async function enableAlerts<R, S extends { endpoint: string }>(
  steps: EnableAlertsSteps<R, S>,
  timeouts: AlertTimeouts = ALERT_TIMEOUTS_MS,
): Promise<EnableAlertsResult> {
  const failed = (step: AlertsStep, error: unknown): EnableAlertsResult => ({
    state: "error",
    error: { step, reason: error instanceof StepTimeout ? "timed-out" : "failed" },
  });

  let permission: NotificationPermission;
  try {
    permission = await withTimeout(steps.permission, timeouts.permission);
  } catch (error) {
    return failed("permission", error);
  }
  if (permission === "denied") return { state: "denied" };
  if (permission !== "granted") return { state: "error", error: { step: "permission", reason: "dismissed" } };

  let registration: R;
  try {
    registration = await withTimeout(steps.serviceWorker(), timeouts.serviceWorker);
  } catch (error) {
    return failed("service-worker", error);
  }

  let subscription: S;
  try {
    subscription = await withTimeout(steps.subscribe(registration), timeouts.subscribe);
  } catch (error) {
    return failed("subscribe", error);
  }

  let saved: { ok: boolean; error?: string };
  try {
    saved = await withTimeout(steps.save(subscription), timeouts.save);
  } catch (error) {
    return failed("save", error);
  }
  if (!saved.ok) return { state: "error", error: { step: "save", reason: "failed", detail: saved.error } };
  return { state: "on", endpoint: subscription.endpoint };
}

export const ALERTS_TEXT = {
  intro: "Get a notification, sound and vibration if a call looks like a scam. This page also works without notifications while it's open.",
  turningOn: "Turning on alerts… If your phone asks, tap Allow.",
  on: "Alerts on. You'll get a notification if a call looks like a scam, even when Call Guard is closed.",
  onAlready: "Notifications are on for this phone.",
  armSoundToo: "Tap Alerts on to arm sound and vibration too while this page is open.",
  needsInstall:
    "On iPhone, notifications only work in the Call Guard Home Screen app: tap Share → Add to Home Screen, then open Call Guard from the new icon and tap Turn on alerts there.",
  unsupported: "This browser can't get notifications. Keep this page open: it still alerts you while it's open.",
  denied:
    "Notifications are blocked for Call Guard. To allow them again on iPhone, open Settings → Notifications → Call Guard and turn on Allow Notifications. On Android or a computer, open this site's settings in your browser and allow notifications. Then tap Turn on alerts.",
  checkFailed: "Couldn't check notifications on this phone.",
  tryAgain: "Tap Turn on alerts to try again.",
  soundArmed: "Sound and vibration are armed while this page is open.",
  pageAlerts: "This page still alerts you while it's open.",
  testSent: "Sent: you should see a notification in a few seconds. If nothing appears, check the phone's notification settings for Call Guard.",
  notSignedUp: "This phone isn't signed up for alerts any more. Tap Turn on alerts to sign it up again.",
  testLookupFailed: "Couldn't check this phone's alerts. Please try again.",
  testNoConnection: "Couldn't reach Northgate to send a test alert. Check your signal and try again.",
} as const;

/** Which step failed, in plain words. */
export function alertsErrorText(error: AlertsError): string {
  const slow = error.reason === "timed-out";
  switch (error.step) {
    case "permission":
      if (error.reason === "dismissed") return "Notifications weren't allowed: your phone's question was closed without choosing Allow.";
      return slow ? "Your phone's question about notifications wasn't answered in time." : "Your phone wouldn't ask about notifications.";
    case "service-worker":
      return slow ? "Call Guard's notification helper took too long to start on this phone." : "Call Guard's notification helper couldn't start on this phone.";
    case "subscribe":
      return slow ? "This phone's notification service took too long to answer." : "This phone's notification service wouldn't sign Call Guard up.";
    case "save": {
      if (slow) return "Northgate took too long to answer when saving this phone.";
      const detail = error.detail?.trim().slice(0, 200);
      return `Couldn't save this phone with Northgate. ${detail ? (/[.!?]$/.test(detail) ? detail : `${detail}.`) : "Check your signal."}`;
    }
  }
}

export type AlertsBusy = "turning-on" | "testing" | null;
export type TestAlertResult = { ok: true } | { ok: false; text: string };

export interface AlertsMessage {
  /** "alert" for a failure the customer just caused by tapping; "status" otherwise. */
  role: "status" | "alert";
  tone: "info" | "ok" | "error";
  text: string;
}

export interface AlertsViewInput {
  pushState: PushState;
  soundArmed: boolean;
  busy: AlertsBusy;
  /** Why the last "Turn on alerts" failed (cleared on the next tap). */
  lastError: AlertsError | null;
  /** The customer tapped "Turn on alerts" on this visit, so the message reports that tap's outcome. */
  tapped: boolean;
  /** The last "Send a test alert" result. */
  test: TestAlertResult | null;
}

export interface AlertsView {
  label: string;
  disabled: boolean;
  busy: boolean;
  /** Notifications are on: the button looks done. */
  on: boolean;
  message: AlertsMessage;
  test: { show: boolean; label: string; disabled: boolean; busy: boolean; message: AlertsMessage | null };
}

const sentence = (...parts: (string | null | false)[]) => parts.filter(Boolean).join(" ");

/** What the alerts card shows: the button's label and state, and a message that always says what happened. */
export function alertsView({ pushState, soundArmed, busy, lastError, tapped, test }: AlertsViewInput): AlertsView {
  const t = ALERTS_TEXT;
  const on = pushState === "on";
  // What still works without notifications.
  const fallback = soundArmed ? t.soundArmed : tapped ? t.pageAlerts : null;
  let message: AlertsMessage;
  if (busy === "turning-on") {
    message = { role: "status", tone: "info", text: t.turningOn };
  } else {
    switch (pushState) {
      case "on":
        message = {
          role: "status",
          tone: "ok",
          text: tapped ? sentence(t.on, soundArmed && t.soundArmed) : sentence(t.onAlready, soundArmed ? t.soundArmed : t.armSoundToo),
        };
        break;
      case "needs-install":
        message = { role: "status", tone: "info", text: sentence(t.needsInstall, fallback) };
        break;
      case "unsupported":
        message = { role: "status", tone: "info", text: sentence(t.unsupported, soundArmed && t.soundArmed) };
        break;
      case "denied":
        message = { role: tapped ? "alert" : "status", tone: "error", text: sentence(t.denied, fallback) };
        break;
      case "error":
        message = { role: "alert", tone: "error", text: sentence(lastError ? alertsErrorText(lastError) : t.checkFailed, t.tryAgain, soundArmed ? t.soundArmed : t.pageAlerts) };
        break;
      default:
        message = { role: "status", tone: "info", text: t.intro };
    }
  }
  return {
    label: busy === "turning-on" ? "Turning on alerts…" : on ? "Alerts on" : soundArmed ? "Sound alerts on" : "Turn on alerts",
    disabled: busy !== null,
    busy: busy === "turning-on",
    on,
    message,
    test: {
      show: on && busy !== "turning-on",
      label: busy === "testing" ? "Sending a test alert…" : "Send a test alert",
      disabled: busy !== null,
      busy: busy === "testing",
      message: test === null ? null : test.ok ? { role: "status", tone: "ok", text: t.testSent } : { role: "alert", tone: "error", text: test.text },
    },
  };
}

/** This browser's notification support right now. */
function readPushSupport(): PushSupport {
  const nav = navigator as Navigator & { standalone?: boolean };
  return pushSupport({
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notification: "Notification" in window,
    ios: isIos(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    standalone: window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true,
  });
}

/** Ask for notification permission. Call it straight from the tap, before anything is awaited (iOS needs that). */
function askPermission(): Promise<NotificationPermission> {
  try {
    return Notification.requestPermission();
  } catch (error) {
    return Promise.reject(error);
  }
}

/** This device's Call Guard push subscription, if it has one. */
async function currentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/protect");
  return reg ? reg.pushManager.getSubscription() : null;
}

const MESSAGE_TONE: Record<AlertsMessage["tone"], string> = {
  info: "text-muted-foreground",
  ok: "text-foreground",
  error: "rounded-lg border border-destructive/60 bg-destructive/15 p-3 text-foreground",
};

/** A short, quiet beep that confirms sound is on. */
function chirp(ctx: AudioContext) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.05;
  osc.frequency.value = 660;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.12);
}

/** Two-tone alarm through Web Audio (unlocked by the "Turn on alerts" tap). */
function playAlarm(ctx: AudioContext) {
  const t = ctx.currentTime;
  for (const [i, freq] of [880, 660, 880, 660].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + i * 0.22);
    gain.gain.exponentialRampToValueAtTime(0.25, t + i * 0.22 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.22 + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t + i * 0.22);
    osc.stop(t + i * 0.22 + 0.21);
  }
}

/** Date.now(), refreshed every `intervalMs` (0 until mounted, so server and first client render agree). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [intervalMs]);
  return now;
}

export function ProtectApp({ firstName, vapidPublicKey, riskThreshold }: { firstName: string; vapidPublicKey: string; riskThreshold: number }) {
  const [call, setCall] = useState<GuardCall | null>(null);
  const [twin, setTwin] = useState<CustomerTwinView | null>(null);
  const [voiceMatch, setVoiceMatch] = useState<VoiceMatchSetting | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const [busy, setBusy] = useState<ScamAlertProps["busy"]>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<PushState>("unknown");
  const [soundArmed, setSoundArmed] = useState(false);
  const [alertsBusy, setAlertsBusy] = useState<AlertsBusy>(null);
  const [alertsError, setAlertsError] = useState<AlertsError | null>(null);
  const [alertsTapped, setAlertsTapped] = useState(false);
  const [testResult, setTestResult] = useState<TestAlertResult | null>(null);
  // Once the customer taps, the tap reports the outcome: the on-load check must not overwrite it.
  const alertsActed = useRef(false);
  const audioRef = useRef<AudioContext | null>(null);
  const now = useNow(5_000);
  const view = viewFor(call, now);

  /* ---------- data: the call (and the AI Voice Twin) to show, live via Supabase Realtime change signals ---------- */
  const loadSeq = useRef(0);
  const loadLatest = useCallback(async () => {
    const mine = ++loadSeq.current;
    try {
      const res = await fetch("/api/protect/state", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { call: GuardCall | null; twin?: CustomerTwinView | null; voiceMatch?: VoiceMatchSetting | null };
      if (mine !== loadSeq.current) return; // a newer load started: don't apply an older snapshot
      setCall(data.call);
      setTwin(data.twin ?? null);
      setVoiceMatch(data.voiceMatch ?? null);
      setLoaded(true);
    } catch {
      // offline: the next signal, visibility change or poll retries
    }
  }, []);

  useChangeSignals({
    onSignal: (signal) => {
      // calls: the alert opens and its quotes update live; voice_twins: the progress bar fills live and "Use my Voice
      // Twin" appears the moment the twin is ready; settings: the AI voice match card.
      if (signal.table === "calls" || signal.table === "voice_twins" || signal.table === "settings") void loadLatest();
    },
    onSubscribed: () => void loadLatest(),
    onConnection: setConnection,
  });

  useEffect(() => {
    // Belt and braces: refresh when the app comes back to the foreground, and every 20 s while open.
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadLatest();
    };
    document.addEventListener("visibilitychange", onVisible);
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void loadLatest();
    }, 20_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(poll);
    };
  }, [loadLatest]);

  // An error belongs to the call and screen it was raised on.
  const errorScope = `${call?.id ?? ""}:${view}`;
  const [errorFor, setErrorFor] = useState(errorScope);
  if (errorFor !== errorScope) {
    setErrorFor(errorScope);
    if (actionError) setActionError(null);
  }

  /* ---------- service worker + push state ---------- */
  useEffect(() => {
    const timer = setTimeout(async () => {
      const support = readPushSupport();
      if (support !== "supported") {
        if (!alertsActed.current) setPushState(support);
        return;
      }
      try {
        const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/protect", updateViaCache: "none" });
        const existing = await reg.pushManager.getSubscription();
        const granted = Notification.permission === "granted";
        // Keep the server in step with this device (e.g. after the database was reset or the list was trimmed).
        if (existing && granted) void postJson("/api/protect/subscribe", existing.toJSON());
        if (alertsActed.current) return;
        if (Notification.permission === "denied") setPushState("denied");
        else setPushState(existing && granted ? "on" : "off");
      } catch {
        if (!alertsActed.current) setPushState("error");
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  /* ---------- the alarm while an offer is open ---------- */
  useEffect(() => {
    if (view !== "offered") return;
    const ring = () => {
      if (audioRef.current && audioRef.current.state === "running") playAlarm(audioRef.current);
      if ("vibrate" in navigator) navigator.vibrate([400, 200, 400, 200, 800]);
    };
    ring();
    const t = setInterval(ring, 2_500);
    return () => {
      clearInterval(t);
      if ("vibrate" in navigator) navigator.vibrate(0);
    };
  }, [view]);

  /* ---------- actions ---------- */
  /**
   * Unlock the in-page alarm. Starts inside the tap (resume() needs the gesture) but is never waited on before
   * subscribing: on iPhone it can stall while a phone call holds the audio. Resolves within SOUND_UNLOCK_MS with
   * whether sound is on yet; if it comes on later, the alarm still uses it.
   */
  const armSound = (): Promise<boolean> => {
    let ctx: AudioContext;
    let resuming: Promise<void>;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return Promise.resolve(false);
      ctx = audioRef.current ?? new Ctx();
      audioRef.current = ctx;
      resuming = ctx.resume();
    } catch {
      return Promise.resolve(false); // no Web Audio: the visual alert still works
    }
    let late = false;
    const ready = resuming.then(
      () => {
        if (ctx.state !== "running") return false;
        if (!late) {
          try {
            chirp(ctx);
          } catch {
            // the beep is only a confirmation
          }
        }
        setSoundArmed(true);
        return true;
      },
      () => false,
    );
    return settleWithin(ready, SOUND_UNLOCK_MS, false).then((armed) => {
      if (!armed) late = true; // don't beep minutes later when a call ends
      return armed;
    });
  };

  const turnOnAlerts = async () => {
    if (alertsBusy) return;
    alertsActed.current = true;
    setAlertsBusy("turning-on");
    setAlertsTapped(true);
    setAlertsError(null);
    setTestResult(null);
    const support = readPushSupport();
    // Ask for notification permission first, straight from the tap (iOS requires the user gesture).
    const permission = support === "supported" ? askPermission() : null;
    // Unlock sound and vibration in parallel.
    const sound = armSound();
    if ("vibrate" in navigator) navigator.vibrate(60);
    try {
      if (permission === null) {
        setPushState(support === "needs-install" ? "needs-install" : "unsupported");
        return;
      }
      const result = await enableAlerts({
        permission,
        serviceWorker: async () => {
          if (!(await navigator.serviceWorker.getRegistration("/protect"))) {
            await navigator.serviceWorker.register("/sw.js", { scope: "/protect", updateViaCache: "none" });
          }
          return navigator.serviceWorker.ready;
        },
        subscribe: async (reg) =>
          (await reg.pushManager.getSubscription()) ??
          (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) })),
        save: async (sub) => {
          const saved = await postJson("/api/protect/subscribe", sub.toJSON());
          // Only the server's own reason: a network failure falls back to "check your signal".
          return { ok: saved.ok, error: saved.data.error };
        },
      });
      if (result.state === "error") {
        console.warn("Call Guard: turning on alerts failed", result.error);
        setAlertsError(result.error);
      }
      setPushState(result.state);
    } finally {
      // At most SOUND_UNLOCK_MS, so the label says whether sound is on when the outcome shows.
      await sound;
      setAlertsBusy(null);
    }
  };

  const sendTestAlert = async () => {
    if (alertsBusy) return;
    setAlertsBusy("testing");
    setTestResult(null);
    try {
      let subscription: PushSubscription | null;
      try {
        subscription = await withTimeout(currentSubscription(), ALERT_TIMEOUTS_MS.serviceWorker);
      } catch {
        setTestResult({ ok: false, text: ALERTS_TEXT.testLookupFailed });
        return;
      }
      if (!subscription) {
        setPushState("off");
        setTestResult({ ok: false, text: ALERTS_TEXT.notSignedUp });
        return;
      }
      const res = await postJson("/api/protect/test-alert", { endpoint: subscription.endpoint });
      if (res.ok) {
        setTestResult({ ok: true });
        return;
      }
      // The push service dropped this subscription: forget it here too, so "Turn on alerts" makes a fresh one.
      if (res.outcome === "expired") await settleWithin(subscription.unsubscribe(), 5_000, false);
      if (res.outcome === "expired" || res.outcome === "not_found") setPushState("off");
      setTestResult({ ok: false, text: res.data.error ?? ALERTS_TEXT.testNoConnection });
    } finally {
      setAlertsBusy(null);
    }
  };

  const alerts = alertsView({ pushState, soundArmed, busy: alertsBusy, lastError: alertsError, tapped: alertsTapped, test: testResult });

  /* ---------- the alert's actions: "Use AI voice" (matched automatically) or "Use my Voice Twin" ---------- */
  const handOver = async (choice: TakeoverChoice) => {
    if (!call || busy) return;
    setBusy({ action: "handover", choice });
    setActionError(null);
    try {
      const res = await postJson("/api/protect/takeover", { callId: call.id, choice });
      // A twin that can't be used claims nothing: the message says to use the AI voice instead.
      if (!res.ok) setActionError(res.error ?? "The handover didn't go through.");
    } finally {
      setBusy(null);
      void loadLatest();
    }
  };

  const decline = async () => {
    if (!call || busy) return;
    setBusy({ action: "dismiss" });
    setActionError(null);
    try {
      const res = await postJson("/api/protect/decline", { callId: call.id });
      if (!res.ok) setActionError(res.error ?? "Couldn't save that. Please try again.");
    } finally {
      setBusy(null);
      void loadLatest();
    }
  };

  // Move focus to the alert so screen readers announce it.
  const alertTitle = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (view === "offered") alertTitle.current?.focus();
  }, [view]);

  /* ---------- render ---------- */
  if (view === "offered" && call) {
    return (
      <ScamAlert
        quotes={call.risk?.quotes ?? []}
        twin={twin}
        busy={busy}
        error={actionError}
        onHandOver={(choice) => void handOver(choice)}
        onDismiss={() => void decline()}
        titleRef={alertTitle}
      />
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))]">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-7 text-primary" aria-hidden />
          <div className="leading-tight">
            <div className="font-bold tracking-[0.18em]">NORTHGATE</div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Call Guard</div>
          </div>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={`size-2 rounded-full ${connection === "live" ? "bg-emerald-400" : connection === "connecting" ? "bg-amber-400" : "bg-destructive"}`} />
          {connection === "live" ? "Protected" : connection === "connecting" ? "Connecting…" : "Offline"}
        </span>
      </header>

      <section className="flex flex-1 flex-col items-center justify-center gap-4 rounded-3xl border border-border bg-card/80 p-6 text-center">
        {!loaded && <Loader2 className="size-8 animate-spin text-muted-foreground" />}

        {loaded && view === "idle" && (
          <>
            <ShieldCheck className="size-16 text-emerald-400" aria-hidden />
            <h1 className="text-2xl font-semibold">You&apos;re protected{firstName ? `, ${firstName}` : ""}</h1>
            <p className="text-muted-foreground">Northgate screens calls to your number. If a caller looks like a scam, you&apos;ll get an alert here.</p>
          </>
        )}

        {(view === "screening" || view === "failed") && call && (
          <>
            <PhoneCall className="size-10 text-primary" aria-hidden />
            <h1 className="text-xl font-semibold">In a call with {call.caller_masked ?? "an unknown number"}</h1>
            <RiskGauge score={call.risk?.score ?? null} threshold={riskThreshold} size="lg" label="Scam risk" />
            <p className="text-sm text-muted-foreground">{call.risk?.reason ?? "Listening for warning signs…"}</p>
            {call.handoff_status === "declined" && (
              <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">You said you know this caller. We&apos;ll alert you again if it gets riskier.</p>
            )}
            {view === "failed" && (
              <p className="rounded-lg border border-destructive/60 bg-destructive/15 px-3 py-2 text-sm">
                We couldn&apos;t take this call over. If you&apos;re unsure, hang up and call Northgate on the number on the back of your card.
              </p>
            )}
          </>
        )}

        {view === "requested" && (
          <>
            <Loader2 className="size-12 animate-spin text-primary" aria-hidden />
            <h1 className="text-xl font-semibold">{call?.takeover_kind === "voice_twin" ? "Handing over to your AI Voice Twin…" : "Handing over to the AI voice…"}</h1>
            <p className="text-sm text-muted-foreground">Your side of the call will end in a moment.</p>
          </>
        )}

        {view === "connected" && call && call.takeover_kind === "voice_twin" && (
          <>
            <CheckCircle2 className="size-16 text-emerald-400" aria-hidden />
            <h1 className="text-2xl font-semibold">Your AI Voice Twin has this call. Don&apos;t call them back.</h1>
            <p className="text-muted-foreground">
              {call.status === "live" ? "Your AI Voice Twin is keeping the caller busy now, in your voice." : "The call has ended."} It never agrees to
              payments or gives your real details. You don&apos;t need to do anything else. Never share codes or move money for someone who calls you.
            </p>
            <PhoneOff className="size-6 text-muted-foreground" aria-hidden />
          </>
        )}

        {view === "connected" && call && call.takeover_kind !== "voice_twin" && (
          <>
            <CheckCircle2 className="size-16 text-emerald-400" aria-hidden />
            <h1 className="text-2xl font-semibold">Northgate has this call. Don&apos;t call them back.</h1>
            <p className="text-muted-foreground">
              {call.status === "live" ? "Northgate's AI voice is keeping the caller busy now." : "The call has ended."} It never agrees to payments or
              gives your real details. You don&apos;t need to do anything else. Never share codes or move money for someone who calls you.
            </p>
            <PhoneOff className="size-6 text-muted-foreground" aria-hidden />
          </>
        )}
      </section>

      {actionError && view !== "offered" && (
        <p role="alert" className="rounded-lg border border-destructive/60 bg-destructive/15 p-3 text-sm">
          {actionError}
        </p>
      )}

      <section aria-label="Alerts" className="space-y-3 rounded-2xl border border-border bg-card/60 p-4">
        <button
          type="button"
          onClick={turnOnAlerts}
          disabled={alerts.disabled}
          aria-busy={alerts.busy}
          className={`flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 font-semibold active:scale-[0.99] disabled:opacity-70 ${
            alerts.on ? "bg-muted text-foreground" : "bg-primary text-primary-foreground"
          }`}
        >
          {alerts.busy ? <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden /> : <BellRing className="size-5 shrink-0" aria-hidden />}
          {alerts.label}
        </button>
        {/* Remounted when the role changes, so a new alert is announced. */}
        <p key={alerts.message.role} role={alerts.message.role} className={`flex gap-2 text-sm leading-relaxed ${MESSAGE_TONE[alerts.message.tone]}`}>
          {pushState === "needs-install" && !alerts.busy && <Smartphone className="mt-0.5 size-4 shrink-0" aria-hidden />}
          <span>{alerts.message.text}</span>
        </p>
        {alerts.test.show && (
          <button
            type="button"
            onClick={sendTestAlert}
            disabled={alerts.test.disabled}
            aria-busy={alerts.test.busy}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-border px-4 py-3 font-semibold active:scale-[0.99] disabled:opacity-70"
          >
            {alerts.test.busy ? <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden /> : <Send className="size-5 shrink-0" aria-hidden />}
            {alerts.test.label}
          </button>
        )}
        {alerts.test.message && (
          <p key={`test-${alerts.test.message.role}`} role={alerts.test.message.role} className={`text-sm leading-relaxed ${MESSAGE_TONE[alerts.test.message.tone]}`}>
            {alerts.test.message.text}
          </p>
        )}
      </section>

      <VoiceTwinCard twin={loaded ? twin : null} now={now} />
      {loaded && <VoiceMatchCard setting={voiceMatch} />}
    </main>
  );
}

/** "Older female", "Male", "Not set": the customer's AI voice match in a few words. */
export function voiceMatchWords(setting: VoiceMatchSetting | null | undefined): string {
  const age = setting?.ageBand ? AGE_BAND_WORDS[setting.ageBand] : null;
  const words = [age, setting?.gender ?? null].filter(Boolean).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Not set";
}

/** Main-screen link to the "Your AI voice match" setting, with what it is set to. */
function VoiceMatchCard({ setting }: { setting: VoiceMatchSetting | null }) {
  return (
    <Link href="/protect/settings#voice-match" className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card/60 p-4 active:scale-[0.99]">
      <span className="flex items-center gap-2 font-semibold">
        <UserRound className="size-5 text-primary" aria-hidden />
        Your AI voice match
      </span>
      <span className="flex items-center gap-1 text-sm text-muted-foreground">
        {voiceMatchWords(setting)}
        <ChevronRight className="size-4" aria-hidden />
      </span>
    </Link>
  );
}
