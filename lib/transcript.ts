import type { CallRow, ScreeningSegment, TranscriptTurn } from "@/lib/types";

export function formatClock(secs: number | undefined): string {
  if (secs === undefined || !Number.isFinite(secs)) return "--:--";
  const s = Math.max(0, Math.floor(secs));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const ROLE_LABELS: Record<TranscriptTurn["role"], string> = {
  scammer: "CALLER",
  customer: "CUSTOMER",
  agent: "NORTHGATE PERSONA",
};

/** The agent's label on an AI Voice Twin takeover (the twin speaks in the customer's voice, so never "CUSTOMER"). */
export const VOICE_TWIN_AGENT_LABEL = "AI VOICE TWIN";

/**
 * Plain-text transcript for prompts. Speaker labels are fixed so the caller's words can't spoof them: `agentLabel`
 * (default "NORTHGATE PERSONA") names who spoke for Northgate and is set by our code, never from call content.
 */
export function transcriptToText(transcript: TranscriptTurn[], opts: { agentLabel?: string } = {}): string {
  const agentLabel = opts.agentLabel?.trim() || ROLE_LABELS.agent;
  return transcript
    .map((t) => {
      const who = t.role === "agent" ? agentLabel : (ROLE_LABELS[t.role] ?? agentLabel);
      const text = t.message.replace(/\s+/g, " ").trim();
      return `[${formatClock(t.time_in_call_secs)}] ${who}: ${text}`;
    })
    .join("\n");
}

function secondsBetween(fromIso: string | null | undefined, toIso: string | null | undefined): number | undefined {
  if (!fromIso || !toIso) return undefined;
  const d = (Date.parse(toIso) - Date.parse(fromIso)) / 1000;
  return Number.isFinite(d) ? Math.max(0, Math.round(d * 10) / 10) : undefined;
}

/** Screening segments as transcript turns (caller → scammer, customer → customer), timed from the call start. */
export function screeningToTurns(segments: ScreeningSegment[], startedAt: string): TranscriptTurn[] {
  return segments
    .filter((s) => s.text.trim())
    .map((s) => {
      const t = secondsBetween(startedAt, s.at);
      const role = s.speaker === "caller" ? ("scammer" as const) : ("customer" as const);
      return t === undefined ? { role, message: s.text.trim() } : { role, message: s.text.trim(), time_in_call_secs: t };
    });
}

/**
 * The whole call for intel and the report: the screening transcript (caller + customer) followed by the persona
 * transcript. Persona times are relative to the takeover, so they are shifted by (handoff_at − started_at).
 */
export function combinedTranscript(
  call: Pick<CallRow, "started_at" | "screening_transcript" | "transcript" | "handoff_at">,
): TranscriptTurn[] {
  const screening = screeningToTurns(call.screening_transcript ?? [], call.started_at);
  const lastScreening = screening.at(-1)?.time_in_call_secs ?? 0;
  const offset = secondsBetween(call.started_at, call.handoff_at) ?? lastScreening;
  const persona = (call.transcript ?? []).map((t) =>
    t.time_in_call_secs === undefined ? t : { ...t, time_in_call_secs: Math.round((t.time_in_call_secs + offset) * 10) / 10 },
  );
  return [...screening, ...persona];
}

function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9£]+/g, "");
}

/** Keep only quotes that really appear in the scammer's own words (punctuation/case-insensitive). */
export function verbatimScammerQuotes(quotes: string[], transcript: TranscriptTurn[], max = 5): string[] {
  const said = squash(
    transcript
      .filter((t) => t.role === "scammer")
      .map((t) => t.message)
      .join(" "),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of quotes) {
    const q = raw.trim().replace(/^["'“‘]+|["'”’]+$/g, "").trim();
    const key = squash(q);
    if (key.length < 4 || seen.has(key) || !said.includes(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}
