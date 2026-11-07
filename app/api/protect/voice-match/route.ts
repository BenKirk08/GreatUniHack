import { z } from "zod";
import { AGE_BANDS, GENDERS } from "@/lib/ai-voices/config";
import { errorJson, json, parseJsonBody, requireCustomerAuth, requireCustomerRead } from "@/lib/http";
import { getVoiceMatchSetting, setVoiceMatchSetting } from "@/lib/settings";

const bodySchema = z
  .object({
    /** null clears it (Call Guard then works it out from the call, or uses the default). */
    ageBand: z.enum(AGE_BANDS).nullable(),
    gender: z.enum(GENDERS).nullable(),
  })
  .strict();

/** The customer's "Your AI voice match" (/protect/settings): their age band and gender, both optional. */
export async function GET(req: Request) {
  const denied = requireCustomerRead(req);
  if (denied) return denied;
  try {
    return json({ ok: true, setting: await getVoiceMatchSetting() });
  } catch (error) {
    console.error("protect voice-match: could not read", error);
    return errorJson(500, "Couldn't load your AI voice match. Please try again.");
  }
}

/** Save the customer's "Your AI voice match". Used for every later AI voice handover (customer or analyst). */
export async function POST(req: Request) {
  const denied = requireCustomerAuth(req);
  if (denied) return denied;
  const body = await parseJsonBody(req, bodySchema);
  if (!body.ok) return body.response;
  try {
    return json({ ok: true, setting: await setVoiceMatchSetting(body.data) });
  } catch (error) {
    console.error("protect voice-match: could not save", error);
    return errorJson(500, "Couldn't save your AI voice match. Please try again.");
  }
}
