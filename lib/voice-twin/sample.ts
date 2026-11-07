import { getCustomerTwinView, liveVoiceTwinDeps, storeAudioChunk, type VoiceTwinDeps } from "@/lib/voice-twin/service";
import { SpeechCounter } from "@/lib/voice-twin/vad";
import type { CustomerTwinView } from "@/lib/voice-twin/view";
import { decodeWav, encodeWav } from "@/lib/voice-twin/wav";

/**
 * Server side of "Record a sample now" (POST /api/protect/voice-twin/sample). The browser sends ~3 s PCM16 WAV
 * chunks; the server re-checks consent, validates the file and RE-COUNTS the clean speech itself (the browser's
 * number is never trusted), keeping only the speech it counted.
 */

/** Largest decoded chunk accepted (1.5 MB). */
export const SAMPLE_CHUNK_MAX_BYTES = 1.5 * 1024 * 1024;
/** Longest chunk accepted, in seconds of audio. */
export const SAMPLE_CHUNK_MAX_SECONDS = 10;
export const SAMPLE_CHUNK_MIN_RATE = 8_000;
export const SAMPLE_CHUNK_MAX_RATE = 48_000;
/** Highest chunk sequence number in one recording session. */
export const SAMPLE_MAX_SEQ = 199;
/** Longest base64 string the route will look at (1.5 MB decoded, plus padding). */
export const SAMPLE_CHUNK_MAX_BASE64 = Math.ceil(SAMPLE_CHUNK_MAX_BYTES / 3) * 4;

export const NO_CONSENT_ERROR = "Turn on AI Voice Twin in Settings first.";
const UNREADABLE_ERROR = "We couldn't read that part of your recording. Please try again.";

export type SampleChunkProblem = "too_large" | "not_base64" | "unsupported_wav" | "not_mono" | "bad_rate" | "too_long";

export type PreparedSampleChunk =
  | {
      ok: true;
      /** Only the audio the server's VAD kept (counted speech plus short word endings), as a mono PCM16 WAV. */
      wav: Uint8Array;
      sampleRate: number;
      /** Clean speech counted by the server. */
      speechSeconds: number;
      /** Length of the kept audio. */
      keptSeconds: number;
      /** Length of the audio that was sent. */
      inputSeconds: number;
    }
  | { ok: false; reason: SampleChunkProblem; error: string; detail?: string };

/** Strict base64 → bytes (size checked before decoding). */
export function decodeSampleBase64(text: string): { ok: true; bytes: Uint8Array } | Extract<PreparedSampleChunk, { ok: false }> {
  const b64 = text.trim();
  if (b64.length > SAMPLE_CHUNK_MAX_BASE64) return { ok: false, reason: "too_large", error: "That part of your recording was too big to send." };
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, reason: "not_base64", error: UNREADABLE_ERROR };
  const buf = Buffer.from(b64, "base64");
  return { ok: true, bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
}

/**
 * Validate one uploaded chunk (PCM16 mono WAV, 8–48 kHz, ≤ 10 s, ≤ 1.5 MB), re-count its clean speech with the
 * shared VAD at the file's own rate, and re-encode only the audio that VAD kept (as recorded: the clone's audio is
 * levelled once, when it is merged for cloning).
 *
 * The browser sends only what its own VAD kept, so between two utterances the chunk holds just the browser's hangover
 * and the next pre-roll: hangoverFrames + prerollFrames > maxGapFrames, so the re-count ends the utterance there too and
 * never counts that seam as a pause (it counts what the browser counted, give or take a frame at the chunk's edges).
 */
export function prepareSampleChunk(bytes: Uint8Array): PreparedSampleChunk {
  if (bytes.byteLength > SAMPLE_CHUNK_MAX_BYTES) return { ok: false, reason: "too_large", error: "That part of your recording was too big to send." };
  let decoded: ReturnType<typeof decodeWav>;
  try {
    decoded = decodeWav(bytes);
  } catch (error) {
    return { ok: false, reason: "unsupported_wav", error: UNREADABLE_ERROR, detail: error instanceof Error ? error.message : String(error) };
  }
  const { sampleRate, channels, samples } = decoded;
  if (channels !== 1) return { ok: false, reason: "not_mono", error: UNREADABLE_ERROR, detail: `${channels} channels` };
  if (sampleRate < SAMPLE_CHUNK_MIN_RATE || sampleRate > SAMPLE_CHUNK_MAX_RATE) {
    return { ok: false, reason: "bad_rate", error: UNREADABLE_ERROR, detail: `${sampleRate} Hz` };
  }
  const inputSeconds = samples.length / sampleRate;
  if (inputSeconds > SAMPLE_CHUNK_MAX_SECONDS) {
    return { ok: false, reason: "too_long", error: "That part of your recording was too long to send.", detail: `${inputSeconds.toFixed(1)} s` };
  }

  const counter = new SpeechCounter({ sampleRate });
  const pushed = counter.push(samples);
  // The chunk ends here: a run still being judged is judged whole (the browser kept it because it counted it).
  const tail = counter.flush();
  const kept = new Float32Array(pushed.kept.length + tail.kept.length);
  kept.set(pushed.kept, 0);
  kept.set(tail.kept, pushed.kept.length);
  return {
    ok: true,
    wav: encodeWav(kept, sampleRate),
    sampleRate,
    speechSeconds: Math.round(counter.speechSeconds * 1000) / 1000,
    keptSeconds: kept.length / sampleRate,
    inputSeconds,
  };
}

