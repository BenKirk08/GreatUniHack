import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/auth";

/* ---------- webhook signature (X-Twilio-Signature) ---------- */

/**
 * Twilio's request signature for application/x-www-form-urlencoded POSTs (mirrors twilio-node's
 * getExpectedTwilioSignature): take the full URL Twilio requested, append every POST parameter sorted by name
 * (case-sensitive code-unit order; a repeated name contributes each distinct value, sorted), name immediately
 * followed by value with no delimiters, HMAC-SHA1 it with the account Auth Token, and base64 the digest.
 */
export function computeTwilioSignature(authToken: string, url: string, params: URLSearchParams | Record<string, string | string[]>): string {
  const byName = new Map<string, Set<string>>();
  const add = (k: string, v: string) => {
    const set = byName.get(k) ?? new Set<string>();
    set.add(v);
    byName.set(k, set);
  };
  if (params instanceof URLSearchParams) params.forEach((v, k) => add(k, v));
  else for (const [k, v] of Object.entries(params)) for (const x of Array.isArray(v) ? v : [v]) add(k, x);
  let data = url;
  for (const name of [...byName.keys()].sort()) for (const value of [...byName.get(name)!].sort()) data += name + value;
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

/** The URL with and without an explicit default port (Twilio drops the port on HTTPS voice callbacks). */
function urlVariants(url: string): string[] {
  const m = url.match(/^(https?):\/\/([^/:?#]+)(:\d+)?(.*)$/i);
  if (!m) return [url];
  const [, scheme, host, port, rest] = m;
  const withoutPort = `${scheme}://${host}${rest}`;
  const withPort = `${scheme}://${host}${port ?? (scheme.toLowerCase() === "https" ? ":443" : ":80")}${rest}`;
  return [...new Set([url, withoutPort, withPort])];
}

export function validateTwilioSignature(
  authToken: string | null | undefined,
  signature: string | null | undefined,
  url: string,
  params: URLSearchParams | Record<string, string | string[]>,
): boolean {
  if (!authToken || !signature) return false;
  const provided = signature.trim();
  return urlVariants(url).some((u) => safeEqual(provided, computeTwilioSignature(authToken, u, params)));
}

/** The URL Twilio signed: PUBLIC_BASE_URL + path + query (never the Host header, which a proxy can change). */
export function signedUrl(publicBaseUrl: string, requestUrl: string): string {
  const u = new URL(requestUrl);
  return `${publicBaseUrl.replace(/\/$/, "")}${u.pathname}${u.search}`;
}

/**
 * Read a Twilio webhook: the raw form body, validated against X-Twilio-Signature. Returns the params, or null when
 * the signature is missing or wrong.
 */
export async function readSignedTwilioForm(
  req: Request,
  opts: { authToken: string; publicBaseUrl: string },
): Promise<{ ok: true; params: URLSearchParams } | { ok: false; reason: string }> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return { ok: false, reason: `unexpected content type ${contentType || "(none)"}` };
  }
  const raw = await req.text();
  const params = new URLSearchParams(raw);
  const url = signedUrl(opts.publicBaseUrl, req.url);
  if (!validateTwilioSignature(opts.authToken, req.headers.get("x-twilio-signature"), url, params)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true, params };
}

/* ---------- TwiML ---------- */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Caller IDs that mean "withheld". Twilio passes some as words and replaces others with reserved numbers
 * (e.g. +266696687 for "anonymous").
 */
const WITHHELD = new Set([
  "anonymous",
  "restricted",
  "unknown",
  "unavailable",
  "private",
  "blocked",
  "+266696687",
  "+7378742833",
  "+2562533",
  "+8656696",
  "+86282452253",
]);

export function isWithheldCaller(from: string | null | undefined): boolean {
  const v = (from ?? "").trim();
  if (!v) return true;
  if (WITHHELD.has(v.toLowerCase())) return true;
  return !/^\+[1-9]\d{6,14}$/.test(v);
}

export interface ScreeningTwimlInput {
  publicBaseUrl: string;
  /** The caller's From. */
  from: string | null | undefined;
  twilioNumber: string;
  customerNumber: string;
}

/**
 * The screening call: transcribe both sides live, ring the customer through (showing the caller's own number, or
 * ours if withheld), then hang up. <Dial> deliberately has no action URL, so redirecting the call later (the
 * takeover) drops the customer's leg instead of returning to this document. The <Number> reports only "answered"
 * to /api/twilio/dial-status: that is where the AI Voice Twin's capture of the customer's own leg may start (it
 * never affects the call).
 */
export function screeningTwiml(input: ScreeningTwimlInput): string {
  const base = input.publicBaseUrl.replace(/\/$/, "");
  const callerId = isWithheldCaller(input.from) ? input.twilioNumber : (input.from as string).trim();
  const dialStatus = escapeXml(`${base}/api/twilio/dial-status`);
  const customerLeg = `<Number statusCallbackEvent="answered" statusCallback="${dialStatus}" statusCallbackMethod="POST">`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Response>`,
    `<Start><Transcription name="screen" track="both_tracks" inboundTrackLabel="caller" outboundTrackLabel="customer" languageCode="en-GB" statusCallbackUrl="${escapeXml(`${base}/api/twilio/transcription`)}"/></Start>`,
    `<Dial callerId="${escapeXml(callerId)}" answerOnBridge="true" timeout="25">`,
    `${customerLeg}${escapeXml(input.customerNumber)}</Number>`,
    `</Dial>`,
    `<Hangup/>`,
    `</Response>`,
  ].join("");
}

/* ---------- REST API (API key auth) ---------- */

export class TwilioError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export interface TwilioCredentials {
  accountSid: string;
  /** API key SID (SK…) or the Account SID when using the auth token. */
  username: string;
  password: string;
}

export async function twilioFetch<T>(
  creds: TwilioCredentials,
  url: string,
  init: { method?: "GET" | "POST" | "DELETE"; form?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? (init.form ? "POST" : "GET"),
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`,
      ...(init.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init.form ? new URLSearchParams(init.form).toString() : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }
  if (!res.ok) {
    const b = body as { message?: string; code?: number } | null;
    throw new TwilioError(
      `Twilio ${init.method ?? (init.form ? "POST" : "GET")} ${new URL(url).pathname} → ${res.status}: ${b?.message ?? text.slice(0, 200)}`,
      res.status,
      typeof b?.code === "number" ? b.code : null,
      body,
    );
  }
  return body as T;
}

export const TWILIO_API = "https://api.twilio.com/2010-04-01";

export function callUrl(accountSid: string, callSid: string, suffix = ""): string {
  return `${TWILIO_API}/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(callSid)}${suffix}.json`;
}

export interface TwilioCall {
  sid: string;
  from: string;
  to: string;
  status: string;
}

export function getCall(creds: TwilioCredentials, callSid: string, timeoutMs = 6_000): Promise<TwilioCall> {
  return twilioFetch<TwilioCall>(creds, callUrl(creds.accountSid, callSid), { timeoutMs });
}

/** Replace a live call's TwiML (the takeover). Twilio limits the Twiml parameter to 4,000 characters. */
export function updateCallTwiml(creds: TwilioCredentials, callSid: string, twiml: string, timeoutMs = 8_000): Promise<TwilioCall> {
  if (twiml.length > 4000) throw new Error(`TwiML is ${twiml.length} characters; Twilio accepts at most 4000`);
  return twilioFetch<TwilioCall>(creds, callUrl(creds.accountSid, callSid), { form: { Twiml: twiml }, timeoutMs });
}

/** In-progress child legs of a call (the customer's <Dial> leg while it is bridged). */
export async function inProgressChildCalls(creds: TwilioCredentials, parentCallSid: string, timeoutMs = 5_000): Promise<string[]> {
  const list = await twilioFetch<{ calls: { sid: string }[] }>(
    creds,
    `${TWILIO_API}/Accounts/${encodeURIComponent(creds.accountSid)}/Calls.json?ParentCallSid=${encodeURIComponent(parentCallSid)}&Status=in-progress`,
    { timeoutMs },
  );
  return (list.calls ?? []).map((c) => c.sid);
}

/** Start the `screen` transcription on a live call over REST (used to resume screening after a failed handover). */
export function startScreeningTranscription(creds: TwilioCredentials, callSid: string, publicBaseUrl: string, name = "screen", timeoutMs = 5_000) {
  return twilioFetch(creds, callUrl(creds.accountSid, callSid, "/Transcriptions"), {
    form: {
      Name: name,
      Track: "both_tracks",
      InboundTrackLabel: "caller",
      OutboundTrackLabel: "customer",
      LanguageCode: "en-GB",
      StatusCallbackUrl: `${publicBaseUrl.replace(/\/$/, "")}/api/twilio/transcription`,
    },
    timeoutMs,
  });
}

/**
 * Hang up any child leg of a call that is still connected (the customer's <Dial> leg). Twilio drops it when the parent
 * gets new TwiML; this is the documented-API backstop. Returns how many legs were ended.
 */
export async function endChildCalls(creds: TwilioCredentials, parentCallSid: string, timeoutMs = 5_000): Promise<number> {
  let ended = 0;
  for (const sid of await inProgressChildCalls(creds, parentCallSid, timeoutMs)) {
    await twilioFetch(creds, callUrl(creds.accountSid, sid), { form: { Status: "completed" }, timeoutMs });
    ended++;
  }
  return ended;
}

export interface StartStreamInput {
  /** The wss:// URL Twilio connects to. */
  url: string;
  /** Unique per call; also how the stream can be stopped by name. */
  name: string;
  /** Which audio to send. On a <Dial> child leg, inbound_track is only what the dialled party (the customer) says. */
  track: "inbound_track" | "outbound_track" | "both_tracks";
  /** Custom parameters, delivered in the stream's "start" message as start.customParameters. */
  parameters: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Start a unidirectional Media Stream on a live call over REST (the "Start a Stream" resource,
 * POST /Calls/{CallSid}/Streams). Custom parameters go as Parameter1.Name / Parameter1.Value, Parameter2.… in order.
 */
export async function startCallStream(creds: TwilioCredentials, callSid: string, input: StartStreamInput): Promise<{ sid: string }> {
  const entries = Object.entries(input.parameters);
  if (entries.length > 99) throw new Error(`a Media Stream takes at most 99 custom parameters (got ${entries.length})`);
  const form: Record<string, string> = { Url: input.url, Name: input.name, Track: input.track };
  entries.forEach(([name, value], i) => {
    form[`Parameter${i + 1}.Name`] = name;
    form[`Parameter${i + 1}.Value`] = value;
  });
  const stream = await twilioFetch<{ sid: string }>(creds, callUrl(creds.accountSid, callSid, "/Streams"), {
    form,
    timeoutMs: input.timeoutMs ?? 6_000,
  });
  if (typeof stream?.sid !== "string" || !stream.sid) throw new Error("Twilio started a stream but returned no stream SID");
  return { sid: stream.sid };
}

/** Stop a real-time transcription by its name (or SID). */
export function stopTranscription(creds: TwilioCredentials, callSid: string, nameOrSid: string, timeoutMs = 4_000): Promise<unknown> {
  return twilioFetch(creds, callUrl(creds.accountSid, callSid, `/Transcriptions/${encodeURIComponent(nameOrSid)}`), {
    form: { Status: "stopped" },
    timeoutMs,
  });
}

/* ---------- webhook payloads ---------- */

/**
 * Twilio timestamps are ISO 8601 with 3, 6 or 9 fractional digits ("2026-01-23T21:47:44.614701800Z"). Normalise to a
 * millisecond ISO string; fall back to `fallback` (now) when missing or unparseable.
 */
export function normaliseTwilioTimestamp(value: string | null | undefined, fallback: Date = new Date()): string {
  const m = value?.trim().match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    const ms = (m[2] ?? "").padEnd(3, "0").slice(0, 3);
    const d = new Date(`${m[1]}.${ms}${m[3] ?? "Z"}`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (value) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback.toISOString();
}

/** Real-time transcription tracks: inbound = what Twilio hears from the caller, outbound = the dialled customer. */
export function speakerForTrack(track: string | null | undefined): "caller" | "customer" | null {
  switch (track) {
    case "inbound_track":
    case "caller":
      return "caller";
    case "outbound_track":
    case "customer":
      return "customer";
    default:
      return null;
  }
}

/** The transcript text from a transcription-content event's TranscriptionData (a JSON string). */
export function transcriptFromTranscriptionData(data: string | null | undefined): string {
  if (!data) return "";
  try {
    const parsed = JSON.parse(data) as { transcript?: unknown };
    return typeof parsed.transcript === "string" ? parsed.transcript.replace(/\s+/g, " ").trim().slice(0, 2000) : "";
  } catch {
    return "";
  }
}

/** Final call states (the number-level StatusCallback fires once, at the end). */
export const TERMINAL_CALL_STATUSES = ["completed", "busy", "failed", "no-answer", "canceled"] as const;
