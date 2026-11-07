import { after } from "next/server";
import { toolFieldsFromPostCall, transcriptFromPostCall } from "@/lib/elevenlabs/history";
import {
  callInitiationFailureSchema,
  postCallTranscriptionSchema,
  verifyElevenLabsSignature,
  webhookEnvelopeSchema,
} from "@/lib/elevenlabs/webhook";
import { serverEnv } from "@/lib/env";
import { errorJson, json } from "@/lib/http";
import { findCallForConversation, finishCall } from "@/lib/pipeline";
import { northgateCallIdFrom } from "@/lib/validation";

export const maxDuration = 60;

/**
 * ElevenLabs post-call webhook for takeover conversations. Verifies the HMAC signature against the raw body, finds
 * the call by northgate_call_id (data.conversation_initiation_client_data.dynamic_variables) or, failing that, by
 * conversation_id, responds 200 at once, then (in after()) stores the persona transcript, ends the call, runs the
 * final processIntel over the screening + persona transcript, writes the report and auto-sends it when that mode is on.
 */
export async function POST(req: Request) {
  const receivedAt = Date.now();
  const env = serverEnv();
  const rawBody = await req.text();

  if (!env.ELEVENLABS_WEBHOOK_SECRET) {
    console.error("ELEVENLABS_WEBHOOK_SECRET is not set; rejecting webhook");
    return errorJson(503, "Webhook secret not configured.");
  }
  const verified = verifyElevenLabsSignature(rawBody, req.headers.get("elevenlabs-signature"), env.ELEVENLABS_WEBHOOK_SECRET);
  if (!verified.ok) {
    console.warn(`elevenlabs webhook rejected: ${verified.reason}`);
    return errorJson(401, "Invalid signature.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return errorJson(400, "Body must be JSON.");
  }
  const envelope = webhookEnvelopeSchema.safeParse(payload);
  if (!envelope.success) return errorJson(400, "Unrecognised webhook payload.");

  if (envelope.data.type === "post_call_transcription") {
    const event = postCallTranscriptionSchema.safeParse(payload);
    if (!event.success) {
      console.error("post_call_transcription failed validation", event.error.issues.slice(0, 5));
      return errorJson(400, "Invalid post_call_transcription payload.");
    }
    const data = event.data.data;
    const meta = data.metadata;
    const northgateCallId = northgateCallIdFrom(data.conversation_initiation_client_data?.dynamic_variables?.northgate_call_id);
    if (env.ELEVENLABS_AGENT_ID && data.agent_id && data.agent_id !== env.ELEVENLABS_AGENT_ID) {
      console.warn(`post-call ${data.conversation_id}: agent ${data.agent_id} is not the takeover agent; ignored`);
      return json({ received: true, ignored: "other agent" });
    }
    const call = await findCallForConversation(northgateCallId, data.conversation_id);
    if (!call) {
      console.warn(`post-call ${data.conversation_id}: no linked call (northgate_call_id ${northgateCallId ?? "missing"}); ignored`);
      return json({ received: true, ignored: "no linked call" });
    }
    if (!["requested", "connected", "failed"].includes(call.handoff_status)) {
      console.warn(`post-call ${data.conversation_id}: call ${call.id} was never handed over (${call.handoff_status}); ignored`);
      return json({ received: true, ignored: "call was not handed over" });
    }
    const reportedSid = meta?.phone_call?.call_sid;
    if (reportedSid && call.twilio_call_sid && reportedSid !== call.twilio_call_sid) {
      console.warn(`post-call ${data.conversation_id}: CallSid ${reportedSid} doesn't match call ${call.id}; ignored`);
      return json({ received: true, ignored: "CallSid mismatch" });
    }
    const startedAt = typeof meta?.start_time_unix_secs === "number" ? new Date(meta.start_time_unix_secs * 1000) : undefined;
    const endedAt =
      startedAt && typeof meta?.call_duration_secs === "number"
        ? new Date(startedAt.getTime() + meta.call_duration_secs * 1000)
        : new Date();

    after(async () => {
      try {
        const result = await finishCall({
          callId: call.id,
          conversationId: data.conversation_id,
          personaTranscript: transcriptFromPostCall(data.transcript),
          toolFields: toolFieldsFromPostCall(data.transcript),
          endedAt,
          startedWorkAt: receivedAt,
        });
        console.info(
          `post-call ${call.id} (${data.conversation_id}): report ${result.report?.id ?? "none"} ${
            result.autoSent ? "auto-sent" : (result.report?.status ?? "")
          }${result.skippedReason ? ` (${result.skippedReason})` : ""}`,
        );
      } catch (error) {
        console.error(`post-call ${call.id} processing failed`, error);
      }
    });
    return json({ received: true, call_id: call.id });
  }

  if (envelope.data.type === "call_initiation_failure") {
    // The persona never connected (e.g. the media stream failed after the takeover). End the call like a
    // non-takeover call: report only if the screening risk reached the threshold.
    const event = callInitiationFailureSchema.safeParse(payload);
    if (!event.success) return errorJson(400, "Invalid call_initiation_failure payload.");
    const { conversation_id, failure_reason } = event.data.data;
    const vars = (event.data.data as { conversation_initiation_client_data?: { dynamic_variables?: Record<string, unknown> } })
      .conversation_initiation_client_data?.dynamic_variables;
    const call = await findCallForConversation(northgateCallIdFrom(vars?.northgate_call_id), conversation_id);
    if (!call) return json({ received: true, ignored: "no linked call" });
    console.warn(`call_initiation_failure for call ${call.id} (${conversation_id}): ${failure_reason ?? "unknown"}`);
    after(async () => {
      try {
        await finishCall({ callId: call.id, conversationId: conversation_id, requireThreshold: true, startedWorkAt: receivedAt });
      } catch (error) {
        console.error(`call_initiation_failure ${call.id} failed`, error);
      }
    });
    return json({ received: true, call_id: call.id });
  }

  // post_call_audio and anything else: acknowledge and ignore.
  return json({ received: true, ignored: envelope.data.type });
}
