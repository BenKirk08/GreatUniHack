import { sendReport } from "@/lib/email";
import { serverEnv } from "@/lib/env";
import { processIntel } from "@/lib/intel";
import { generateReport } from "@/lib/report";
import { getAutoSend } from "@/lib/settings";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { combinedTranscript } from "@/lib/transcript";
import type { CallRow, ReportRow, ToolFields, TranscriptTurn } from "@/lib/types";

/**
 * Link the persona's ElevenLabs conversation to the call (atomic; see link_persona_snapshot): sets conversation_id
 * once, keeps the longest persona transcript, merges the persona's notes.
 */
export async function linkPersonaSnapshot(input: {
  callId: string;
  conversationId: string | null;
  transcript: TranscriptTurn[];
  notes?: ToolFields;
}): Promise<CallRow | null> {
  const { data, error } = await supabaseAdmin().rpc("link_persona_snapshot", {
    p_call_id: input.callId,
    p_conversation_id: input.conversationId,
    p_transcript: input.transcript,
    p_notes: input.notes ?? {},
  });
  if (error) throw new Error(`link_persona_snapshot failed: ${error.message}`);
  return ((Array.isArray(data) ? data : data ? [data] : []) as CallRow[])[0] ?? null;
}

export interface FinishCallInput {
  callId: string;
  /** Post-call webhook: the persona's conversation. */
  conversationId?: string | null;
  personaTranscript?: TranscriptTurn[];
  toolFields?: ToolFields;
  endedAt?: Date;
  /** Status-callback path (no takeover): only write a report when the peak risk reached the threshold. */
  requireThreshold?: boolean;
  /** When the request arrived (for the 60 s budget). */
  startedWorkAt?: number;
}

export interface CallEndedResult {
  callId: string;
  report: ReportRow | null;
  autoSent: boolean;
  skippedReason?: string;
}

/**
 * Everything that happens when a call ends: store the persona transcript (if there was a takeover), mark the call
 * ended, run the final processIntel over the screening + persona transcript, generate the report, and auto-send it
 * if that mode is on. Safe to run twice (webhook retries): a call that already has a report is left alone.
 */
export async function finishCall(input: FinishCallInput): Promise<CallEndedResult> {
  const db = supabaseAdmin();

  if (input.conversationId || input.personaTranscript?.length || (input.toolFields && Object.keys(input.toolFields).length)) {
    await linkPersonaSnapshot({
      callId: input.callId,
      conversationId: input.conversationId ?? null,
      transcript: input.personaTranscript ?? [],
      notes: input.toolFields,
    });
  }

  const existing = await db.from("reports").select("*").eq("call_id", input.callId).maybeSingle<ReportRow>();
  if (existing.error) throw new Error(`finishCall: ${existing.error.message}`);

  // End the call once (keep the first ended_at if a retry or the other path got here first).
  const { error: endError } = await db
    .from("calls")
    .update({ status: "ended", ended_at: (input.endedAt ?? new Date()).toISOString() })
    .eq("id", input.callId)
    .eq("status", "live");
  if (endError) throw new Error(`finishCall: could not mark ended: ${endError.message}`);

  const { data: call, error: loadError } = await db.from("calls").select("*").eq("id", input.callId).single<CallRow>();
  if (loadError || !call) throw new Error(`finishCall: call ${input.callId} not found: ${loadError?.message}`);

  if (existing.data) {
    // Redelivery: the report exists. If auto-send is on and it never went out, try again.
    if (existing.data.status === "draft" && (await getAutoSend())) {
      const sent = await sendReport(existing.data.id);
      return { callId: call.id, report: sent, autoSent: true, skippedReason: "report already existed; sent on redelivery" };
    }
    return { callId: call.id, report: existing.data, autoSent: false, skippedReason: "report already exists (retry)" };
  }

  const threshold = serverEnv().RISK_THRESHOLD;
  if (input.requireThreshold && (call.risk?.peak ?? 0) < threshold) {
    return { callId: call.id, report: null, autoSent: false, skippedReason: `peak risk ${call.risk?.peak ?? 0} stayed below ${threshold}; no report` };
  }

  const transcript = combinedTranscript(call);
  if (!transcript.some((t) => t.role === "scammer" && t.message.trim())) {
    return { callId: call.id, report: null, autoSent: false, skippedReason: "no caller speech; no report generated" };
  }

  // The routes have maxDuration = 60 s for all of this, so every Claude call gets a slice of the budget.
  const deadline = (input.startedWorkAt ?? Date.now()) + 55_000;
  const remaining = () => deadline - Date.now();

  // Final intel pass. If it fails (timeout, refusal, API error) the report is still written from the intel
  // gathered during the call rather than lost.
  try {
    await processIntel(call.id, transcript, input.toolFields, { timeoutMs: 18_000, maxRetries: 0 });
  } catch (error) {
    console.error(`final processIntel failed for ${call.id}; continuing with stored intel`, error);
  }

  let report: ReportRow;
  try {
    report = await generateReport(call.id, { timeoutMs: Math.max(10_000, Math.min(35_000, remaining() - 4_000)), maxRetries: 0 });
  } catch (error) {
    if (remaining() < 20_000) throw error;
    console.warn(`generateReport failed for ${call.id}; retrying once`, error);
    report = await generateReport(call.id, { timeoutMs: remaining() - 4_000, maxRetries: 0 });
  }
  if (report.status === "sent") return { callId: call.id, report, autoSent: false };

  if (await getAutoSend()) {
    const sent = await sendReport(report.id);
    return { callId: call.id, report: sent, autoSent: true };
  }
  return { callId: call.id, report, autoSent: false };
}

/** Find the call for an ElevenLabs conversation: northgate_call_id (dynamic variable) first, else conversation_id. */
export async function findCallForConversation(northgateCallId: string | null, conversationId: string | null): Promise<CallRow | null> {
  const db = supabaseAdmin();
  if (northgateCallId) {
    const { data, error } = await db.from("calls").select("*").eq("id", northgateCallId).maybeSingle<CallRow>();
    if (error) throw new Error(`findCallForConversation: ${error.message}`);
    if (data) return data;
  }
  if (conversationId) {
    const { data, error } = await db.from("calls").select("*").eq("conversation_id", conversationId).maybeSingle<CallRow>();
    if (error) throw new Error(`findCallForConversation: ${error.message}`);
    if (data) return data;
  }
  return null;
}
