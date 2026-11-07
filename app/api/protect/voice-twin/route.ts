import { errorJson, json, requireCustomerRead } from "@/lib/http";
import { getCustomerTwinView } from "@/lib/voice-twin/service";

/** The customer's AI Voice Twin as /protect and Settings see it (consent, state, progress; never the voice ID). */
export async function GET(req: Request) {
  const denied = requireCustomerRead(req);
  if (denied) return denied;
  try {
    return json({ ok: true, twin: await getCustomerTwinView() });
  } catch (error) {
    console.error("protect/voice-twin failed", error);
    return errorJson(500, "Couldn't load your AI Voice Twin. Please try again.");
  }
}
