import { aiVoiceParts, type AgeBand, type Gender } from "@/lib/ai-voices/config";
import {
  LEGACY_PERSONA_IDS,
  PERSONA_IDS,
  type AiVoiceMatch,
  type CallRow,
  type LegacyPersonaId,
  type PersonaId,
  type ReportBody,
  type ScamType,
  type StoredPersonaId,
} from "@/lib/types";
import { aiVoiceSummary, voiceDescription } from "@/lib/voice-match";
import { VOICE_TWIN_LABEL, VOICE_TWIN_REPORT_LABEL } from "@/lib/voice-twin/config";

/**
 * Client-safe persona facts (no env access, no voice IDs), shared by the dashboard and the server. The personas are
 * the six AI voices, one per age band and gender; each plays a UK bank customer of that age who carries on the call
 * as the person the caller was talking to. The full backstories they are prompted with are in lib/personas.ts.
 */
export interface PersonaMeta {
  id: PersonaId;
  name: string;
  age: number;
  ageBand: AgeBand;
  gender: Gender;
  /** Where they live and what they do, in a few words. */
  about: string;
}

export const PERSONAS: Record<PersonaId, PersonaMeta> = {
  younger_male: { id: "younger_male", name: "Josh Kelly", age: 25, ...aiVoiceParts("younger_male"), about: "junior graphic designer, Salford" },
  middle_male: { id: "middle_male", name: "Steve Marsh", age: 52, ...aiVoiceParts("middle_male"), about: "self-employed plumber, Bristol" },
  older_male: { id: "older_male", name: "Ron Ashworth", age: 77, ...aiVoiceParts("older_male"), about: "retired bus driver, Stockport" },
  younger_female: { id: "younger_female", name: "Ellie Shaw", age: 24, ...aiVoiceParts("younger_female"), about: "nursery nurse, Leeds" },
  middle_female: { id: "middle_female", name: "Julie Barnes", age: 48, ...aiVoiceParts("middle_female"), about: "school office manager, Coventry" },
  older_female: { id: "older_female", name: "Joan Whitaker", age: 79, ...aiVoiceParts("older_female"), about: "retired school secretary, Harrogate" },
};

/** The personas before the AI voices, kept so older calls and reports still show who took them. */
export const LEGACY_PERSONAS: Record<LegacyPersonaId, { name: string; age: number; relation: string }> = {
  margaret: { name: "Margaret Ellis", age: 78, relation: "nan" },
  derek: { name: "Derek Hollis", age: 74, relation: "dad" },
  priya: { name: "Priya Shah", age: 26, relation: "flatmate" },
  keith: { name: "Keith Barlow", age: 58, relation: "partner" },
};

export { PERSONA_IDS };

export function isPersonaId(value: unknown): value is PersonaId {
  return typeof value === "string" && (PERSONA_IDS as readonly string[]).includes(value);
}

export function isLegacyPersonaId(value: unknown): value is LegacyPersonaId {
  return typeof value === "string" && (LEGACY_PERSONA_IDS as readonly string[]).includes(value);
}

/** "Joan Whitaker" for an AI voice, "Margaret Ellis" for a legacy persona, or the raw value for anything else. */
export function personaName(id: StoredPersonaId | string): string {
  if (isPersonaId(id)) return PERSONAS[id].name;
  if (isLegacyPersonaId(id)) return LEGACY_PERSONAS[id].name;
  return id;
}

/** "Northgate took over · Margaret · by customer" style labels. */
export function handoffByLabel(handoffBy: string | null | undefined): string {
  if (!handoffBy) return "unknown";
  if (handoffBy === "customer") return "the customer";
  return handoffBy.startsWith("analyst:") ? `analyst ${handoffBy.slice("analyst:".length)}` : handoffBy;
}

/**
 * A persona as reports name it: "Joan Whitaker (AI voice, older female)" for an AI voice, "Margaret Ellis (nan)" for
 * a legacy persona, or the raw value for anything unknown.
 */
