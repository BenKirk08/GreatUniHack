import { z } from "zod";
import { AGE_BANDS, AI_VOICE_IDS, GENDERS, type AgeBand, type AiVoiceId, type Gender } from "@/lib/ai-voices/config";

export type { AgeBand, AiVoiceId, Gender };

/* ---------- transcript ---------- */

/**
 * Roles in a (combined) transcript: the caller (suspected scammer), the real customer (screening only), and the
 * Northgate persona that took the call over. calls.transcript (the persona conversation) only has scammer/agent.
 */
export const speakerSchema = z.enum(["scammer", "customer", "agent"]);
export type Speaker = z.infer<typeof speakerSchema>;

export const transcriptTurnSchema = z.object({
  role: speakerSchema,
  message: z.string(),
  time_in_call_secs: z.number().nonnegative().optional(),
});
export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;

/* ---------- fields Margaret reports through the record_details tool ---------- */

export const TOOL_FIELD_KEYS = [
  "claimed_organisation",
  "caller_name",
  "reason_given",
  "payee_name",
  "sort_code",
  "account_number",
  "amount",
  "requested_action",
  "callback_number",
] as const;

export type ToolFieldKey = (typeof TOOL_FIELD_KEYS)[number];
export type ToolFields = Partial<Record<ToolFieldKey, string>>;

/* ---------- intelligence ---------- */

export const SCAM_TYPES = [
  "bank_impersonation",
  "safe_account",
  "hmrc",
  "courier",
  "investment",
  "family_emergency",
  "tech_support",
  "other",
  "unknown",
] as const;
export type ScamType = (typeof SCAM_TYPES)[number];

export const TACTICS = ["urgency", "secrecy", "authority", "fear", "isolation", "reward", "remote_access"] as const;
export type Tactic = (typeof TACTICS)[number];

export const payeeSchema = z.object({
  name: z.string().nullable(),
  sort_code: z.string().regex(/^\d{2}-\d{2}-\d{2}$/).nullable(),
  account_number: z.string().regex(/^\d{8}$/).nullable(),
});
export type Payee = z.infer<typeof payeeSchema>;

export const intelSchema = z.object({
  impersonated_org: z.string().nullable(),
  scam_type: z.enum(SCAM_TYPES),
  tactics: z.array(z.enum(TACTICS)),
  payee: payeeSchema,
  amount_gbp: z.number().nonnegative().nullable(),
  callback_numbers: z.array(z.string()),
  key_quotes: z.array(z.string()).max(5),
  risk_score: z.number().int().min(0).max(100),
  summary: z.string(),
  /** Everything Margaret recorded with record_details, merged across the call. */
  agent_reported: z.record(z.string(), z.string()).default({}),
  caller_name: z.string().nullable().default(null),
  reason_given: z.string().nullable().default(null),
  requested_action: z.string().nullable().default(null),
  updated_at: z.string(),
  model: z.string(),
});
export type Intel = z.infer<typeof intelSchema>;

/* ---------- mule check ---------- */

export const accountSnapshotSchema = z.object({
  id: z.string(),
  holder_name: z.string(),
  sort_code: z.string(),
  account_number: z.string(),
  status: z.enum(["active", "frozen"]),
  payments_in_48h: z.number(),
  distinct_payers_48h: z.number(),
  total_in_48h_pence: z.number(),
});
export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>;

export type MuleMatch =
  | {
      status: "match";
      confidence: "high";
      account: AccountSnapshot;
      /** The account's own 48h activity also fits the mule pattern (>3 distinct payers, £2k–£6k in). */
      mule_pattern: boolean;
      checked: CheckedPayee;
      checked_at: string;
    }
  | {
      status: "name_only";
      confidence: "low";
      warning: string;
      candidates: AccountSnapshot[];
      checked: CheckedPayee;
      checked_at: string;
    }
  | {
      status: "no_match";
      checked: CheckedPayee;
      checked_at: string;
    };

export interface CheckedPayee {
  name: string | null;
  sort_code: string | null;
  account_number: string | null;
}

/* ---------- database rows ---------- */

/* ---------- Call Guard: screening, risk and takeover ---------- */

export const SCREENING_SPEAKERS = ["caller", "customer"] as const;
export type ScreeningSpeaker = (typeof SCREENING_SPEAKERS)[number];

/** One final transcription segment from Twilio Real-Time Transcription. */
export interface ScreeningSegment {
  speaker: ScreeningSpeaker;
  text: string;
  /** ISO timestamp from Twilio. */
  at: string;
  /** Twilio SequenceId (dedupes webhook retries). */
  seq?: number;
}

export interface CallRisk {
  /** This scoring's score: max(keyword floor, Claude's score). */
  score: number;
  /** Highest score so far. */
  peak: number;
  scam_type: ScamType;
  tactics: Tactic[];
  reason: string;
  /** How many screening segments this score was built from (stale-write guard). */
  segments_scored: number;
  scored_at: string;
  keyword_floor?: number;
  model?: string;
  threshold_crossed_at?: string;
  threshold_crossed_score?: number;
  /**
   * The two most suspicious things the caller has said so far, verbatim from their own lines (chosen by Claude while
   * scoring, checked by selectScammerQuotes). Shown on the customer's scam alert; kept from the last scoring that found any.
   */
  quotes?: string[];
}

