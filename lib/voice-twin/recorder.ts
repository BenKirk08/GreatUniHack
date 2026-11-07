"use client";

import { VOICE_TWIN_SAMPLE_MAX_SECONDS } from "@/lib/voice-twin/config";
import { SpeechCounter } from "@/lib/voice-twin/vad";
import type { CustomerTwinView } from "@/lib/voice-twin/view";
import { encodeWav, resampleLinear } from "@/lib/voice-twin/wav";

/**
 * "Record a sample now" (Settings), browser only. Only ever started from the Settings button, which is only offered
 * after consent; the server refuses chunks without consent anyway.
 *
 * Why Web Audio PCM → WAV rather than MediaRecorder: MediaRecorder gives webm/opus (or mp4 on Safari), but
 * ElevenLabs' Instant Voice Cloning documents WAV and MP3 uploads, not webm, and WAV is the same format the phone
 * bridge (services/media-bridge) writes, so both sources merge into one clone. We tap raw PCM with an AudioWorklet
 * (ScriptProcessorNode where worklets aren't available), count the clean speech with the shared VAD, keep only that
 * speech, and upload it every ~3 s as a 24 kHz mono PCM16 WAV.
 */

/** Rate of the uploaded WAVs (the AudioContext runs at this rate when the browser allows, else we resample). */
export const SAMPLE_RATE = 24_000;
/** Upload the kept speech about this often. */
const CHUNK_SECONDS = 3;
/** The server accepts seq 0–199 per session. */
const MAX_SEQ = 199;
const UPLOAD_URL = "/api/protect/voice-twin/sample";
/**
 * A chunk this browser counted at least this much clean speech in can't come back "nothing kept" just for want of
 * speech: the server re-counts the same 30 ms frames with the same VAD and can lose at most a couple of frames at the
 * chunk's start. So "stored: false" for it means the server refused it (e.g. the twin stopped collecting).
 */
export const NOT_STORED_MIN_SPEECH_SECONDS = 0.5;

/** The server refused a chunk with 403: consent was revoked, or given again, since the recording started. */
export const CONSENT_CHANGED_MESSAGE = "Your consent changed while recording, so this recording wasn't kept.";
/** A chunk with speech in it came back not stored (the twin isn't collecting any more), so recording stopped. */
export const NOT_STORED_MESSAGE = "Your AI Voice Twin isn't taking new recordings right now, so this recording was stopped.";

/**
 * "aborted": the caller's AbortSignal fired (Settings left while starting or recording, or Revoke & delete); the rest
 * was discarded. "refused": the server refused a chunk (403 when consent changed) or wouldn't keep speech it was sent.
 */
export type RecorderStopReason = "user" | "limit" | "refused" | "twin_busy" | "aborted";

export interface RecorderProgress {
  /** Audio recorded so far. */
  elapsedSeconds: number;
  /** Clean speech counted in this browser so far (the server re-counts it). */
  speechSeconds: number;
  maxSeconds: number;
}

export interface RecorderChunkResult {
  seq: number;
  final: boolean;
  stored: boolean;
  /** Clean speech the server counted and stored for this chunk. */
  speechSeconds: number;
  twin: CustomerTwinView | null;
}

export interface RecorderEvents {
  onProgress?(progress: RecorderProgress): void;
  onChunk?(result: RecorderChunkResult): void;
  /** A plain-language problem (an upload failed twice, or the server refused or wouldn't keep a chunk). */
  onError?(message: string): void;
  /** After the microphone is released and every upload has finished. */
  onEnd?(end: { reason: RecorderStopReason; uploadsFailed: number }): void;
}

export interface SampleRecording {
  readonly sessionId: string;
  /**
   * True once stopping has begun, for whatever reason (stop(), the time limit, the server, or an abort): the
   * microphone is released and only the uploads still queued (normally the final chunk) are left.
   */
  readonly stopped: boolean;
  /**
   * Stop, send what's left as the final chunk, and resolve when the uploads are done. Safe to call twice: a later
   * call (or one after an abort) just returns the first call's promise.
   */
  stop(reason?: RecorderStopReason): Promise<void>;
}