export function personaReportLabel(id: StoredPersonaId | string): string {
  if (isPersonaId(id)) return `${PERSONAS[id].name} (AI voice, ${voiceDescription({ age_band: PERSONAS[id].ageBand, gender: PERSONAS[id].gender })})`;
  if (isLegacyPersonaId(id)) return `${LEGACY_PERSONAS[id].name} (${LEGACY_PERSONAS[id].relation})`;
  return id;
}

/** "Speaking as Joan Whitaker, 79 (retired school secretary, Harrogate)". */
export function personaCharacterLine(id: PersonaId): string {
  const p = PERSONAS[id];
  return `Speaking as ${p.name}, ${p.age} (${p.about})`;
}

/** The takeover facts the labels below read (the Voice Twin and AI voice columns are optional: older rows lack them). */
export type TakeoverFacts = Pick<CallRow, "takeover_kind" | "persona"> & Partial<Pick<CallRow, "ai_voice_match">>;

/** The AI voice match for a call taken by an AI voice (null for the twin, legacy personas and no takeover). */
export function aiVoiceMatchOf(call: TakeoverFacts): AiVoiceMatch | null {
  if (call.takeover_kind === "voice_twin" || !isPersonaId(call.persona)) return null;
  const match = call.ai_voice_match;
  return match && match.voice === call.persona ? match : null;
}

/**
 * "AI voice: older female (from settings)" for an AI voice takeover. Without a recorded match (it is written with the
 * persona, so only a partial row lacks it) the description comes from the voice itself, without a reason.
 */
export function aiVoiceLabel(call: TakeoverFacts): string {
  if (!isPersonaId(call.persona)) return "";
  const match = aiVoiceMatchOf(call);
  if (match) return aiVoiceSummary(match);
  const p = PERSONAS[call.persona];
  return `AI voice: ${voiceDescription({ age_band: p.ageBand, gender: p.gender })}`;
}

/**
 * Who took the call over, in full: "AI voice: older female (from settings)", "AI Voice Twin (consented)", a legacy
 * persona's name ("Derek Hollis"), or "" if nobody did. Rows from before the Voice Twin have a persona but no
 * takeover_kind; they count as persona takeovers.
 */
export function takeoverLabel(call: TakeoverFacts): string {
  if (call.takeover_kind === "voice_twin") return VOICE_TWIN_REPORT_LABEL;
  if (!call.persona) return "";
  return isPersonaId(call.persona) ? aiVoiceLabel(call) : personaName(call.persona);
}

/** takeoverLabel() for tight spots: "AI voice", "AI Voice Twin", a legacy persona's first name ("Derek"), or "". */
export function takeoverShortLabel(call: TakeoverFacts): string {
  if (call.takeover_kind === "voice_twin") return VOICE_TWIN_LABEL;
  if (!call.persona) return "";
  return isPersonaId(call.persona) ? "AI voice" : personaName(call.persona).split(" ")[0];
}

/** Whole seconds of speech, "42 s" (null when unknown). */
export function formatSpeechSeconds(seconds: number | null | undefined): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds) ? `${Math.max(0, Math.round(seconds))} s` : null;
}

