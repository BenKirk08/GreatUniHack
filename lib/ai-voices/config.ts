/**
 * The six AI voices that take a flagged scam call over from the customer: one per age band and gender, matched to the
 * customer so the caller hears someone who plausibly sounds like the person they were talking to (lib/voice-match.ts).
 *
 * This file is the only place the ElevenLabs voice IDs live. They are public Voice Library voices added to the
 * account's My Voices with the same IDs (`npm run setup-ai-voices` checks and adds them).
 * Who each voice plays (name, age, backstory) is in lib/persona-meta.ts and lib/personas.ts.
 */

/** younger = mid-20s, middle = 40s–50s, older = 70s+ (the characters' ages; see AGE_BAND_RANGES for matching). */
export const AGE_BANDS = ["younger", "middle", "older"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const GENDERS = ["male", "female"] as const;
export type Gender = (typeof GENDERS)[number];

/** The six AI voices, also stored in calls.persona. Order: by gender, then age band. */
export const AI_VOICE_IDS = ["younger_male", "middle_male", "older_male", "younger_female", "middle_female", "older_female"] as const;
export type AiVoiceId = (typeof AI_VOICE_IDS)[number];

/** The ElevenLabs voice for each age band and gender. */
export const ELEVENLABS_AI_VOICE_IDS: Readonly<Record<AiVoiceId, string>> = {
  younger_male: "2mltbVQP21Fq8XgIfRQJ",
  middle_male: "fATgBRI8wg5KkDFg8vBd",
  older_male: "qxePw1S1QmBgjlU3GIy5",
  younger_female: "8z5UhJ1uv7X8TN5yg8oI",
  middle_female: "HXOwtW4XU7Ne6iOiDHTl",
  older_female: "RILOU7YmBhvwJGDGjNmP",
};

/** The AI voice for an age band and gender. */
export function aiVoiceFor(ageBand: AgeBand, gender: Gender): AiVoiceId {
  return `${ageBand}_${gender}`;
}

/** The ElevenLabs voice ID for an AI voice. */
export function elevenLabsVoiceId(voice: AiVoiceId): string {
  return ELEVENLABS_AI_VOICE_IDS[voice];
}

/** The age band and gender an AI voice stands for. */
export function aiVoiceParts(voice: AiVoiceId): { ageBand: AgeBand; gender: Gender } {
  const [ageBand, gender] = voice.split("_") as [AgeBand, Gender];
  return { ageBand, gender };
}

export function isAiVoiceId(value: unknown): value is AiVoiceId {
  return typeof value === "string" && (AI_VOICE_IDS as readonly string[]).includes(value);
}

export function isAgeBand(value: unknown): value is AgeBand {
  return typeof value === "string" && (AGE_BANDS as readonly string[]).includes(value);
}

export function isGender(value: unknown): value is Gender {
  return typeof value === "string" && (GENDERS as readonly string[]).includes(value);
}
