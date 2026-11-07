/**
 * Recovery: end a call and (re)build its report, e.g. when a post-call webhook never arrived for a taken-over call.
 * Auto-sends it if auto-send is on (otherwise it waits as a draft for Approve & Send).
 *   npx tsx scripts/regenerate-report.ts <call id | Twilio CallSid | ElevenLabs conversation_id>
 */
import "./lib/load-env";
import { finishCall } from "../lib/pipeline";
import { supabaseAdmin } from "../lib/supabase/admin";
import type { CallRow } from "../lib/types";

async function main() {
  const key = process.argv[2];
  if (!key) throw new Error("Usage: npx tsx scripts/regenerate-report.ts <call id | CallSid | conversation_id>");
  const db = supabaseAdmin();
  const column = /^[0-9a-f-]{36}$/i.test(key) ? "id" : key.startsWith("CA") ? "twilio_call_sid" : "conversation_id";
  const { data: call, error } = await db.from("calls").select("*").eq(column, key).maybeSingle<CallRow>();
  if (error || !call) throw new Error(`Call ${key} not found`);
  // Taken-over calls always get a report; screened-only calls only when the risk reached the threshold.
  const result = await finishCall({ callId: call.id, requireThreshold: call.handoff_status !== "connected" });
  console.log(
    `call ${call.id}: report ${result.report?.id ?? "none"} ${result.report?.status ?? ""}${result.autoSent ? " (auto-sent)" : ""}${
      result.skippedReason ? ` — ${result.skippedReason}` : ""
    }`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
