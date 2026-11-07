import { aiVoiceFor, isAgeBand, isGender, type AgeBand, type Gender } from "@/lib/ai-voices/config";
import type { AiVoiceMatch, VoiceInferenceOutcome, VoiceMatchConfidence, VoiceMatchSource } from "@/lib/types";

/**
 * Which AI voice takes a flagged call over: the one matching the customer's age band and gender, so the caller hears
 * someone who plausibly sounds like the person they were talking to. Pure and client-safe.
 *
 * Source of truth, in order:
 *  a) the customer's optional "Your AI voice match" setting (/protect/settings);
 *  b) for whatever the setting leaves unset: Claude's inference from the call (lib/voice-match-infer.ts), used only at
 *     medium or high confidence;
 *  c) otherwise the default: middle-aged, and female unless the setting gives a gender.
 */

export const DEFAULT_AGE_BAND: AgeBand = "middle";
export const DEFAULT_GENDER: Gender = "female";

/** The customer's "Your AI voice match" setting. Either part may be unset (null). */
export interface VoiceMatchSetting {
  ageBand: AgeBand | null;
  gender: Gender | null;
}

export const EMPTY_VOICE_MATCH_SETTING: VoiceMatchSetting = { ageBand: null, gender: null };

/** What Claude inferred from the call ("unknown" when the call gave no cue for that part). */
export interface VoiceMatchInference {
  age_band: AgeBand | "unknown";
  gender: Gender | "unknown";
  confidence: VoiceMatchConfidence;
}

/** The inference, or why there isn't one. */
export type InferenceResult =
  | { outcome: "inferred"; inference: VoiceMatchInference }
  | { outcome: Exclude<VoiceInferenceOutcome, "used" | "low_confidence" | "no_cues" | "not_needed"> };

/** Confidence levels at which the inference is used (anything lower falls back to the default). */
const USABLE_CONFIDENCE: ReadonlySet<VoiceMatchConfidence> = new Set(["medium", "high"]);

/** A setting with both parts needs no inference. */
export function isCompleteSetting(setting: VoiceMatchSetting | null | undefined): boolean {
  return Boolean(setting?.ageBand && setting?.gender);
}

/** A setting read from anywhere (database row, request), with anything unexpected treated as unset. */
export function normaliseSetting(raw: { ageBand?: unknown; gender?: unknown } | null | undefined): VoiceMatchSetting {
  return { ageBand: isAgeBand(raw?.ageBand) ? raw.ageBand : null, gender: isGender(raw?.gender) ? raw.gender : null };
}

/**
 * The AI voice for this call. The setting always wins for the parts it sets. The inference fills the rest only at
 * medium or high confidence; low confidence, "unknown" and no inference at all give the default for that part.
 * `source` is "setting" when both parts came from the setting, "inferred" when the call supplied either, else "default".
 */
export function resolveVoiceMatch(setting: VoiceMatchSetting | null | undefined, result: InferenceResult | null): AiVoiceMatch {
  const s = normaliseSetting(setting);
  if (s.ageBand && s.gender) return build(s.ageBand, "setting", s.gender, "setting", null, "not_needed");
  const inference = result?.outcome === "inferred" ? result.inference : null;
  const confident = inference !== null && USABLE_CONFIDENCE.has(inference.confidence);
  const inferredAge = confident && isAgeBand(inference.age_band) ? inference.age_band : null;
  const inferredGender = confident && isGender(inference.gender) ? inference.gender : null;

  const [ageBand, ageFrom]: [AgeBand, VoiceMatchSource] = s.ageBand
    ? [s.ageBand, "setting"]
    : inferredAge
      ? [inferredAge, "inferred"]
      : [DEFAULT_AGE_BAND, "default"];
  const [gender, genderFrom]: [Gender, VoiceMatchSource] = s.gender
    ? [s.gender, "setting"]
    : inferredGender
      ? [inferredGender, "inferred"]
      : [DEFAULT_GENDER, "default"];

  let outcome: VoiceInferenceOutcome;
  if (!result) outcome = "no_data";
  else if (result.outcome !== "inferred") outcome = result.outcome;
  else if (!confident) outcome = "low_confidence";
  else if ((s.ageBand || !inferredAge) && (s.gender || !inferredGender)) outcome = "no_cues";
  else outcome = "used";
  return build(ageBand, ageFrom, gender, genderFrom, inference?.confidence ?? null, outcome);
}