/** "06 Nov 21:15:03" in the viewer's time zone ("" for a missing or unreadable timestamp). */
export function formatConsentTime(iso: string | null | undefined): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  const day = at.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${day} ${time}`;
}

/**
 * The AI Voice Twin detail for a call, e.g. "42 s of the customer's speech · consent 06 Nov 21:15:03" (plus
 * "fallback voice" when cloning failed and the fallback voice spoke). "" for calls the twin didn't take.
 */
export function voiceTwinDetail(
  call: Pick<CallRow, "takeover_kind" | "voice_twin_speech_seconds" | "voice_twin_consent_at" | "voice_twin_voice_source">,
): string {
  if (call.takeover_kind !== "voice_twin") return "";
  const speech = formatSpeechSeconds(call.voice_twin_speech_seconds);
  const consent = formatConsentTime(call.voice_twin_consent_at);
  return [
    speech ? `${speech} of the customer's speech` : null,
    call.voice_twin_voice_source === "fallback" ? "fallback voice" : null,
    consent ? `consent ${consent}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The calls columns that show a takeover really reached the caller: the ElevenLabs conversation_id, and the takeover
 * agent's transcript. Optional, so callers that only have the status columns still type-check (they get no evidence).
 */
export type TakeoverEvidenceFacts = Partial<Pick<CallRow, "conversation_id" | "transcript">>;

/** True when the takeover agent (persona or AI Voice Twin) has lines in the call's takeover transcript. */
export function hasAgentTurns(call: Pick<TakeoverEvidenceFacts, "transcript">): boolean {
  return Array.isArray(call.transcript) && call.transcript.some((turn) => turn.role === "agent");
}

/**
 * Whether Northgate's AI voice (or a legacy persona) or the AI Voice Twin took the call: handoff_status 'connected', or a 'requested' claim with
 * evidence the takeover happened (a conversation_id, or agent turns in the transcript). takeOver() redirects the call
 * before it records 'connected', so if that write fails the call stays 'requested' even though the agent spoke.
 */
export function wasHandedOver(call: Pick<CallRow, "handoff_status"> & TakeoverEvidenceFacts): boolean {
  if (call.handoff_status === "connected") return true;
  if (call.handoff_status !== "requested") return false;
  return (typeof call.conversation_id === "string" && call.conversation_id.trim() !== "") || hasAgentTurns(call);
}

/** The calls columns a takeover summary is built from. */
export type TakeoverSummaryFacts = Pick<
  CallRow,
  "handoff_status" | "persona" | "takeover_kind" | "voice_twin_speech_seconds" | "voice_twin_consent_at"
> &
  Partial<Pick<CallRow, "ai_voice_match">> &
  TakeoverEvidenceFacts;

/**
 * Who took the call over, for the report (ReportBody.takeover), from our own data. A 'requested' call counts as handed
 * over when there is evidence the takeover happened (see wasHandedOver()). A failed handover keeps the type it tried,
 * with " — handover failed" on the label. Client-safe so the dashboard can show it for reports written before the
 * Voice Twin; lib/report.ts exports it as buildTakeoverSummary().
 */
export function takeoverSummary(call: TakeoverSummaryFacts): NonNullable<ReportBody["takeover"]> {
  const failed = call.handoff_status === "failed";
  if (!failed && !wasHandedOver(call)) return { type: "none", label: "Not handed over", speech_seconds: null, consent_at: null };
  const suffix = failed ? " — handover failed" : "";
  if (call.takeover_kind === "voice_twin") {
    const speech = call.voice_twin_speech_seconds;
    return {
      type: "voice_twin",
      label: `${VOICE_TWIN_REPORT_LABEL}${suffix}`,
      speech_seconds: typeof speech === "number" && Number.isFinite(speech) ? Math.round(speech * 10) / 10 : null,
      consent_at: call.voice_twin_consent_at ?? null,
    };
  }
  // An AI voice takeover: "AI voice: older female (from settings)", with the voice, who it played and why.
  if (isPersonaId(call.persona)) {
    const p = PERSONAS[call.persona];
    const match = aiVoiceMatchOf(call);
    return {
      type: "persona",
      label: `${aiVoiceLabel(call)}${suffix}`,
      speech_seconds: null,
      consent_at: null,
      ai_voice: match ? { voice: p.id, name: p.name, age_band: p.ageBand, gender: p.gender, source: match.source } : null,
    };
  }
  // A legacy persona (rows from before the Voice Twin have no takeover_kind; every handover then used a persona).
  const label = call.persona ? personaReportLabel(call.persona) : "Northgate persona";
  return { type: "persona", label: `${label}${suffix}`, speech_seconds: null, consent_at: null };
}

/** Scam types in plain words, for the customer's alert. */
export const SCAM_TYPE_PLAIN: Record<ScamType, string> = {
  bank_impersonation: "Someone pretending to be your bank",
  safe_account: "A “safe account” scam: they want you to move your money",
  hmrc: "Someone pretending to be HMRC",
  courier: "A courier scam: they may send someone to collect cash or cards",
  investment: "An investment scam promising big returns",
  family_emergency: "A fake family emergency asking for money",
  tech_support: "A fake tech-support call wanting access to your device",
  other: "This call looks like a scam",
  unknown: "This call looks like a scam",
};
