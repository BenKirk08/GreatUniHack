import { after } from "next/server";
import { serverEnv } from "@/lib/env";
import { maskCaller } from "@/lib/normalise";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isWithheldCaller, screeningTwiml } from "@/lib/twilio";
import { readTwilioWebhook, voiceWebhookSchema } from "@/lib/twilio-webhooks";

export const maxDuration = 10;

/** Never let the database delay the call: answer with TwiML within this, whatever happens. */
const DB_BUDGET_MS = 600;

/**
 * Incoming call to TWILIO_PHONE_NUMBER. Creates the call row (status live, caller_masked, twilio_call_sid) and
 * returns the screening TwiML: transcribe both sides live, ring the customer's mobile, hang up afterwards.
 */
export async function POST(req: Request) {
  const started = performance.now();
  const webhook = await readTwilioWebhook(req, voiceWebhookSchema);
  if (!webhook.ok) {
    console.warn(`twilio voice rejected: ${webhook.reason}`);
    return new Response("Forbidden", { status: webhook.status });
  }
  const env = serverEnv();
  const { CallSid, From } = webhook.data;

  // Store only the masked caller; the full number is fetched from Twilio when a takeover needs it.
  const insert = supabaseAdmin()
    .from("calls")
    .upsert(
      {
        twilio_call_sid: CallSid,
        caller_masked: isWithheldCaller(From) ? "withheld" : maskCaller(From),
        direction: "inbound",
        status: "live",
        handoff_status: "none",
      },
      { onConflict: "twilio_call_sid", ignoreDuplicates: true },
    )
    .then(({ error }) => {
      if (error) console.error(`twilio voice ${CallSid}: could not create the call row`, error.message);
    });
  const timedOut = await Promise.race([insert.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), DB_BUDGET_MS))]);
  if (timedOut) {
    console.warn(`twilio voice ${CallSid}: call row still saving after ${DB_BUDGET_MS}ms; answering anyway`);
    after(async () => {
      await insert; // keep the function alive until the row is saved
    });
  }

  const twiml = screeningTwiml({
    publicBaseUrl: env.PUBLIC_BASE_URL!,
    from: From,
    twilioNumber: env.TWILIO_PHONE_NUMBER,
    customerNumber: env.CUSTOMER_PHONE_NUMBER,
  });
  console.info(`twilio voice ${CallSid}: screening ${isWithheldCaller(From) ? "withheld caller" : maskCaller(From)} in ${Math.round(performance.now() - started)}ms`);
  return new Response(twiml, { status: 200, headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" } });
}
