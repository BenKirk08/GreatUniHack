import { createHmac } from "node:crypto";
import { z } from "zod";
import { safeEqual } from "@/lib/auth";
import { serverEnv } from "@/lib/env";
import { startCallStream, TwilioError, type StartStreamInput, type TwilioCredentials } from "@/lib/twilio";
import { callSidSchema } from "@/lib/twilio-webhooks";
import { MEDIA_BRIDGE_FRESH_MS } from "@/lib/voice-twin/config";
import { liveVoiceTwinStore, type VoiceTwinStore } from "@/lib/voice-twin/store";

/**
 * AI Voice Twin capture from the phone network. When the customer answers a screened call, Twilio reports it on
 * /api/twilio/dial-status; if (and only if) the account holder has consented, the twin still needs audio, the call is
 * live and a media bridge is running, a unidirectional Media Stream is started on the customer's own <Dial> leg with
 * track=inbound_track, so only what the customer says is sent (never the caller's voice). The stream carries a
 * short-lived HMAC token that the bridge (services/media-bridge) verifies before it stores anything. The token is bound
 * to the consent it was made under (consent_given_at), so a revoke followed by a new consent mid-call never lets audio
 * captured under the old consent be stored.
 */

/* ---------- stream token ---------- */

export interface StreamTokenPayload {
  /** calls.id of the screened call. */
  callId: string;
  /** voice_twins.id of the consenting account holder. */
  twinId: string;
  /** The customer's <Dial> child leg the stream runs on (the "start" message's callSid must match). */
  childCallSid: string;
  /**
   * voice_twins.consent_given_at when the stream was started. The bridge stores nothing unless the twin still shows
   * consent with exactly this timestamp (a revoke, or a revoke and a new consent, ends the stream).
   */
  consentAt: string;
  /** Expiry, unix seconds. */
  exp: number;
}

const TOKEN_CONTEXT = "voice-twin-stream/v1.";
/** A stream token is valid this long (the bridge checks it once, when the stream starts). */
export const STREAM_TOKEN_TTL_SECONDS = 2 * 60 * 60;
/** Tokens that claim to expire further ahead than this weren't made by startVictimCapture and are refused. */
export const STREAM_TOKEN_MAX_AHEAD_SECONDS = 3 * 60 * 60;
const MAX_TOKEN_LENGTH = 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const tokenPayloadSchema = z
  .object({
    callId: z.guid(),
    twinId: z.guid(),
    childCallSid: callSidSchema,
    consentAt: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => Number.isFinite(Date.parse(value)), "not a timestamp"),
    exp: z.number().int().positive(),
  })
  .strict();

function signTokenPayload(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(TOKEN_CONTEXT + encodedPayload, "utf8").digest("base64url");
}

/** base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, "voice-twin-stream/v1." + base64url payload)). */
export function streamToken(payload: StreamTokenPayload, secret: string): string {
  if (!secret) throw new Error("stream token: no secret configured");
  const body = {
    callId: payload.callId,
    twinId: payload.twinId,
    childCallSid: payload.childCallSid,
    consentAt: payload.consentAt,
    exp: payload.exp,
  };
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return `${encoded}.${signTokenPayload(encoded, secret)}`;
}

/**
 * The token's payload, or null when it is malformed, signed with another secret, tampered with, expired, or claims an
 * expiry more than 3 h ahead. The signature is compared in constant time.
 */
export function verifyStreamToken(
  token: string | null | undefined,
  secret: string | null | undefined,
  nowMs: number,
): StreamTokenPayload | null {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!BASE64URL.test(encoded) || !BASE64URL.test(signature)) return null;
  if (!safeEqual(signature, signTokenPayload(encoded, secret))) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = tokenPayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  const nowSeconds = nowMs / 1000;
  if (parsed.data.exp <= nowSeconds) return null;
  if (parsed.data.exp > nowSeconds + STREAM_TOKEN_MAX_AHEAD_SECONDS) return null;
  return parsed.data;
}

/* ---------- starting the capture ---------- */

/** The stream's name on the customer's leg (one per call). */
export const VOICE_TWIN_STREAM_NAME = "voice-twin";

export interface CaptureDeps {
  store: Pick<VoiceTwinStore, "getTwin" | "getCallByTwilioSid" | "getActiveBridge">;
  /** Start a unidirectional Media Stream on the given call (Twilio REST). */
  startStream(
    childCallSid: string,
    opts: { url: string; name: string; track: "inbound_track"; parameters: Record<string, string> },
  ): Promise<{ sid: string }>;
  /** The HMAC secret for stream tokens (TOOL_SECRET). */
  secret(): string;
  now(): number;
}

