import { after } from "next/server";
import { CUSTOMER_COLUMNS, customerCall, pickCustomerCall, type CustomerCall } from "@/lib/customer-view";
import { errorJson, json, requireCustomerRead } from "@/lib/http";
import { getVoiceMatchSetting } from "@/lib/settings";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { EMPTY_VOICE_MATCH_SETTING, type VoiceMatchSetting } from "@/lib/voice-match";
import { voiceTwinSettings } from "@/lib/voice-twin/config";
import { getCustomerTwinView, voiceTwinHousekeeping } from "@/lib/voice-twin/service";
import { customerTwinView, type CustomerTwinView } from "@/lib/voice-twin/view";

/** Room for housekeeping in after(): it may start a due clone (ElevenLabs allows it up to 45 s). */
export const maxDuration = 60;

/** Lazy AI Voice Twin housekeeping runs at most this often per server instance (the cron and the bridge also run it). */
const HOUSEKEEPING_EVERY_MS = 30_000;
let lastHousekeepingAt = 0;

/** The twin's view for the page. A twin problem never breaks /protect: it then reads as "no twin" and is logged. */
async function twinView(): Promise<CustomerTwinView> {
  try {
    return await getCustomerTwinView();
  } catch (error) {
    console.error("protect state: could not load the AI Voice Twin", error);
    return customerTwinView(null, voiceTwinSettings(), Date.now());
  }
}

/** The customer's AI voice match for the main screen's card. A problem reads as "not set" (and is logged). */
async function voiceMatch(): Promise<VoiceMatchSetting> {
  try {
    return await getVoiceMatchSetting();
  } catch (error) {
    console.error("protect state: could not load the AI voice match", error);
    return EMPTY_VOICE_MATCH_SETTING;
  }
}

/**
 * The call the customer's /protect page shows, as a narrow projection, their AI Voice Twin and their AI voice match
 * setting (customer cookie).
 */
export async function GET(req: Request) {
  const denied = requireCustomerRead(req);
  if (denied) return denied;

  if (Date.now() - lastHousekeepingAt >= HOUSEKEEPING_EVERY_MS) {
    lastHousekeepingAt = Date.now();
    after(async () => {
      try {
        await voiceTwinHousekeeping();
      } catch (error) {
        console.error("protect state: AI Voice Twin housekeeping failed", error);
      }
    });
  }

  const db = supabaseAdmin();
  const [live, newest, twin, match] = await Promise.all([
    db.from("calls").select(CUSTOMER_COLUMNS).eq("status", "live").order("started_at", { ascending: false }).limit(10),
    db.from("calls").select(CUSTOMER_COLUMNS).order("started_at", { ascending: false }).limit(1),
    twinView(),
    voiceMatch(),
  ]);
  if (live.error || newest.error) return errorJson(500, "Could not load your calls.");
  const rows = (live.data ?? []) as unknown as CustomerCall[];
  const latest = ((newest.data ?? []) as unknown as CustomerCall[])[0] ?? null;
  return json({ ok: true, call: customerCall(pickCustomerCall(rows, latest) as never), twin, voiceMatch: match });
}
