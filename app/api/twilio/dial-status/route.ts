import { after } from "next/server";
import { dialStatusWebhookSchema, noContent, readTwilioWebhook } from "@/lib/twilio-webhooks";
import { shortSid, startVictimCapture } from "@/lib/voice-twin/capture";

export const maxDuration = 30;

/**
 * The customer's leg status callback (<Number statusCallbackEvent="answered"> in the screening TwiML). Always answers
 * 204 straight away: it must never affect the call. Once the customer has answered, the AI Voice Twin capture may start
 * on their own leg; startVictimCapture checks consent first, then the twin's state, the live call and the media bridge.
 */
export async function POST(req: Request) {
  try {
    const webhook = await readTwilioWebhook(req, dialStatusWebhookSchema);
    if (!webhook.ok) {
      console.warn(`twilio dial-status rejected: ${webhook.reason}`);
      return noContent();
    }
    const { CallSid, ParentCallSid, CallStatus } = webhook.data;
    if (CallStatus !== "in-progress") return noContent();

    after(async () => {
      const label = `twilio dial-status ${shortSid(ParentCallSid)} → ${shortSid(CallSid)}`;
      try {
        const result = await startVictimCapture({ parentCallSid: ParentCallSid, childCallSid: CallSid });
        if (result.started) {
          console.info(`${label}: AI Voice Twin capture started on the customer's leg (stream ${shortSid(result.streamSid)})`);
        } else {
          console.info(`${label}: no AI Voice Twin capture (${result.reason})`);
        }
      } catch (error) {
        console.error(`${label}: AI Voice Twin capture check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  } catch (error) {
    console.error(`twilio dial-status failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return noContent();
}
