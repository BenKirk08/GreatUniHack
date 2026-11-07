import { after } from "next/server";
import { z } from "zod";
import { errorJson, json, parseJsonBody, requireCustomerAuth } from "@/lib/http";
import { acceptSampleChunk, SAMPLE_CHUNK_MAX_BASE64, SAMPLE_MAX_SEQ } from "@/lib/voice-twin/sample";
import { liveVoiceTwinDeps, maybeStartClone } from "@/lib/voice-twin/service";

/** The last chunk may start the clone in after(), which has the route's full duration. */
export const maxDuration = 60;

const bodySchema = z
  .object({
    sessionId: z.uuid(),
    seq: z.number().int().min(0).max(SAMPLE_MAX_SEQ),
    final: z.boolean(),
    /** A PCM16 mono WAV (≤ 1.5 MB decoded). */
    audioBase64: z.string().min(1).max(SAMPLE_CHUNK_MAX_BASE64),
    /** The consentGivenAt the recording started under (chunks are refused if consent changed since). */
    consentAt: z.string().max(64).nullable().optional(),
  })
  .strict();

/**
 * One chunk of "Record a sample now" from Settings. Refused (403, nothing stored) without consent; the clean speech
 * is re-counted here, never taken from the browser. The session's final chunk starts cloning once there's enough.
 */
export async function POST(req: Request) {
  const denied = requireCustomerAuth(req);
  if (denied) return denied;
  const body = await parseJsonBody(req, bodySchema);
  if (!body.ok) return body.response;

  try {
    const deps = liveVoiceTwinDeps();
    const outcome = await acceptSampleChunk(body.data, deps);
    if (outcome.startClone) {
      after(async () => {
        try {
          // A sample the customer chose to record after a failed clone is a deliberate retry (live calls never retry).
          const clone = await maybeStartClone({ allowFailed: true }, liveVoiceTwinDeps());
          console.info(`voice twin sample ${body.data.sessionId}: clone ${clone.outcome}${"reason" in clone ? ` (${clone.reason})` : ""}`);
        } catch (error) {
          console.error(`voice twin sample ${body.data.sessionId}: starting the clone failed`, error);
        }
      });
    }
    return json(outcome.body, outcome.status);
  } catch (error) {
    console.error(`protect/voice-twin/sample ${body.data.sessionId}#${body.data.seq} failed`, error);
    return errorJson(500, "Couldn't save that part of your recording. Please try again.");
  }
}
