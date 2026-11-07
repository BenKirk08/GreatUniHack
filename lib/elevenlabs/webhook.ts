import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Verify an ElevenLabs post-call webhook signature.
 * Header `ElevenLabs-Signature: t=<unix seconds>,v0=<hex>` where hex = HMAC-SHA256(secret, `${t}.${rawBody}`).
 * The official SDKs reject timestamps older than 30 minutes; retries (up to ~40 min later) may reuse the
 * original signature, so we allow 60 minutes, and reject timestamps more than 5 minutes in the future.
 */
export function verifyElevenLabsSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string | null | undefined,
  opts: { nowMs?: number; toleranceSecs?: number; maxFutureSecs?: number } = {},
): { ok: true } | { ok: false; reason: string } {
  if (!secret) return { ok: false, reason: "webhook secret not configured" };
  if (!header) return { ok: false, reason: "missing ElevenLabs-Signature header" };

  const parts = header.split(",").map((p) => p.trim());
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const v0 = parts.find((p) => p.startsWith("v0="));
  if (!t || !/^\d+$/.test(t)) return { ok: false, reason: "missing or invalid timestamp" };
  if (!v0) return { ok: false, reason: "no v0 signature" };

  const now = opts.nowMs ?? Date.now();
  const ts = Number(t) * 1000;
  if (ts < now - (opts.toleranceSecs ?? 60 * 60) * 1000) return { ok: false, reason: "timestamp too old" };
  if (ts > now + (opts.maxFutureSecs ?? 5 * 60) * 1000) return { ok: false, reason: "timestamp in the future" };

  const expected = `v0=${createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex")}`;
  const a = Buffer.from(v0, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

/** Build a signature header (used by scripts/simulate-call.ts and tests). */
export function signElevenLabsPayload(rawBody: string, secret: string, timestampSecs = Math.floor(Date.now() / 1000)): string {
  const hex = createHmac("sha256", secret).update(`${timestampSecs}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestampSecs},v0=${hex}`;
}

/* ---------- payload schemas (validated after the signature check) ---------- */

const toolCallSchema = z
  .object({
    tool_name: z.string().nullish(),
    params_as_json: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish(),
  })
  .loose();

export const postCallTranscriptItemSchema = z
  .object({
    role: z.string(),
    message: z.string().nullish(),
    time_in_call_secs: z.number().nullish(),
    tool_calls: z.array(toolCallSchema).nullish(),
  })
  .loose();
export type PostCallTranscriptItem = z.infer<typeof postCallTranscriptItemSchema>;

const phoneCallSchema = z
  .object({
    type: z.string().nullish(),
    direction: z.enum(["inbound", "outbound"]).nullish(),
    external_number: z.string().nullish(),
    agent_number: z.string().nullish(),
    call_sid: z.string().nullish(),
  })
  .loose();

export const postCallTranscriptionSchema = z.object({
  type: z.literal("post_call_transcription"),
  event_timestamp: z.union([z.number(), z.string()]).optional(),
  data: z
    .object({
      agent_id: z.string().nullish(),
      conversation_id: z.string().min(1),
      status: z.string().nullish(),
      transcript: z.array(postCallTranscriptItemSchema).nullish(),
      metadata: z
        .object({
          start_time_unix_secs: z.number().nullish(),
          call_duration_secs: z.number().nullish(),
          phone_call: phoneCallSchema.nullish(),
        })
        .loose()
        .nullish(),
      conversation_initiation_client_data: z
        .object({ dynamic_variables: z.record(z.string(), z.unknown()).nullish() })
        .loose()
        .nullish(),
    })
    .loose(),
});
export type PostCallTranscription = z.infer<typeof postCallTranscriptionSchema>;

export const callInitiationFailureSchema = z.object({
  type: z.literal("call_initiation_failure"),
  event_timestamp: z.union([z.number(), z.string()]).optional(),
  data: z
    .object({
      agent_id: z.string().nullish(),
      conversation_id: z.string().min(1),
      failure_reason: z.string().nullish(),
    })
    .loose(),
});

export const webhookEnvelopeSchema = z.object({ type: z.string(), data: z.unknown() }).loose();
