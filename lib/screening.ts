import { serverEnv } from "@/lib/env";
import { processIntel } from "@/lib/intel";
import { sendOfferPush } from "@/lib/push";
import { buildRisk, scoreWithClaude, scoringDecision, type ClaudeRiskScore } from "@/lib/risk";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { combinedTranscript } from "@/lib/transcript";
import type { CallRisk, CallRow, ScreeningSegment } from "@/lib/types";
import { getCustomerTwinView } from "@/lib/voice-twin/service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Live processIntel on the screening transcript runs at most this often per call. */
export const LIVE_INTEL_INTERVAL_MS = 20_000;

async function loadCall(callId: string): Promise<CallRow | null> {
  const { data } = await supabaseAdmin().from("calls").select("*").eq("id", callId).maybeSingle<CallRow>();
  return data ?? null;
}

function screeningActive(call: CallRow): boolean {
  return call.status === "live" && call.handoff_status !== "requested" && call.handoff_status !== "connected";
}

/**
 * Everything one final transcription segment triggers (run inside after()): append it (atomically, sorted, deduped),
 * score the call when the rules say so, offer the takeover when the peak first crosses the threshold, and refresh
 * the live intel card at most every 20 seconds.
 */
export async function handleFinalSegment(callSid: string, segment: ScreeningSegment): Promise<void> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("append_screening_segment", { p_call_sid: callSid, p_segment: segment });
  if (error) throw new Error(`append_screening_segment failed: ${error.message}`);
  const call = ((Array.isArray(data) ? data : data ? [data] : []) as CallRow[])[0];
  if (!call) return; // unknown call, a Twilio retry, or the takeover is under way
  if (!screeningActive(call)) return;

  await maybeScore(call);
  await maybeRunLiveIntel(call.id);
}

/**
 * Score now if 2+ new caller segments arrived or 10 s passed with any new segment. Otherwise, if segments are
 * waiting, check again when the 10 s are up, unless a newer segment arrives first (its own run takes over).
 */
async function maybeScore(call: CallRow, retry = false): Promise<void> {
  const decision = scoringDecision(call.screening_transcript, call.risk, call.started_at, Date.now());
  if (decision.score) {
    await scoreAndSave(call);
    return;
  }
  if (retry || decision.waitMs <= 0) return;
  await sleep(Math.min(decision.waitMs + 250, 11_000));
  const fresh = await loadCall(call.id);
  if (!fresh || !screeningActive(fresh)) return;
  if (fresh.screening_transcript.length !== call.screening_transcript.length) return; // a newer segment's run owns it
  await maybeScore(fresh, true);
}

export async function scoreAndSave(call: CallRow): Promise<{ risk: CallRisk; saved: boolean; offered: boolean }> {
  const env = serverEnv();
  const segments = call.screening_transcript;
  let claude: ClaudeRiskScore | null = null;
  try {
    claude = await scoreWithClaude(segments);
  } catch (error) {
    console.error(`risk: Claude scoring failed for ${call.id}; using the keyword floor`, error);
  }
  const risk = buildRisk(segments, claude, call.risk);
  const { data, error } = await supabaseAdmin().rpc("record_risk_score", {
    p_call_id: call.id,
    p_risk: risk,
    p_threshold: env.RISK_THRESHOLD,
  });
  if (error) throw new Error(`record_risk_score failed: ${error.message}`);
  const result = (data ?? {}) as { saved?: boolean; offered?: boolean; reason?: string; peak?: number };
  console.info(
    `risk ${call.id}: score ${risk.score} (floor ${risk.keyword_floor}, ${risk.model}) over ${risk.segments_scored} segments → ${
      result.saved ? `saved, peak ${result.peak}` : `skipped (${result.reason})`
    }${result.offered ? ", OFFERED" : ""}`,
  );
  if (result.offered) await sendOfferPush(call.id, risk, { twinReady: await twinReadyForOffer(call.id) });
  return { risk, saved: Boolean(result.saved), offered: Boolean(result.offered) };
}

/** Whether the customer's AI Voice Twin could take the call (the push then asks them to choose). False on any error. */
async function twinReadyForOffer(callId: string): Promise<boolean> {
  try {
    return (await getCustomerTwinView()).usable;
  } catch (error) {
    console.error(`push ${callId}: could not check the AI Voice Twin; offering the AI voice handover`, error);
    return false;
  }
}

/** processIntel on the screening transcript, at most once every 20 s per call (an atomic claim on intel_claimed_at). */
export async function maybeRunLiveIntel(callId: string): Promise<void> {
  const db = supabaseAdmin();
  const cutoff = new Date(Date.now() - LIVE_INTEL_INTERVAL_MS).toISOString();
  const { data: claimed, error } = await db
    .from("calls")
    .update({ intel_claimed_at: new Date().toISOString() })
    .eq("id", callId)
    .eq("status", "live")
    .or(`intel_claimed_at.is.null,intel_claimed_at.lt.${cutoff}`)
    .select("*");
  if (error) throw new Error(`live intel claim failed: ${error.message}`);
  const call = ((claimed ?? []) as CallRow[])[0];
  if (!call || !screeningActive(call)) return;
  const result = await processIntel(call.id, combinedTranscript(call), undefined, { timeoutMs: 20_000, maxRetries: 0 });
  console.info(`live intel ${call.id}: ${result.saved ? "saved" : `skipped (${result.reason})`}`);
}
