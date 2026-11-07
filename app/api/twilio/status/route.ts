import { after } from "next/server";
import { finishCall } from "@/lib/pipeline";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { TERMINAL_CALL_STATUSES } from "@/lib/twilio";
import { noContent, readTwilioWebhook, statusWebhookSchema } from "@/lib/twilio-webhooks";
import type { CallRow } from "@/lib/types";
import { discardUnflaggedCallAudio } from "@/lib/voice-twin/service";

export const maxDuration = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The number's status callback (sent once, when the call ends). If Northgate took the call over, the persona's (or the
 * AI Voice Twin's) post-call webhook finishes it. Otherwise mark the call ended and, if the peak risk reached the
 * threshold, run the final processIntel and generateReport (auto-sent per the setting). Either way, AI Voice Twin audio
 * captured during a call that was never flagged is discarded (the consent covers flagged calls only).
 */
export async function POST(req: Request) {
  const receivedAt = Date.now();
  const webhook = await readTwilioWebhook(req, statusWebhookSchema);
  if (!webhook.ok) {
    console.warn(`twilio status rejected: ${webhook.reason}`);
    return new Response("Forbidden", { status: webhook.status });
  }
  const { CallSid, CallStatus } = webhook.data;
  if (!(TERMINAL_CALL_STATUSES as readonly string[]).includes(CallStatus)) return noContent();

  after(async () => {
    try {
      const db = supabaseAdmin();
      const load = async () => (await db.from("calls").select("*").eq("twilio_call_sid", CallSid).maybeSingle<CallRow>()).data;
      let call = await load();
      if (!call) {
        console.warn(`twilio status ${CallSid} (${CallStatus}): no call row`);
        return;
      }
      // A takeover in flight decides who finishes the call: give it a few seconds to land.
      for (let i = 0; i < 8 && call?.handoff_status === "requested"; i++) {
        await sleep(1000);
        call = (await load()) ?? call;
      }
      if (call.handoff_status === "connected") {
        const by = call.takeover_kind === "voice_twin" ? "the AI Voice Twin" : call.persona;
        console.info(`twilio status ${CallSid} (${CallStatus}): taken over by ${by}; the post-call webhook finishes it`);
        // Twilio says the call is over, so record that now rather than waiting for the post-call webhook: a lost or
        // failed webhook must not leave the call 'live' for ever (that would hold off the AI Voice Twin's 24 h deletion).
        // Only status/ended_at: the webhook still links the transcript and writes the report (finishCall keeps the
        // first ended_at, and link_persona_snapshot filters on handoff_status, not status).
        const { error: endError } = await db
          .from("calls")
          .update({ status: "ended", ended_at: new Date().toISOString() })
          .eq("id", call.id)
          .eq("status", "live");
        if (endError) console.error(`twilio status ${CallSid}: could not mark the taken-over call ended`, endError.message);
        await discardTwinAudio(call.id, CallSid);
        return;
      }
      try {
        const result = await finishCall({ callId: call.id, requireThreshold: true, startedWorkAt: receivedAt });
        console.info(
          `twilio status ${CallSid} (${CallStatus}): ended; report ${result.report?.id ?? "none"}${result.autoSent ? " auto-sent" : ""}${
            result.skippedReason ? ` (${result.skippedReason})` : ""
          }`,
        );
      } finally {
        // After finishCall has marked the call ended (an unflagged call's audio can only be discarded once it is).
        await discardTwinAudio(call.id, CallSid);
      }
    } catch (error) {
      console.error(`twilio status ${CallSid} failed`, error);
    }
  });
  return noContent();
}

/** Drop AI Voice Twin audio from a call that ended unflagged (a flagged or still-live call keeps it). Never throws. */
async function discardTwinAudio(callId: string, callSid: string): Promise<void> {
  try {
    const discarded = await discardUnflaggedCallAudio(callId);
    if (discarded) console.info(`twilio status ${callSid}: discarded ${discarded} AI Voice Twin audio chunk(s) from an unflagged call`);
  } catch (error) {
    console.error(`twilio status ${callSid}: discarding AI Voice Twin audio failed (housekeeping retries)`, error);
  }
}