export const HANDOFF_STATUSES = ["none", "offered", "declined", "requested", "connected", "failed"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

/** The personas today: the six AI voices, one per age band and gender (lib/ai-voices/config.ts). */
export const PERSONA_IDS = AI_VOICE_IDS;
export type PersonaId = AiVoiceId;

/** The four personas before the AI voices (chosen by scam type). Old calls keep them in calls.persona. */
export const LEGACY_PERSONA_IDS = ["margaret", "derek", "priya", "keith"] as const;
export type LegacyPersonaId = (typeof LEGACY_PERSONA_IDS)[number];

/** What calls.persona can hold: an AI voice, or a legacy persona on calls taken over before the AI voices. */
export type StoredPersonaId = PersonaId | LegacyPersonaId;

/* ---------- AI voice match (0012) ---------- */

/** Why the AI voice has its age band and gender: the customer's setting, inferred from the call, or the default. */
export const VOICE_MATCH_SOURCES = ["setting", "inferred", "default"] as const;
export type VoiceMatchSource = (typeof VOICE_MATCH_SOURCES)[number];

export const VOICE_MATCH_CONFIDENCES = ["low", "medium", "high"] as const;
export type VoiceMatchConfidence = (typeof VOICE_MATCH_CONFIDENCES)[number];

/**
 * What happened to the inference from the call: not needed (the setting has both), used, or why it wasn't (no data,
 * low confidence, no usable cues, the model failed or was too slow, or no time was left in the handover's budget).
 */
export const VOICE_INFERENCE_OUTCOMES = ["not_needed", "used", "no_data", "low_confidence", "no_cues", "timeout", "failed", "no_time"] as const;
export type VoiceInferenceOutcome = (typeof VOICE_INFERENCE_OUTCOMES)[number];

/** calls.ai_voice_match: which AI voice took the call and why. Built by resolveVoiceMatch (lib/voice-match.ts). */
export const aiVoiceMatchSchema = z.object({
  voice: z.enum(AI_VOICE_IDS),
  age_band: z.enum(AGE_BANDS),
  gender: z.enum(GENDERS),
  /** Overall: "setting" when both came from the setting, "inferred" when the call supplied either, else "default". */
  source: z.enum(VOICE_MATCH_SOURCES),
  age_from: z.enum(VOICE_MATCH_SOURCES),
  gender_from: z.enum(VOICE_MATCH_SOURCES),
  /** The inference's confidence (null when no inference ran or it failed). */
  confidence: z.enum(VOICE_MATCH_CONFIDENCES).nullable(),
  inference: z.enum(VOICE_INFERENCE_OUTCOMES),
});
export type AiVoiceMatch = z.infer<typeof aiVoiceMatchSchema>;

/* ---------- AI Voice Twin (0009) ---------- */

export const TAKEOVER_KINDS = ["persona", "voice_twin"] as const;
export type TakeoverKind = (typeof TAKEOVER_KINDS)[number];

/** What the customer taps in the scam alert: "Use AI voice" (the automatically matched voice) or their own twin. */
export type TakeoverChoice = "ai_voice" | "voice_twin";

/** collecting → cloning → ready (or failed). A ready twin whose voice expired is back to collecting. */
export const VOICE_TWIN_STATES = ["collecting", "cloning", "ready", "failed"] as const;
export type VoiceTwinState = (typeof VOICE_TWIN_STATES)[number];
export type VoiceTwinVoiceSource = "clone" | "fallback";

/** public.voice_twins: the account holder's consent and twin. */
export interface VoiceTwinRow {
  id: string;
  account_ref: string;
  voice_twin_consent: boolean;
  consent_given_at: string | null;
  consent_given_by: string | null;
  consent_text_version: string | null;
  consent_user_agent: string | null;
  consent_revoked_at: string | null;
  state: VoiceTwinState;
  /** Seconds of clean speech stored so far (Settings samples + calls; a call's seconds are removed if it ends unflagged). */
  speech_seconds: number;
  voice_id: string | null;
  voice_source: VoiceTwinVoiceSource | null;
  voice_created_at: string | null;
  voice_expires_at: string | null;
  /** Seconds of speech the current voice was built from. */
  clone_speech_seconds: number | null;
  clone_error: string | null;
  cloning_started_at: string | null;
  last_audio_at: string | null;
  created_at: string;
  updated_at: string;
}

/** public.voice_twin_audio: one stored WAV chunk in the private "voice-twin" bucket. */
export interface VoiceTwinAudioRow {
  id: string;
  twin_id: string;
  source: "call" | "sample";
  call_id: string | null;
  session_id: string;
  seq: number;
  storage_path: string;
  mime_type: string;
  sample_rate: number | null;
  speech_seconds: number;
  bytes: number;
  created_at: string;
}

export interface CallRow {
  id: string;
  conversation_id: string | null;
  twilio_call_sid: string | null;
  caller_masked: string | null;
  direction: "inbound" | "outbound";
  status: "live" | "ended";
  started_at: string;
  ended_at: string | null;
  /** Caller/customer lines before any takeover. */
  screening_transcript: ScreeningSegment[];
  risk: CallRisk | null;
  handoff_status: HandoffStatus;
  handoff_by: string | null;
  handoff_at: string | null;
  /** When the current takeover claim was made (a stale 'requested' claim can be retried). */
  handoff_requested_at: string | null;
  handoff_error: string | null;
  /** The AI voice that took the call, or a legacy persona on older calls (null for the AI Voice Twin or no takeover). */
  persona: StoredPersonaId | null;
  offered_at: string | null;
  declined_score: number | null;
  /** The persona's conversation with the caller after a takeover (roles scammer/agent). */
  transcript: TranscriptTurn[];
  intel: Intel | null;
  intel_turns: number;
  intel_claimed_at: string | null;
  mule_match: MuleMatch | null;
  agent_notes: ToolFields;
  updated_at: string;
  /** Who took the call over: a persona, or the customer's own consented AI Voice Twin (0009). Null before a takeover. */
  takeover_kind?: TakeoverKind | null;
  /** AI Voice Twin takeovers: seconds of the customer's clean speech the clone was built from. */
  voice_twin_speech_seconds?: number | null;
  /** AI Voice Twin takeovers: the consent reference (when the customer consented in Settings). */
  voice_twin_consent_at?: string | null;
  /** AI Voice Twin takeovers: 'clone' (made by the app) or 'fallback' (VOICE_TWIN_FALLBACK_VOICE_ID). */
  voice_twin_voice_source?: VoiceTwinVoiceSource | null;
  /** AI voice takeovers (0012): which voice and why (setting / inferred / default). Null before a takeover and on older calls. */
  ai_voice_match?: AiVoiceMatch | null;
}

export interface BankAccountRow extends AccountSnapshot {
  frozen_at: string | null;
}

export interface ReportRow {
  id: string;
  call_id: string;
  status: "draft" | "sent";
  body: ReportBody;
  sent_at: string | null;
  approved_by: string | null;
  email_id: string | null;
  send_claimed_at: string | null;
  created_at: string;
}

export interface SettingsRow {
  id: number;
  auto_send: boolean;
  updated_at: string;
  /** The customer's optional "Your AI voice match" (0012): null when not set. */
  voice_match_age_band?: AgeBand | null;
  voice_match_gender?: Gender | null;
}

/* ---------- report ---------- */

export const reportBodySchema = z.object({
  title: z.string(),
  summary: z.string(),
  timeline: z.array(z.object({ time: z.string(), event: z.string() })),
  scam_type: z.enum(SCAM_TYPES),
  tactics: z.array(z.enum(TACTICS)),
  payee: z.object({
    name: z.string().nullable(),
    sort_code: z.string().nullable(),
    account_number: z.string().nullable(),
    amount_gbp: z.number().nullable(),
  }),
  mule_findings: z.object({
    status: z.enum(["match", "name_only", "no_match", "not_checked"]),
    detail: z.string(),
  }),
  /** Call Guard: threshold crossed, handover (who/when), persona, call end. Built from our own data, not by Claude. */
  protection_timeline: z.array(z.object({ time: z.string(), event: z.string() })).default([]),
  evidence_quotes: z.array(z.string()),
  /** Who took the call over, from our own data (optional: reports written before the Voice Twin have none). */
  takeover: z
    .object({
      type: z.enum(["none", "persona", "voice_twin"]),
      /** "AI voice: older female (from settings)", "AI Voice Twin (consented)", "Not handed over", or an old persona ("Derek Hollis (dad)"). */
      label: z.string(),
      /** AI Voice Twin: seconds of the customer's speech the clone was built from. */
      speech_seconds: z.number().nullable(),
      /** AI Voice Twin: the consent reference (the consent timestamp, ISO). */
      consent_at: z.string().nullable(),
      /** AI voice takeovers: which voice, who it played and why it was chosen (absent on older reports). */
      ai_voice: z
        .object({
          voice: z.string(),
          name: z.string(),
          age_band: z.string(),
          gender: z.string(),
          source: z.enum(VOICE_MATCH_SOURCES),
        })
        .nullable()
        .optional(),
    })
    .optional(),
  recommended_actions: z.object({
    freeze_account: z.string(),
    contact_affected_payers: z.string(),
    other: z.array(z.string()),
    report_fraud_ready: z.string(),
  }),
  meta: z.object({
    conversation_id: z.string().nullable(),
    call_id: z.string().optional(),
    persona: z.string().nullable().optional(),
    handoff_by: z.string().nullable().optional(),
    caller_masked: z.string().nullable(),
    direction: z.enum(["inbound", "outbound"]),
    started_at: z.string(),
    ended_at: z.string().nullable(),
    duration_secs: z.number().nullable(),
    risk_score: z.number().nullable(),
    impersonated_org: z.string().nullable(),
    generated_at: z.string(),
    model: z.string(),
  }),
});
export type ReportBody = z.infer<typeof reportBodySchema>;
