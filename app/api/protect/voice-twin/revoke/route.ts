import { after } from "next/server";
import { z } from "zod";
import { errorJson, json, parseJsonBody, requireCustomerAuth } from "@/lib/http";
import { getCustomerTwinView, liveVoiceTwinDeps, revokeAndDelete, sweepAfterRevoke } from "@/lib/voice-twin/service";

export const maxDuration = 60;

const bodySchema = z.object({}).strict();

/** Revoke & delete: consent off, every recording deleted and the cloned voice deleted at ElevenLabs. */
export async function POST(req: Request) {
  const denied = requireCustomerAuth(req);
  if (denied) return denied;
  const body = await parseJsonBody(req, bodySchema);
  if (!body.ok) return body.response;
  try {
    const deps = liveVoiceTwinDeps();
    // The orphan-voice sweep (an ElevenLabs search) runs after the response, so the customer doesn't wait for it.
    const before = await deps.store.getTwin();
    const result = await revokeAndDelete({ userAgent: req.headers.get("user-agent") }, deps, { sweepOrphans: false });
    if (before) {
      after(async () => {
        const swept = await sweepAfterRevoke(before.id, before.voice_id, liveVoiceTwinDeps());
        if (swept) console.info(`voice twin revoke: deleted ${swept} orphaned clone(s)`);
      });
    }
    return json({ ok: true, twin: await getCustomerTwinView(deps), result });
  } catch (error) {
    console.error("protect/voice-twin/revoke failed", error);
    return errorJson(500, "Couldn't revoke your consent. Please try again.");
  }
}