export interface RecorderOptions {
  maxSeconds?: number;
  /**
   * Cancels the recording. While it is still starting (permission prompt, AudioContext, worklet), the start rejects
   * with RecorderAbortedError and anything acquired, including a microphone granted later, is released. Once
   * recording, the microphone is released and nothing more is uploaded (no "final" chunk either); an upload already
   * in flight is left to finish, and stop() resolves once it has.
   */
  signal?: AbortSignal;
  /**
   * The consent the recording is made under (CustomerTwinView.consentGivenAt when it started), sent with every chunk
   * as `consentAt` so the server can refuse (403) chunks once consent has been revoked or given again. Left out of the
   * request body when undefined.
   */
  consentAt?: string | null;
}

/** A start-up problem, with a message fit to show the customer. */
export class RecorderError extends Error {}

/** The start was cancelled through RecorderOptions.signal. Nothing to show the customer. */
export class RecorderAbortedError extends Error {
  constructor() {
    super("The recording was cancelled.");
    this.name = "AbortError";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RecorderAbortedError();
}

/**
 * `promise`, but rejecting with RecorderAbortedError as soon as `signal` aborts, so a pending permission prompt or
 * module load can't hold the caller up. If the abort wins, whatever `promise` resolves to later goes to `dispose`
 * (e.g. the microphone stream granted after the customer left).
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, dispose?: (late: T) => void): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let abandoned = false;
    const onAbort = () => {
      abandoned = true;
      reject(new RecorderAbortedError());
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (abandoned) dispose?.(value);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (!abandoned) reject(error);
      },
    );
  });
}

function stopTracks(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop());
}

/** Base64 without Buffer: chunked String.fromCharCode (keeps the argument list small) then btoa. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

/** A v4 UUID (crypto.randomUUID needs a secure context; getRandomValues doesn't). */
function newSessionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function micErrorMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "We couldn't find a microphone on this device.";
  if (name === "NotReadableError" || name === "AbortError") return "Your microphone is busy. Close other apps using it, then try again.";
  return "We couldn't start the microphone. Please try again.";
}

/**
 * Batches the render quanta (128 samples) into ~4096-sample blocks before posting them to the main thread.
 * Loaded from a Blob URL so no extra file has to be served.
 */
const WORKLET_SOURCE = `
class VoiceTwinTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.on = true;
    this.port.onmessage = () => { this.on = false; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          const out = this.buf;
          this.port.postMessage(out, [out.buffer]);
          this.buf = new Float32Array(4096);
          this.n = 0;
        }
      }
    }
    return this.on;
  }
}
registerProcessor("voice-twin-tap", VoiceTwinTap);
`;

type AudioContextCtor = typeof AudioContext;

function audioContextClass(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext ?? null;
}

interface Tap {
  node: AudioNode;
  stop(): void;
}

/** A node that hands mono Float32 blocks to `onBlock`, and how to stop it. Rejects with RecorderAbortedError on abort. */
async function createTap(ctx: AudioContext, onBlock: (block: Float32Array) => void, signal: AbortSignal | undefined): Promise<Tap> {
  if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
      try {
        await abortable(ctx.audioWorklet.addModule(url), signal);
      } finally {
        URL.revokeObjectURL(url);
      }
      throwIfAborted(signal);
      const node = new AudioWorkletNode(ctx, "voice-twin-tap", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
      });
      node.port.onmessage = (event: MessageEvent<Float32Array>) => onBlock(event.data);
      return {
        node,
        stop: () => {
          node.port.postMessage("stop");
          node.port.onmessage = null;
        },
      };
    } catch (error) {
      if (error instanceof RecorderAbortedError) throw error;
      // Fall back to the ScriptProcessorNode below (deprecated, but available everywhere).
    }
  }
  throwIfAborted(signal);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (event) => onBlock(event.inputBuffer.getChannelData(0).slice());
  return {
    node,
    stop: () => {
      node.onaudioprocess = null;
    },
  };
}