/** A chunk recorded under an earlier consent. */
export const CONSENT_CHANGED_ERROR = "Your consent changed while recording, so this recording wasn't kept.";

export interface SampleChunkInput {
  sessionId: string;
  seq: number;
  final: boolean;
  audioBase64: string;
  /** The consentGivenAt the recording started under: a chunk is refused (403) if consent was revoked or given again since. */
  consentAt?: string | null;
}

export type SampleChunkResponse =
  | {
      ok: true;
      twin: CustomerTwinView;
      stored: boolean;
      speechSeconds: number;
      /** Why a chunk wasn't stored: 'no_speech' (nothing clean to keep: normal) or the store's refusal reason. */
      reason?: string;
    }
  | { ok: false; error: string; twin?: CustomerTwinView };

export interface SampleChunkOutcome {
  status: 200 | 400 | 403;
  body: SampleChunkResponse;
  /** Kick off maybeStartClone() after responding (the session's last chunk). */
  startClone: boolean;
}

/**
 * The sample route's logic, injectable for tests. Consent is checked before the audio is even decoded (403, nothing
 * stored); storeAudioChunk checks it again, with the twin's state, when the chunk is registered. `speechSeconds` in
 * the reply is what the server counted and stored for this chunk (0 when nothing was stored).
 */
export async function acceptSampleChunk(input: SampleChunkInput, deps: VoiceTwinDeps = liveVoiceTwinDeps()): Promise<SampleChunkOutcome> {
  const row = await deps.store.getTwin();
  if (!row?.voice_twin_consent) {
    return { status: 403, body: { ok: false, error: NO_CONSENT_ERROR, twin: await getCustomerTwinView(deps) }, startClone: false };
  }
  if (input.consentAt !== undefined && input.consentAt !== row.consent_given_at) {
    // Recorded under a consent that was revoked (and maybe given again) since: never kept.
    return { status: 403, body: { ok: false, error: CONSENT_CHANGED_ERROR, twin: await getCustomerTwinView(deps) }, startClone: false };
  }

  const decoded = decodeSampleBase64(input.audioBase64);
  const prepared = decoded.ok ? prepareSampleChunk(decoded.bytes) : decoded;
  if (!prepared.ok) {
    console.warn(`voice twin sample ${input.sessionId}#${input.seq} rejected: ${prepared.reason}${prepared.detail ? ` (${prepared.detail})` : ""}`);
    return { status: 400, body: { ok: false, error: prepared.error, twin: await getCustomerTwinView(deps) }, startClone: false };
  }

  let stored = false;
  let speechSeconds = 0;
  let reason: string | undefined = prepared.keptSeconds > 0 ? undefined : "no_speech";
  if (prepared.keptSeconds > 0) {
    const result = await storeAudioChunk(
      {
        source: "sample",
        callId: null,
        sessionId: input.sessionId,
        seq: input.seq,
        wav: prepared.wav,
        sampleRate: prepared.sampleRate,
        speechSeconds: prepared.speechSeconds,
        ...(input.consentAt !== undefined ? { consentAt: input.consentAt } : {}),
      },
      deps,
    );
    if (!result.stored && (result.reason === "no_consent" || result.reason === "no_twin")) {
      // Revoked between the check above and the insert: nothing was kept.
      return { status: 403, body: { ok: false, error: NO_CONSENT_ERROR, twin: await getCustomerTwinView(deps) }, startClone: false };
    }
    stored = result.stored;
    speechSeconds = result.stored ? prepared.speechSeconds : 0;
    if (!result.stored) reason = result.reason;
  }
  return {
    status: 200,
    body: { ok: true, twin: await getCustomerTwinView(deps), stored, speechSeconds, ...(reason ? { reason } : {}) },
    startClone: input.final,
  };
}
