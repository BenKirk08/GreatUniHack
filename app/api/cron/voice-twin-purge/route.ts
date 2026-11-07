import { safeEqual } from "@/lib/auth";
import { json } from "@/lib/http";
import { voiceTwinHousekeeping } from "@/lib/voice-twin/service";

export const maxDuration = 60;

/** "Authorization: Bearer <CRON_SECRET>", compared in constant time. */
function hasCronSecret(authorization: string | null, secret: string): boolean {
  const token = authorization?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
  return token !== undefined && safeEqual(token, secret);
}

/**
 * Vercel Cron (daily, vercel.json): AI Voice Twin housekeeping. Retires voices 24 h after creation, retries ElevenLabs
 * voice deletions, discards audio from calls that ended unflagged and starts a clone that is due. A machine route (no
 * dashboard auth): when CRON_SECRET is set, Vercel sends it as a bearer token and it is required; without it the route
 * is open, which is safe because it only removes data already due for deletion and is idempotent. Responds with counts
 * only.
 */
export async function GET(req: Request) {
  const authorization = req.headers.get("authorization");
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && !hasCronSecret(authorization, secret)) return json({ ok: false, error: "Not authorised." }, 401);
  try {
    const summary = await voiceTwinHousekeeping();
    return json({
      ok: true,
      expired: summary.expired ? 1 : 0,
      voicesDeleted: summary.voicesDeleted,
      discardedChunks: summary.discardedChunks,
      clonesStarted: summary.clone && summary.clone.outcome !== "skipped" ? 1 : 0,
    });
  } catch (error) {
    console.error("voice twin purge failed", error);
    return json({ ok: false, error: "Housekeeping failed; the next run retries." }, 500);
  }
}