/**
 * Ask for the microphone and start recording. Call it straight from the tap (Safari only starts audio from a user
 * gesture). Throws a RecorderError with a customer-facing message if the microphone can't be used, and a
 * RecorderAbortedError if `opts.signal` aborts before recording starts (everything acquired so far is released and
 * nothing is uploaded).
 */
export async function startSampleRecording(events: RecorderEvents, opts: RecorderOptions = {}): Promise<SampleRecording> {
  const { signal, consentAt } = opts;
  throwIfAborted(signal);
  const maxSeconds = opts.maxSeconds ?? VOICE_TWIN_SAMPLE_MAX_SECONDS;
  const Ctx = audioContextClass();
  if (!Ctx || typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new RecorderError("This browser can't record from the microphone. Try Safari or Chrome.");
  }

  // Create the context inside the tap, at 24 kHz when the browser allows it.
  let ctx: AudioContext;
  try {
    ctx = new Ctx({ sampleRate: SAMPLE_RATE });
  } catch {
    ctx = new Ctx();
  }

  const sessionId = newSessionId();
  const counter = new SpeechCounter({ sampleRate: SAMPLE_RATE });
  let inputRate = SAMPLE_RATE;
  let kept: Float32Array[] = [];
  let totalSamples = 0;
  let lastChunkAt = 0;
  /** counter.speechSeconds when the last chunk was cut (so each chunk knows the speech this browser counted in it). */
  let speechAtLastChunk = 0;
  let nextSeq = 0;
  let stopped = false;
  /** The signal fired: send nothing more and report nothing but the end. */
  let aborted = false;
  let refused = false;
  let uploadsFailed = 0;
  let queue: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | null = null;

  /** Refuse everything from here on (nothing more is sent, not even the final chunk) and stop with `message`. */
  const refuse = (message: string) => {
    refused = true;
    events.onError?.(message);
    void stop("refused");
  };

  /** `localSpeech`: the clean speech this browser counted in the chunk. */
  const upload = async (seq: number, final: boolean, wav: Uint8Array, localSpeech: number): Promise<void> => {
    if (refused || aborted) return;
    const body = JSON.stringify({ sessionId, seq, final, audioBase64: bytesToBase64(wav), consentAt });
    // One retry: the server stores each (session, seq) once, so a repeat is harmless.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (aborted) return;
      try {
        const res = await fetch(UPLOAD_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body,
          signal: AbortSignal.timeout(30_000),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          twin?: CustomerTwinView;
          stored?: boolean;
          speechSeconds?: number;
          /** Why nothing was stored, when the server says ("no_speech" is the harmless one). */
          reason?: string;
        };
        // Discarded while this was in flight: the caller has moved on and wants to hear nothing more.
        if (aborted) return;
        if (res.ok && data.ok !== false) {
          const twin = data.twin ?? null;
          const stored = Boolean(data.stored);
          events.onChunk?.({ seq, final, stored, speechSeconds: data.speechSeconds ?? 0, twin });
          // The twin stopped collecting (e.g. it's being made from what's already there): no point recording on.
          if (twin && twin.state !== "collecting" && twin.state !== "failed") void stop("twin_busy");
          // Speech the server wouldn't keep: say so and stop, rather than recording on into nothing. (The final chunk
          // ends the recording anyway, and a chunk with next to no speech in it is legitimately not kept.)
          else if (!stored && !final && notKept(data.reason, localSpeech)) refuse(NOT_STORED_MESSAGE);
          return;
        }
        if (res.status === 403) {
          refuse(CONSENT_CHANGED_MESSAGE);
          return;
        }
        if (res.status >= 400 && res.status < 500) {
          refuse(data.error ?? "Your recording couldn't be saved.");
          return;
        }
      } catch {
        // Network problem or timeout: retry once.
      }
      if (attempt === 0) await sleep(1_000);
    }
    if (aborted) return;
    uploadsFailed++;
    events.onError?.("Part of your recording couldn't be sent. Check your signal; what was sent is kept.");
  };

  const emitChunk = (final: boolean) => {
    const samples = concat(kept);
    kept = [];
    if (!final && samples.length === 0) return;
    if (nextSeq > MAX_SEQ) return;
    const seq = nextSeq++;
    const localSpeech = counter.speechSeconds - speechAtLastChunk;
    speechAtLastChunk = counter.speechSeconds;
    const wav = encodeWav(samples, SAMPLE_RATE);
    queue = queue.then(() => upload(seq, final, wav, localSpeech));
  };

  const onBlock = (block: Float32Array) => {
    if (stopped) return;
    const at24k = inputRate === SAMPLE_RATE ? block : resampleLinear(block, inputRate, SAMPLE_RATE);
    totalSamples += at24k.length;
    const result = counter.push(at24k);
    if (result.kept.length) kept.push(result.kept);
    events.onProgress?.({ elapsedSeconds: totalSamples / SAMPLE_RATE, speechSeconds: counter.speechSeconds, maxSeconds });
    if (totalSamples >= maxSeconds * SAMPLE_RATE) {
      void stop("limit");
      return;
    }
    if (totalSamples - lastChunkAt >= CHUNK_SECONDS * SAMPLE_RATE) {
      lastChunkAt = totalSamples;
      emitChunk(false);
    }
  };

  // Start-up. Each await can outlast the customer's stay on the page (a permission prompt left open, a slow worklet
  // load), so the signal is checked after every one, and a failure or abort releases whatever was acquired so far.
  // Nothing has been uploaded at this point.
  // (Typed through `as` so the catch below still sees them as possibly set.)
  let stream = null as MediaStream | null;
  let tap = null as Tap | null;
  let source: MediaStreamAudioSourceNode;
  try {
    try {
      // A microphone granted after an abort is stopped as soon as it arrives.
      stream = await abortable(
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        }),
        signal,
        stopTracks,
      );
    } catch (error) {
      if (error instanceof RecorderAbortedError) throw error;
      throw new RecorderError(micErrorMessage(error));
    }
    throwIfAborted(signal);

    try {
      source = ctx.createMediaStreamSource(stream);
    } catch {
      // Firefox can't connect a microphone to a context running at another rate: use the default rate and resample.
      await abortable(ctx.close().catch(() => undefined), signal);
      throwIfAborted(signal);
      ctx = new Ctx();
      try {
        source = ctx.createMediaStreamSource(stream);
      } catch (error) {
        throw new RecorderError(micErrorMessage(error));
      }
    }
    await abortable(ctx.resume().catch(() => undefined), signal);
    throwIfAborted(signal);
    inputRate = ctx.sampleRate;

    try {
      tap = await createTap(ctx, onBlock, signal);
    } catch (error) {
      if (error instanceof RecorderAbortedError) throw error;
      throw new RecorderError("This browser can't record from the microphone. Try Safari or Chrome.");
    }
    throwIfAborted(signal);
  } catch (error) {
    stopped = true;
    tap?.stop();
    if (stream) stopTracks(stream);
    void ctx.close().catch(() => undefined);
    throw error;
  }

  // At most one unfinished block (~0.2 s) is still in the tap when recording stops; it is dropped.
  // Pull the tap through a muted gain so the browser keeps processing it without playing the microphone back.
  const activeTap = tap;
  const activeStream = stream;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(activeTap.node);
  activeTap.node.connect(mute).connect(ctx.destination);
  // Backstop for the limit in case audio stops flowing (e.g. the tab was suspended).
  const limitTimer = setTimeout(() => void stop("limit"), (maxSeconds + 5) * 1_000);

  const release = () => {
    activeTap.stop();
    try {
      source.disconnect();
      activeTap.node.disconnect();
      mute.disconnect();
    } catch {
      // already disconnected
    }
    stopTracks(activeStream);
    void ctx.close().catch(() => undefined);
  };

  // Aborted mid-recording (or while the last chunks are still queued): release the microphone and drop everything
  // not yet sent, including the final chunk. Housekeeping on the server treats the session as idle.
  const onAbort = () => {
    aborted = true;
    void stop("aborted");
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  function stop(reason: RecorderStopReason = "user"): Promise<void> {
    if (stopping) return stopping;
    stopped = true;
    clearTimeout(limitTimer);
    release();
    if (!aborted) {
      // flush() judges the run still in progress: its audio goes into the final chunk, so the upload matches the count.
      const tail = counter.flush();
      if (tail.kept.length) kept.push(tail.kept);
      // Always send a final chunk (even an empty one) so the server knows the session ended and can start the clone.
      emitChunk(true);
    }
    stopping = queue.then(() => {
      signal?.removeEventListener("abort", onAbort);
      // A refusal that came in after stopping began (e.g. a 403 for a chunk sent just before Stop) still ends it as one.
      events.onEnd?.({ reason: aborted ? "aborted" : refused ? "refused" : reason, uploadsFailed });
    });
    return stopping;
  }

  return {
    sessionId,
    get stopped() {
      return stopping !== null;
    },
    stop,
  };
}

