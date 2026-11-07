import type { VoiceTwinRow, VoiceTwinState, VoiceTwinVoiceSource } from "@/lib/types";

/**
 * What the customer's /protect page (pop-up and Settings) sees about their AI Voice Twin. Pure and client-safe.
 * Never includes the ElevenLabs voice ID or storage paths.
 */
export interface CustomerTwinView {
  /** voice_twin_consent for the account holder. */
  consent: boolean;
  consentGivenAt: string | null;
  consentGivenBy: string | null;
  /**
   * The effective state: a 'ready' twin whose voice has expired (24 h) reads as 'collecting' with 0 s until
   * housekeeping retires it, so an expired voice is never offered.
   */
  state: VoiceTwinState;
  /** Seconds of clean speech collected (live, via Realtime signals). */
  speechSeconds: number;
  minSeconds: number;
  targetSeconds: number;
  /** The twin can take a call right now: consent, state ready, voice not expired. */
  usable: boolean;
  /** 'fallback' when the API clone failed and VOICE_TWIN_FALLBACK_VOICE_ID is used. */
  voiceSource: VoiceTwinVoiceSource | null;
  voiceCreatedAt: string | null;
  voiceExpiresAt: string | null;
  /** Seconds of speech the current voice was built from. */
  cloneSpeechSeconds: number | null;
  /** Plain-language reason when state is 'failed'. */
  error: string | null;
  /**
   * Whether the twin can record the customer's voice during calls right now: consent, still collecting, and the local
   * media bridge (services/media-bridge) is up. Without the bridge only "Record a sample now" adds speech.
   */
  liveCapture: boolean;
}

export function customerTwinView(
  row: VoiceTwinRow | null | undefined,
  settings: { minSeconds: number; targetSeconds: number },
  now: number,
  opts: { bridgeOnline?: boolean } = {},
): CustomerTwinView {
  const base: CustomerTwinView = {
    consent: false,
    consentGivenAt: null,
    consentGivenBy: null,
    state: "collecting",
    speechSeconds: 0,
    minSeconds: settings.minSeconds,
    targetSeconds: Math.max(settings.targetSeconds, settings.minSeconds),
    usable: false,
    voiceSource: null,
    voiceCreatedAt: null,
    voiceExpiresAt: null,
    cloneSpeechSeconds: null,
    error: null,
    liveCapture: false,
  };
  if (!row || !row.voice_twin_consent) return base;

  const expiresAt = row.voice_expires_at ? Date.parse(row.voice_expires_at) : NaN;
  // Same margin as twinForTakeover: a voice in its last minute already reads as expired, so a tap can't hit a voice
  // that is about to be deleted.
  const expired = row.state === "ready" && (!Number.isFinite(expiresAt) || expiresAt - now < 60_000);
  const ready = row.state === "ready" && !expired && Boolean(row.voice_id);
  return {
    ...base,
    consent: true,
    consentGivenAt: row.consent_given_at,
    consentGivenBy: row.consent_given_by,
    state: expired ? "collecting" : row.state,
    speechSeconds: expired ? 0 : roundSeconds(row.speech_seconds),
    usable: ready,
    voiceSource: ready ? row.voice_source : null,
    voiceCreatedAt: ready ? row.voice_created_at : null,
    voiceExpiresAt: ready ? row.voice_expires_at : null,
    cloneSpeechSeconds: ready && row.clone_speech_seconds != null ? roundSeconds(row.clone_speech_seconds) : null,
    error: row.state === "failed" ? friendlyCloneError(row.clone_error) : null,
    // Exactly what startVictimCapture will do: it reads the stored state, so a voice that has expired but isn't retired
    // yet (housekeeping does that within a minute) doesn't record until it is.
    liveCapture: Boolean(opts.bridgeOnline) && (row.state === "collecting" || row.state === "failed"),
  };
}

/**
 * A plain, customer-safe reason for a failed clone (the raw ElevenLabs/server error stays in clone_error and the logs).
 */
export function friendlyCloneError(raw: string | null | undefined): string {
  const text = raw ?? "";
  if (/verification/i.test(text)) {
    return "We couldn't make your AI Voice Twin: ElevenLabs asked for extra voice verification. You can try again from Settings.";
  }
  if (/\b(401|402|403)\b|subscription|feature_not_available|not allowed|permission/i.test(text)) {
    return "We couldn't make your AI Voice Twin: the ElevenLabs plan doesn't allow voice cloning right now. You can try again from Settings.";
  }
  if (/voice_limit|slot|too many voices|limit reached|quota/i.test(text)) {
    return "We couldn't make your AI Voice Twin: the ElevenLabs voice limit is full. You can try again from Settings.";
  }
  if (/no usable audio|too short|audio_too_short|not enough/i.test(text)) {
    return "We couldn't make your AI Voice Twin from the speech we had. Record a short sample in Settings, then try again.";
  }
  return "We couldn't make your AI Voice Twin. You can try again from Settings.";
}

/** One decimal place, never negative. */
export function roundSeconds(value: number | null | undefined): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.round(n * 10) / 10);
}

/** "18s / 30s of your voice" (whole seconds, floored, so the label never claims more than was captured). */
export function progressLabel(speechSeconds: number, minSeconds: number): string {
  return `${Math.floor(Math.max(0, speechSeconds))}s / ${Math.round(minSeconds)}s of your voice`;
}
