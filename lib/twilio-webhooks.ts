import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { readSignedTwilioForm } from "@/lib/twilio";

/** Twilio CallSids: "CA" + 32 hex characters (simulations use "CAsim" + 30 hex). */
export const callSidSchema = z.string().regex(/^CA[0-9A-Za-z]{32,33}$/, "invalid CallSid");

/** POST /api/twilio/voice (incoming call). Twilio sends many more parameters; only these are used. */
export const voiceWebhookSchema = z.looseObject({
  CallSid: callSidSchema,
  AccountSid: z.string().min(1).max(64),
  From: z.string().max(64).optional().default(""),
  To: z.string().max(64).optional().default(""),
  CallStatus: z.string().max(32).optional(),
  Direction: z.string().max(32).optional(),
});

/** POST /api/twilio/transcription (Real-Time Transcription status callbacks). */
export const transcriptionWebhookSchema = z.looseObject({
  CallSid: callSidSchema,
  AccountSid: z.string().min(1).max(64),
  TranscriptionEvent: z.string().min(1).max(64),
  TranscriptionSid: z.string().max(64).optional(),
  Track: z.string().max(64).optional(),
  TranscriptionData: z.string().max(20_000).optional(),
  Final: z.enum(["true", "false"]).optional(),
  SequenceId: z.coerce.number().int().nonnegative().optional(),
  Timestamp: z.string().max(64).optional(),
  TranscriptionErrorCode: z.string().max(16).optional(),
  TranscriptionError: z.string().max(500).optional(),
});

/** POST /api/twilio/status (the number's call status callback). */
export const statusWebhookSchema = z.looseObject({
  CallSid: callSidSchema,
  AccountSid: z.string().min(1).max(64),
  CallStatus: z.string().min(1).max(32),
  CallDuration: z.coerce.number().int().nonnegative().optional(),
});

/**
 * POST /api/twilio/dial-status (the <Number> statusCallback, "answered" only). CallSid is the customer's CHILD leg;
 * ParentCallSid is the screened call (calls.twilio_call_sid).
 */
export const dialStatusWebhookSchema = z.looseObject({
  CallSid: callSidSchema,
  ParentCallSid: callSidSchema,
  AccountSid: z.string().min(1).max(64),
  CallStatus: z.string().min(1).max(32),
  Direction: z.string().max(32).optional(),
  CallbackSource: z.string().max(64).optional(),
});

/**
 * Verify X-Twilio-Signature with TWILIO_AUTH_TOKEN against PUBLIC_BASE_URL + path + query, then validate the
 * parameters with zod and check they are for our account.
 */
export async function readTwilioWebhook<T extends z.ZodType>(
  req: Request,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; status: number; reason: string }> {
  const env = serverEnv();
  if (!env.PUBLIC_BASE_URL) return { ok: false, status: 503, reason: "PUBLIC_BASE_URL is not set" };
  const signed = await readSignedTwilioForm(req, { authToken: env.TWILIO_AUTH_TOKEN, publicBaseUrl: env.PUBLIC_BASE_URL });
  if (!signed.ok) return { ok: false, status: 403, reason: signed.reason };
  const parsed = schema.safeParse(Object.fromEntries(signed.params));
  if (!parsed.success) {
    return { ok: false, status: 400, reason: `invalid parameters: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}` };
  }
  if ((parsed.data as { AccountSid: string }).AccountSid !== env.TWILIO_ACCOUNT_SID) {
    return { ok: false, status: 403, reason: "AccountSid does not match" };
  }
  return { ok: true, data: parsed.data };
}

/** Empty 204: what Twilio expects from status callbacks. */
export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
