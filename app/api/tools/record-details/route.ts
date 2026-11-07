import { after } from "next/server";
import { checkToolSecret } from "@/lib/auth";
import { parseConversationHistory } from "@/lib/elevenlabs/history";
import { serverEnv } from "@/lib/env";
import { errorJson, json } from "@/lib/http";
import { cleanToolFields, processIntel } from "@/lib/intel";
import { linkPersonaSnapshot } from "@/lib/pipeline";
import { combinedTranscript } from "@/lib/transcript";
import { northgateCallIdFrom, recordDetailsSchema } from "@/lib/validation";

export const maxDuration = 60;

/**
 * ElevenLabs webhook tool `record_details`. The takeover persona calls it mid-call whenever it learns something new.
 * The call is found by northgate_call_id (our calls.id, a dynamic variable set at register-call); the persona's
 * conversation is linked to it. Responds `{ ok: true }` straight away; storing and running Claude happen afterwards.
 */
export async function POST(req: Request) {
  const env = serverEnv();
  if (!checkToolSecret(req.headers.get("x-tool-secret"), env.TOOL_SECRET)) {
    return errorJson(401, "Invalid tool secret.");
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorJson(400, "Body must be JSON.");
  }
  const parsed = recordDetailsSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn("record-details: invalid body", parsed.error.issues.map((i) => i.path.join(".")).join(", "));
    return errorJson(400, "Invalid body.");
  }

  const body = parsed.data;
  const toolFields = cleanToolFields(body);
  const callId = northgateCallIdFrom(body.northgate_call_id);
  if (!callId) {
    // Not one of our takeovers (e.g. a test chat in the ElevenLabs UI). Keep the agent happy and store nothing.
    console.warn(`record-details ${body.conversation_id}: no northgate_call_id; ignored`);
    return json({ ok: true });
  }
  const transcript = parseConversationHistory(body.conversation_history);

  after(async () => {
    try {
      const call = await linkPersonaSnapshot({ callId, conversationId: body.conversation_id, transcript, notes: toolFields });
      if (!call) {
        console.warn(`record-details ${body.conversation_id}: no call ${callId}; ignored`);
        return;
      }
      const result = await processIntel(call.id, combinedTranscript(call), toolFields);
      console.info(
        `record-details ${call.id} (${body.conversation_id}): ${transcript.length} persona turns, intel ${
          result.saved ? "saved" : `skipped (${result.reason})`
        }${result.muleMatch ? `, mule check: ${result.muleMatch.status}` : ""}`,
      );
    } catch (error) {
      console.error(`record-details ${callId} background work failed`, error);
    }
  });

  return json({ ok: true });
}
