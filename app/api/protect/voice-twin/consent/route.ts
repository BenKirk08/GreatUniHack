import { z } from "zod";
import { errorJson, json, parseJsonBody, requireCustomerAuth } from "@/lib/http";
import { getCustomerTwinView, giveConsent, liveVoiceTwinDeps } from "@/lib/voice-twin/service";

/** The box must have been ticked: only `true` is accepted. */
const bodySchema = z.object({ agree: z.literal(true) }).strict();

/**
 * The account holder's AI Voice Twin consent, given in Settings after ticking the (unticked) consent box. Who and
 * when are recorded with the consent; nothing is recorded before this.
 */
export async function POST(req: Request) {
  const denied = requireCustomerAuth(req);
  if (denied) return denied;
  const body = await parseJsonBody(req, bodySchema);
  if (!body.ok) return body.response;
  try {
    const deps = liveVoiceTwinDeps();
    await giveConsent({ userAgent: req.headers.get("user-agent") }, deps);
    return json({ ok: true, twin: await getCustomerTwinView(deps) });
  } catch (error) {
    console.error("protect/voice-twin/consent failed", error);
    return errorJson(500, "Couldn't save your consent. Please try again.");
  }
}
