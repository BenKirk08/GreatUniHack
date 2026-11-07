import { after } from "next/server";
import { z } from "zod";
import { errorJson, json, parseJsonBody, requireCustomerAuth } from "@/lib/http";
import { NO_CONSENT_ERROR } from "@/lib/voice-twin/sample";
import { getCustomerTwinView, liveVoiceTwinDeps, maybeStartClone } from "@/lib/voice-twin/service";

/** The clone runs in after(), which has the route's full duration. */
export const maxDuration = 60;

const bodySchema = z.object({}).strict();

/** Settings' "Try again" after cloning failed: claim the twin again (failed → cloning) and clone in the background. */
export async function POST(req: Request) {
  const denied = requireCustomerAuth(req);
  if (denied) return denied;
  const body = await parseJsonBody(req, bodySchema);
  if (!body.ok) return body.response;
  try {
    const deps = liveVoiceTwinDeps();
    const twin = await getCustomerTwinView(deps);
    if (!twin.consent) return json({ ok: false, error: NO_CONSENT_ERROR, twin }, 403);
    after(async () => {
      try {
        const clone = await maybeStartClone({ allowFailed: true }, liveVoiceTwinDeps());
        console.info(`voice twin retry: clone ${clone.outcome}${"reason" in clone ? ` (${clone.reason})` : ""}`);
      } catch (error) {
        console.error("voice twin retry: cloning failed", error);
      }
    });
    return json({ ok: true, twin });
  } catch (error) {
    console.error("protect/voice-twin/retry failed", error);
    return errorJson(500, "Couldn't try again just now. Please try again in a moment.");
  }
}