export type CaptureSkipReason = "no_consent" | "not_needed" | "no_call" | "no_bridge" | "twilio_error";

export type CaptureResult = { started: true; streamSid: string } | { started: false; reason: CaptureSkipReason };

function twilioCreds(): TwilioCredentials {
  const env = serverEnv();
  return { accountSid: env.TWILIO_ACCOUNT_SID, username: env.TWILIO_API_KEY_SID, password: env.TWILIO_API_KEY_SECRET };
}

export function liveCaptureDeps(): CaptureDeps {
  return {
    store: liveVoiceTwinStore(),
    startStream: (childCallSid, opts) => {
      const input: StartStreamInput = { ...opts, timeoutMs: 6_000 };
      return startCallStream(twilioCreds(), childCallSid, input);
    },
    secret: () => serverEnv().TOOL_SECRET,
    now: () => Date.now(),
  };
}

/** The bridge's Media Streams endpoint: its public https:// (or wss://) URL as wss://…/media, or null if unusable. */
export function bridgeStreamUrl(publicUrl: string): string | null {
  const trimmed = publicUrl.trim().replace(/^https:\/\//i, "wss://");
  if (!/^wss:\/\//i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // Twilio doesn't pass query strings to Media Streams: the token goes as a custom parameter instead.
  return `wss://${url.host}${url.pathname.replace(/\/+$/, "")}/media`;
}

/** "CA…3f9a2c": enough to match log lines, never the full SID. */
export function shortSid(sid: string): string {
  return sid.length > 10 ? `${sid.slice(0, 2)}…${sid.slice(-6)}` : sid;
}

/**
 * Start capturing the customer's own voice for their AI Voice Twin, once they have answered a screened call. Touches
 * Twilio only when every gate passes, in this order:
 *  (a) the account holder consented (voice_twin_consent, with its consent_given_at recorded): THE CONSENT GATE →
 *      "no_consent";
 *  (b) the twin still needs audio (collecting, or failed so a retry has more to work with) → "not_needed";
 *  (c) the screened call (by its parent CallSid) exists and is live → "no_call";
 *  (d) a media bridge has a fresh heartbeat → "no_bridge".
 * The stream runs on the CHILD leg (the customer's) with track inbound_track only, and its token carries the
 * consent_given_at it was started under.
 */
export async function startVictimCapture(
  input: { parentCallSid: string; childCallSid: string },
  deps: CaptureDeps = liveCaptureDeps(),
): Promise<CaptureResult> {
  const twin = await deps.store.getTwin();
  // No consent timestamp, nothing to bind the stream to: treat it as no consent.
  if (!twin || twin.voice_twin_consent !== true || !twin.consent_given_at) return { started: false, reason: "no_consent" };
  const consentAt = twin.consent_given_at;
  if (twin.state !== "collecting" && twin.state !== "failed") return { started: false, reason: "not_needed" };

  const call = await deps.store.getCallByTwilioSid(input.parentCallSid);
  if (!call || call.status !== "live") return { started: false, reason: "no_call" };

  const now = deps.now();
  const bridge = await deps.store.getActiveBridge(now);
  const seenAt = bridge ? Date.parse(bridge.seenAt) : NaN;
  const url = bridge && Number.isFinite(seenAt) && now - seenAt < MEDIA_BRIDGE_FRESH_MS ? bridgeStreamUrl(bridge.publicUrl) : null;
  if (!url) return { started: false, reason: "no_bridge" };

  const token = streamToken(
    {
      callId: call.id,
      twinId: twin.id,
      childCallSid: input.childCallSid,
      consentAt,
      exp: Math.floor(now / 1000) + STREAM_TOKEN_TTL_SECONDS,
    },
    deps.secret(),
  );
  try {
    const stream = await deps.startStream(input.childCallSid, {
      url,
      name: VOICE_TWIN_STREAM_NAME,
      track: "inbound_track", // only what the customer says, never the caller
      parameters: { token },
    });
    return { started: true, streamSid: stream.sid };
  } catch (error) {
    // TwilioError messages carry the request path (account and call SIDs): log the status and code instead.
    const detail =
      error instanceof TwilioError
        ? `HTTP ${error.status}${error.code ? `, code ${error.code}` : ""}`
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : "unknown error";
    console.error(`voice twin capture ${shortSid(input.childCallSid)}: Twilio didn't start the stream (${detail})`);
    return { started: false, reason: "twilio_error" };
  }
}