/**
 * Whether a chunk the server answered "stored: false" means it refused the recording (rather than finding no speech
 * worth keeping). The server's own reason wins when it gives one; otherwise it's judged by the speech this browser
 * counted in the chunk (see NOT_STORED_MIN_SPEECH_SECONDS).
 */
export function notKept(reason: string | undefined, localSpeechSeconds: number): boolean {
  if (typeof reason === "string" && reason) return reason !== "no_speech";
  return localSpeechSeconds >= NOT_STORED_MIN_SPEECH_SECONDS;
}

/**
 * The one sample recording a page owns, from the tap on Start until it ends, and what each way of ending it does.
 * Plain object, kept out of the component so the rules can be tested:
 * - leave(): the page is being hidden (Next keeps pages in an <Activity>) or unmounted. A recording still starting or
 *   recording is cancelled: the microphone is released and nothing more is sent. One already stopping (Stop tapped,
 *   or the limit reached) is left to send its final chunk, which the customer asked to keep.
 * - discard(): Revoke & delete. Cancels it in any phase, even one already stopping, and drops everything unsent.
 * Whatever cancels a recording takes it out of the slot first, so the recorder's own late callbacks (the start
 * rejecting, onEnd) see it's no longer owned and leave the page alone.
 */
export class SampleRecordingSlot {
  private controller: AbortController | null = null;
  private recording: SampleRecording | null = null;