function build(
  ageBand: AgeBand,
  ageFrom: VoiceMatchSource,
  gender: Gender,
  genderFrom: VoiceMatchSource,
  confidence: VoiceMatchConfidence | null,
  inference: VoiceInferenceOutcome,
): AiVoiceMatch {
  const source: VoiceMatchSource =
    ageFrom === "setting" && genderFrom === "setting" ? "setting" : ageFrom === "inferred" || genderFrom === "inferred" ? "inferred" : "default";
  return { voice: aiVoiceFor(ageBand, gender), age_band: ageBand, gender, source, age_from: ageFrom, gender_from: genderFrom, confidence, inference };
}

/* ---------- labels: "AI voice: older female (from settings)" ---------- */

export const AGE_BAND_WORDS: Record<AgeBand, string> = { younger: "younger", middle: "middle-aged", older: "older" };

/** The settings choices, with the ages they cover. */
export const AGE_BAND_CHOICES: Record<AgeBand, { label: string; hint: string }> = {
  younger: { label: "Younger", hint: "under 35" },
  middle: { label: "Middle", hint: "35 to 64" },
  older: { label: "Older", hint: "65 and over" },
};
export const GENDER_CHOICES: Record<Gender, string> = { male: "Male", female: "Female" };

export const VOICE_MATCH_SOURCE_WORDS: Record<VoiceMatchSource, string> = {
  setting: "from settings",
  inferred: "inferred from the call",
  default: "default",
};

/** "older female", "middle-aged male". */
export function voiceDescription(match: Pick<AiVoiceMatch, "age_band" | "gender">): string {
  return `${AGE_BAND_WORDS[match.age_band]} ${match.gender}`;
}

/** "AI voice: older female (from settings)". */
export function aiVoiceSummary(match: Pick<AiVoiceMatch, "age_band" | "gender" | "source">): string {
  return `AI voice: ${voiceDescription(match)} (${VOICE_MATCH_SOURCE_WORDS[match.source]})`;
}

const INFERENCE_WORDS: Record<VoiceInferenceOutcome, string | null> = {
  not_needed: null,
  used: null,
  no_data: "nothing said on the call to go on",
  low_confidence: "the call gave only weak cues",
  no_cues: "the call gave no usable cues",
  timeout: "the inference took too long",
  failed: "the inference failed",
  no_time: "no time left to infer",
};

/**
 * The detail behind the source, for analysts: which part came from where when they differ, the inference's
 * confidence, and why the default was used. E.g. "age inferred (high confidence), gender from settings" or
 * "default: the call gave only weak cues". Empty when the summary says it all (both parts from settings).
 */
export function aiVoiceMatchDetail(
  match: Pick<AiVoiceMatch, "source" | "age_from" | "gender_from" | "confidence" | "inference">,
): string {
  if (match.source === "setting") return "";
  const parts: string[] = [];
  if (match.age_from !== match.gender_from) {
    parts.push(`age ${VOICE_MATCH_SOURCE_WORDS[match.age_from]}`, `gender ${VOICE_MATCH_SOURCE_WORDS[match.gender_from]}`);
  }
  if (match.source === "inferred" && match.confidence) parts.push(`${match.confidence} confidence`);
  const why = INFERENCE_WORDS[match.inference];
  if (why && match.source === "default") parts.push(why);
  else if (why && (match.age_from === "default" || match.gender_from === "default")) parts.push(`rest default: ${why}`);
  return parts.join(" · ");
}
