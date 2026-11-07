import { serverEnv } from "@/lib/env";

/**
 * AI Voice Twin constants. Client-safe (no secrets): labels, consent wording and the sample paragraph are shown in the
 * browser; voiceTwinSettings() reads non-secret numbers from the server env.
 */

/** The only name the twin goes by in the UI. */
export const VOICE_TWIN_LABEL = "AI Voice Twin";
/** How the twin is named in reports and on the dashboard. */
export const VOICE_TWIN_REPORT_LABEL = "AI Voice Twin (consented)";

/** The checkbox text, verbatim. The box starts unticked; consent is only ever given in Settings, never mid-call. */
export const VOICE_TWIN_CONSENT_TEXT =
  "I consent to my voice being recorded during flagged calls and cloned so an AI can speak as me to suspected scammers";
/** Stored with each consent so the wording someone agreed to can be traced. Bump it when the explanation changes. */
export const VOICE_TWIN_CONSENT_VERSION = "2026-11-06.v1";

/** The twin's opening line when it picks the call up. */
export const VOICE_TWIN_FIRST_MESSAGE = "Sorry, I'm back — where were we?";

/** Private Supabase Storage bucket for raw audio (0009). */
export const VOICE_TWIN_BUCKET = "voice-twin";
/** The single Call Guard account holder (one customer per deployment, signed in with the /protect link cookie). */
export const VOICE_TWIN_ACCOUNT_REF = "customer";
/** Clones are deleted automatically this long after creation. */
export const VOICE_TWIN_CLONE_TTL_MS = 24 * 60 * 60 * 1000;
/** A 'cloning' claim older than this belongs to a clone run that died and may be claimed again. */
export const VOICE_TWIN_STALE_CLONING_SECONDS = 180;
/** "Record a sample now" stops by itself after this long. */
export const VOICE_TWIN_SAMPLE_MAX_SECONDS = 60;
/** The media bridge counts as running when its heartbeat is newer than this. */
export const MEDIA_BRIDGE_FRESH_MS = 90_000;

/** Read aloud for "Record a sample now" (about a minute at a relaxed pace; deliberately nothing about money or banks). */
export const VOICE_TWIN_SAMPLE_PARAGRAPH =
  "On Saturday mornings I like to walk down to the market before it gets busy. I usually pick up a loaf of bread, " +
  "some apples and whatever flowers look cheerful that week. The man on the fruit stall always tells me about his " +
  "allotment, and I tell him about the robin that keeps visiting my garden. Afterwards I sit in the café by the " +
  "library with a pot of tea and the crossword, although I rarely finish it. If the weather is nice I take the long " +
  "way home past the river, where the ducks and the dog walkers seem to have come to an agreement. In the afternoon " +
  "I might ring my sister, potter about in the kitchen, or watch an old film with the window open. It is nothing " +
  "special, really, but it is exactly how I like my weekends to be: quiet, unhurried and full of small, familiar things.";

export interface VoiceTwinSettings {
  /** VOICE_TWIN_MIN_SECONDS: clean speech needed before cloning is allowed. */
  minSeconds: number;
  /** VOICE_TWIN_TARGET_SECONDS: the "good quality" mark on the progress bar. */
  targetSeconds: number;
  /** VOICE_TWIN_FALLBACK_VOICE_ID, if set. */
  fallbackVoiceId: string | null;
}

/** Server only: the twin settings from the environment. */
export function voiceTwinSettings(): VoiceTwinSettings {
  const env = serverEnv();
  return {
    minSeconds: env.VOICE_TWIN_MIN_SECONDS,
    targetSeconds: Math.max(env.VOICE_TWIN_TARGET_SECONDS, env.VOICE_TWIN_MIN_SECONDS),
    fallbackVoiceId: env.VOICE_TWIN_FALLBACK_VOICE_ID ?? null,
  };
}