  /** Whether a recording is owned (starting, recording or still sending). */
  get busy(): boolean {
    return this.controller !== null;
  }

  /** Own a new recording: its controller (pass `.signal` to startSampleRecording), or null if one is already owned. */
  claim(): AbortController | null {
    if (this.controller) return null;
    this.controller = new AbortController();
    this.recording = null;
    return this.controller;
  }

  /** Still the owned recording (not left, discarded or ended). */
  owns(controller: AbortController): boolean {
    return this.controller === controller;
  }

  /** The recorder finished starting. False when it's no longer owned (it was cancelled and discards itself). */
  started(controller: AbortController, recording: SampleRecording): boolean {
    if (!this.owns(controller)) return false;
    this.recording = recording;
    return true;
  }

  /** "Stop" tapped: send the rest as the final chunk. Null when there's no started recording to stop. */
  stop(): Promise<void> | null {
    return this.recording ? this.recording.stop("user") : null;
  }

  /**
   * The recording ended, or failed to start: stop owning it. True when it was still owned, so the caller resets the
   * page; false when it had already been left or discarded (whoever did that has reset the page).
   */
  release(controller: AbortController): boolean {
    if (!this.owns(controller)) return false;
    this.controller = null;
    this.recording = null;
    return true;
  }

  /** The page is being hidden or unmounted. True when a recording was cancelled, so the page resets to idle. */
  leave(): boolean {
    const controller = this.controller;
    if (!controller || this.recording?.stopped) return false;
    this.controller = null;
    this.recording = null;
    controller.abort();
    return true;
  }

  /** Revoke & delete: cancel whatever is owned. Resolves once an upload already in flight has finished. */
  async discard(): Promise<void> {
    const controller = this.controller;
    const active = this.recording;
    this.controller = null;
    this.recording = null;
    controller?.abort();
    await active?.stop();
  }
}
