import type { VoiceTwinRow } from "@/lib/types";
import type { StreamTokenPayload } from "@/lib/voice-twin/capture";
import { decodeMulaw } from "@/lib/voice-twin/mulaw";
import type { CloneOutcome, StoreChunkInput, StoreChunkResult } from "@/lib/voice-twin/service";
import { SpeechCounter, type PushResult } from "@/lib/voice-twin/vad";
import { encodeWav } from "@/lib/voice-twin/wav";

/**
 * One Twilio Media Stream (one websocket) carrying the customer's own leg of a screened call: verify it, then turn the
 * μ-law audio into clean-speech WAV chunks for the AI Voice Twin. Nothing is stored unless the stream token verifies,
 * only the inbound track (what the customer says) is streamed, the token is for this very call leg, and the account
 * holder's consent is the very consent the token was made under (consent_given_at). That consent and the twin's state
 * are re-read on every tick and right before every chunk is stored; the server re-checks consent, twin state and the
 * flagged-call rule again for every chunk. Whenever capturing stops for good (a refusal, a revoke, the twin is ready)
 * the buffered audio is discarded and the websocket is closed, so Twilio stops streaming (the call itself goes on).
 * Everything is injected, so tests run without network or timers. Audio, tokens and full CallSids are never logged.
 */

/** Twilio Media Streams audio: G.711 μ-law, 8 kHz, mono. */
export const MEDIA_SAMPLE_RATE = 8000;
/** Store a chunk once this much new clean speech is buffered… (keeps the live progress bar filling smoothly) */
export const FLUSH_SPEECH_SECONDS = 1;
/** …or once buffered speech (any amount) has waited this long since the last flush. */
export const FLUSH_INTERVAL_MS = 2_000;
/** How often an open session checks for a due flush and a due clone. */
export const SESSION_TICK_MS = 3_000;
/** One 20 ms frame is 160 bytes; anything far bigger isn't Twilio. */
const MAX_MEDIA_BYTES = 16_000;
/** Websocket close code for a refused stream (policy violation). */
export const CLOSE_POLICY = 1008;
/** Websocket close code for a stream the bridge is done with (normal closure): Twilio stops streaming, the call goes on. */
export const CLOSE_NORMAL = 1000;

export interface SessionTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** What a session needs to know about the account holder's twin. */
export type SessionTwin = Pick<VoiceTwinRow, "id" | "voice_twin_consent" | "consent_given_at" | "state">;

export interface MediaSessionDeps {
  /** verifyStreamToken with the bridge's secret and clock. */
  verifyToken(token: string): StreamTokenPayload | null;
  /** The account holder's twin: consent is checked at start, on every tick and right before anything is stored. */
  getTwin(): Promise<SessionTwin | null>;
  /** storeAudioChunk (consent, state and flagged-call gates; idempotent per session + seq). */
  storeChunk(input: StoreChunkInput): Promise<StoreChunkResult>;
  /** maybeStartClone (claims atomically; consent and the minimum checked again server-side). */
  maybeStartClone(): Promise<CloneOutcome>;
  /** VOICE_TWIN_MIN_SECONDS. */
  minSeconds(): number;
  now(): number;
  /** Close the websocket. */
  close(code: number, reason: string): void;
  /** The session's tick timer. Default: the global timers; null drives tick() by hand (tests). */
  timers?: SessionTimers | null;
  log?(level: "info" | "warn" | "error", message: string): void;
}

export type MediaSessionPhase = "waiting" | "capturing" | "halted" | "rejected" | "ended";

export interface MediaSessionStats {
  phase: MediaSessionPhase;
  chunksStored: number;
  /** Clean speech stored by this session. */
  speechSecondsStored: number;
  /** The twin's total speech_seconds after the last stored chunk. */
  twinSpeechSeconds: number;
}

export interface MediaSession {
  onMessage(text: string): Promise<void>;
  onClose(): Promise<void>;
  /**
   * The periodic check (run every SESSION_TICK_MS by the session's timer): consent and the twin's state again (as part of
   * a due flush, or on their own), then a due clone attempt.
   */
  tick(): Promise<void>;
  /** Resolves once queued work and this session's clone attempt (if any) have finished. */
  settled(): Promise<void>;
  stats(): MediaSessionStats;
}

const globalTimers: SessionTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function defaultLog(level: "info" | "warn" | "error", message: string) {
  console[level](`media bridge: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why audio from this stream may not be kept, or null if it may: the twin must exist with consent, be the token's
 * twin, still hold the very consent the token was made under (a revoke, or a revoke and a new consent, changes
 * consent_given_at), and still need audio. Short reasons: they double as the websocket close reason.
 */
export function captureProblem(twin: SessionTwin | null, token: StreamTokenPayload): string | null {
  if (!twin || twin.voice_twin_consent !== true) return "no consent";
  if (twin.id !== token.twinId) return "the stream is for another AI Voice Twin";
  if (!twin.consent_given_at || twin.consent_given_at !== token.consentAt) return "consent changed";
  if (twin.state !== "collecting" && twin.state !== "failed") return "the AI Voice Twin doesn't need more audio";
  return null;
}

function concat(parts: Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Twilio Media Streams JSON events → verified, consent-checked, VAD-filtered WAV chunks. */
export function createMediaSession(deps: MediaSessionDeps): MediaSession {
  const log = deps.log ?? defaultLog;
  const timers = deps.timers === undefined ? globalTimers : deps.timers;

  let phase: MediaSessionPhase = "waiting";
  let label = "stream";
  let stream: { token: StreamTokenPayload; streamSid: string } | null = null;
  let counter: SpeechCounter | null = null;
  let timer: unknown = null;

  let buffered: Float32Array[] = [];
  let bufferedSamples = 0;
  /** Counted clean speech in the buffer. */
  let bufferedSpeech = 0;
  /** When the last flush happened, or the buffer's first counted speech arrived if that is later. */
  let flushClockFrom = 0;
  let seq = 0;

  let chunksStored = 0;
  let speechSecondsStored = 0;
  let twinSpeechSeconds = 0;

  let cloneInFlight: Promise<void> | null = null;
  let cloneFinished = false;

  let queue: Promise<void> = Promise.resolve();
  /** Run work strictly in arrival order (one stream's messages, flushes and stores never interleave). */
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work).catch((error) => log("error", `${label}: ${describe(error)}`));
    return queue;
  };

  const stopTimer = () => {
    if (timer !== null && timers) timers.clearInterval(timer);
    timer = null;
  };

  const clearBuffer = () => {
    buffered = [];
    bufferedSamples = 0;
    bufferedSpeech = 0;
  };

  const dropAudio = () => {
    clearBuffer();
    counter = null;
  };

  const closeSocket = (code: number, reason: string) => {
    try {
      deps.close(code, reason);
    } catch (error) {
      log("warn", `${label}: could not close the websocket (${describe(error)})`);
    }
  };

  const reject = (reason: string) => {
    phase = "rejected";
    dropAudio();
    stopTimer();
    log("warn", `${label}: refused (${reason})`);
    closeSocket(CLOSE_POLICY, reason);
  };

  /**
   * Stop capturing for the rest of this stream: discard what is buffered (none of it is stored) and close the websocket
   * normally, so Twilio stops streaming the customer's voice here. The call itself goes on.
   */
  const halt = (reason: string) => {
    if (phase !== "capturing") return;
    phase = "halted";
    dropAudio();
    stopTimer();
    log("info", `${label}: stopped capturing (${reason})`);
    closeSocket(CLOSE_NORMAL, reason);
  };

  /**
   * Re-read the twin: "ok" while this stream may still keep audio, "halted" once it may not (the stream is halted
   * here), "unknown" when the twin couldn't be read (nothing may be stored on that basis; the caller decides the rest).
   */
  const recheck = async (): Promise<"ok" | "halted" | "unknown"> => {
    if (!stream || phase !== "capturing") return "halted";
    let twin: SessionTwin | null;
    try {
      twin = await deps.getTwin();
    } catch (error) {
      log("error", `${label}: could not re-check consent (${describe(error)})`);
      return "unknown";
    }
    if (phase !== "capturing") return "halted"; // halted meanwhile (e.g. the twin became ready)
    const problem = captureProblem(twin, stream.token);
    if (!problem) return "ok";
    halt(problem);
    return "halted";
  };

  const maybeClone = () => {
    if (cloneInFlight || cloneFinished || twinSpeechSeconds < deps.minSeconds()) return;
    cloneInFlight = (async () => {
      try {
        const result = await deps.maybeStartClone();
        // Not enough eligible audio yet (e.g. the call isn't flagged yet) or a clone already running: the next tick asks again.
        if (result.outcome === "skipped" && (result.reason === "not_enough_audio" || result.reason === "busy")) return;
        cloneFinished = true;
        log("info", `${label}: AI Voice Twin clone ${result.outcome}${result.outcome === "skipped" ? ` (${result.reason})` : ""}`);
        if (result.outcome === "ready") halt("the AI Voice Twin is ready");
      } catch (error) {
        log("error", `${label}: starting the clone failed (${describe(error)}); retrying on the next tick`);
      } finally {
        cloneInFlight = null;
      }
    })();
  };

  const flush = async () => {
    if (!stream || bufferedSpeech <= 0 || bufferedSamples === 0) return;
    // Consent (the token's very consent) and the twin's state, right before anything is stored.
    const check = await recheck();
    if (check === "halted") return;
    if (check === "unknown") {
      // Like a store error: this chunk is lost, the next flush checks again.
      clearBuffer();
      flushClockFrom = deps.now();
      log("warn", `${label}: discarded buffered audio (consent could not be re-checked)`);
      return;
    }
    const samples = concat(buffered, bufferedSamples);
    const speechSeconds = bufferedSpeech;
    buffered = [];
    bufferedSamples = 0;
    bufferedSpeech = 0;
    flushClockFrom = deps.now();
    const chunkSeq = seq++;

    let result: StoreChunkResult;
    try {
      result = await deps.storeChunk({
        source: "call",
        callId: stream.token.callId,
        sessionId: stream.streamSid,
        seq: chunkSeq,
        // As recorded: the clone's audio is levelled once, over the merged file, when it is cloned (runClone).
        wav: encodeWav(samples, MEDIA_SAMPLE_RATE),
        sampleRate: MEDIA_SAMPLE_RATE,
        speechSeconds,
        // The consent this stream was started under: storeAudioChunk refuses the chunk if it has changed since.
        consentAt: stream.token.consentAt,
      });
    } catch (error) {
      log("error", `${label}: chunk ${chunkSeq} was not stored (${describe(error)})`);
      return;
    }
    if (!result.stored) {
      // no_consent, not_collecting, call_not_flagged, no_twin, missing_call, missing: none of them changes mid-stream.
      halt(`audio refused (${result.reason})`);
      return;
    }
    chunksStored++;
    speechSecondsStored += speechSeconds;
    twinSpeechSeconds = result.twin.speech_seconds;
    maybeClone();
  };

  const flushDue = (force: boolean) =>
    bufferedSpeech > 0 && (force || bufferedSpeech >= FLUSH_SPEECH_SECONDS || deps.now() - flushClockFrom >= FLUSH_INTERVAL_MS);

  const flushIfDue = async (force: boolean) => {
    if (flushDue(force)) await flush();
  };

  const handleStart = async (message: Record<string, unknown>) => {
    if (phase !== "waiting") {
      log("warn", `${label}: ignored a second "start" event`);
      return;
    }
    const start = isRecord(message.start) ? message.start : {};
    const sid = start.streamSid ?? message.streamSid;
    const streamSid = typeof sid === "string" ? sid : "";
    if (/^[A-Za-z0-9]{8,64}$/.test(streamSid)) label = `stream …${streamSid.slice(-6)}`;
    const parameters = isRecord(start.customParameters) ? start.customParameters : {};
    const format = isRecord(start.mediaFormat) ? start.mediaFormat : {};

    const token = typeof parameters.token === "string" ? deps.verifyToken(parameters.token) : null;
    if (!token) return reject("invalid stream token");
    if (!(Array.isArray(start.tracks) && start.tracks.length === 1 && start.tracks[0] === "inbound")) {
      return reject("only the customer's inbound track may be streamed");
    }
    const mono = format.channels === undefined || Number(format.channels) === 1;
    if (format.encoding !== "audio/x-mulaw" || Number(format.sampleRate) !== MEDIA_SAMPLE_RATE || !mono) {
      return reject("expected mono audio/x-mulaw at 8000 Hz");
    }
    if (typeof start.callSid !== "string" || start.callSid !== token.childCallSid) {
      return reject("the stream is not on the customer's call leg");
    }
    if (!/^[A-Za-z0-9]{8,64}$/.test(streamSid)) return reject("missing streamSid");

    // The consent gate, before a single sample is kept: the very consent the token was made under.
    let twin: SessionTwin | null;
    try {
      twin = await deps.getTwin();
    } catch (error) {
      log("error", `${label}: could not check consent (${describe(error)})`);
      return reject("could not check consent");
    }
    const problem = captureProblem(twin, token);
    if (problem) return reject(problem);

    stream = { token, streamSid };
    label = `stream …${streamSid.slice(-6)} (call ${token.callId.slice(0, 8)})`;
    counter = new SpeechCounter({ sampleRate: MEDIA_SAMPLE_RATE });
    flushClockFrom = deps.now();
    phase = "capturing";
    if (timers) timer = timers.setInterval(() => void session.tick(), SESSION_TICK_MS);
    log("info", `${label}: capturing the customer's voice for their AI Voice Twin`);
  };

  /** Add what the VAD kept (and counted) to the buffer. */
  const buffer = (result: PushResult) => {
    if (result.kept.length) {
      if (bufferedSpeech <= 0 && result.speechSeconds > 0) flushClockFrom = Math.max(flushClockFrom, deps.now());
      buffered.push(result.kept);
      bufferedSamples += result.kept.length;
    }
    bufferedSpeech += result.speechSeconds;
  };

  const handleMedia = async (message: Record<string, unknown>) => {
    if (phase !== "capturing" || !counter) return;
    const media = isRecord(message.media) ? message.media : null;
    // Only ever the customer's own (inbound) track.
    if (!media || media.track !== "inbound" || typeof media.payload !== "string") return;
    const bytes = Buffer.from(media.payload, "base64");
    if (bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) return;
    buffer(counter.push(decodeMulaw(bytes)));
    await flushIfDue(false);
  };

  /** "stop" or the socket closing: store what is buffered, then one last clone check (the tick timer stops here). */
  const finish = async () => {
    if (phase === "rejected" || phase === "ended") return;
    const wasCapturing = phase === "capturing";
    if (wasCapturing) {
      // The stream ends here: a run the VAD was still judging is judged whole (and buffered if it counts).
      if (counter) buffer(counter.flush());
      await flushIfDue(true);
    }
    const capturedUntilTheEnd = wasCapturing && phase === "capturing";
    if (stream) log("info", `${label}: ended (${chunksStored} chunk(s), ${speechSecondsStored.toFixed(1)} s of speech stored)`);
    phase = "ended";
    stopTimer();
    dropAudio();
    if (capturedUntilTheEnd) maybeClone();
  };

  const handle = async (text: string) => {
    if (phase === "rejected" || phase === "ended") return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      log("warn", `${label}: ignored a message that isn't JSON`);
      return;
    }
    if (!isRecord(message)) return;
    switch (message.event) {
      case "start":
        return handleStart(message);
      case "media":
        return handleMedia(message);
      case "stop":
        return finish();
      default:
        return; // connected, mark, dtmf: nothing to do
    }
  };

  const session: MediaSession = {
    onMessage: (text) => enqueue(() => handle(text)),
    onClose: () => enqueue(finish),
    tick: async () => {
      await enqueue(async () => {
        if (phase !== "capturing") return;
        // A due flush re-checks consent itself; otherwise re-check it here, so a revoke ends the stream within a tick.
        if (flushDue(false)) await flush();
        else await recheck();
      });
      if (phase === "capturing") maybeClone();
    },
    settled: async () => {
      await queue;
      while (cloneInFlight) await cloneInFlight;
    },
    stats: () => ({ phase, chunksStored, speechSecondsStored, twinSpeechSeconds }),
  };
  return session;
}

/* ---------- the bridge's lifecycle (used by server.ts, kept here so it can be tested without a server) ---------- */

export type BridgeLogLevel = "debug" | "info" | "warn" | "error";

/** Work the bridge must not exit in the middle of, above all a clone attempt (its new ElevenLabs voice would never be recorded). */
export interface InFlightWork {
  /** Track `work` under `label` until it settles; returns `work` unchanged (rejections still reach the caller). */
  track<T>(label: string, work: Promise<T>): Promise<T>;
  /** What is still running, oldest first. */
  pending(): { label: string; startedAt: number }[];
  /** True once nothing is in flight (work started while waiting counts too), false if that takes longer than timeoutMs. */
  drained(timeoutMs: number): Promise<boolean>;
}

export interface ShutdownTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const globalTimeouts: ShutdownTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Resolves true when `work` settles within ms, false otherwise (work that rejects counts as settled). */
function settlesWithin(work: Promise<unknown>, ms: number, timers: ShutdownTimers): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const handle = timers.setTimeout(() => resolve(false), Math.max(0, ms));
    const settled = () => {
      timers.clearTimeout(handle);
      resolve(true);
    };
    work.then(settled, settled);
  });
}

export function createInFlightWork(opts: { now?: () => number; timers?: ShutdownTimers } = {}): InFlightWork {
  const now = opts.now ?? Date.now;
  const timers = opts.timers ?? globalTimeouts;
  const items = new Map<number, { label: string; startedAt: number; done: Promise<void> }>();
  let next = 0;
  return {
    track(label, work) {
      const id = next++;
      const settled = () => {
        items.delete(id);
      };
      items.set(id, { label, startedAt: now(), done: work.then(settled, settled) });
      return work;
    },
    pending: () => [...items.values()].map(({ label, startedAt }) => ({ label, startedAt })),
    async drained(timeoutMs) {
      const deadline = now() + timeoutMs;
      while (items.size > 0) {
        const remaining = deadline - now();
        if (remaining <= 0) return false;
        const settled = await settlesWithin(Promise.all([...items.values()].map((i) => i.done)), remaining, timers);
        if (!settled) return items.size === 0;
      }
      return true;
    },
  };
}

/** "an AI Voice Twin clone attempt (running 12 s), a call stream storing its last audio (running 1 s)". */
export function describeInFlight(pending: { label: string; startedAt: number }[], nowMs: number): string {
  return pending.map((p) => `${p.label} (running ${Math.max(0, Math.round((nowMs - p.startedAt) / 1000))} s)`).join(", ");
}

/** How long Ctrl-C / SIGTERM waits for clone attempts (and streams storing their last audio) before exiting anyway. */
export const SHUTDOWN_CLONE_WAIT_MS = 55_000;
/** How long each other shutdown step (unregistering, closing streams, closing the tunnel) may take. */
export const SHUTDOWN_STEP_MS = 5_000;
/**
 * A signal this soon after the first is the same Ctrl-C arriving twice, not a second press: under `npm run media-bridge`
 * the terminal signals the whole process group and npm/tsx forward it as well, about 30 ms apart.
 */
export const SHUTDOWN_REPEAT_SIGNAL_MS = 1_500;

export interface BridgeShutdownPlan {
  /** Stop the heartbeat and housekeeping and remove the bridge from media_bridges, so the app starts no new streams here. */
  unregister(): Promise<void>;
  /** Stop listening: new connections and websocket upgrades are refused. */
  stopAccepting(): void;
  /** Close every open stream; each one stores what it has buffered (and may start a clone), as on a normal close. */
  closeSessions(): Promise<void>;
  /** Clone attempts (and housekeeping, streams still storing their last audio) to wait for before exiting. */
  inFlight: InFlightWork;
  /** Close the public tunnel. */
  release(): Promise<void>;
  exit(code: number): void;
  log(level: BridgeLogLevel, message: string): void;
  now?(): number;
  timers?: ShutdownTimers;
}

/**
 * The bridge's Ctrl-C / SIGTERM handler: unregister, stop accepting connections, close the streams (each flushes),
 * wait up to SHUTDOWN_CLONE_WAIT_MS for clone attempts in flight (so a voice ElevenLabs makes is recorded, or deleted
 * when its claim was lost), close the tunnel, exit. A second signal while this runs exits at once, unless it comes
 * within SHUTDOWN_REPEAT_SIGNAL_MS of the first: that is the same Ctrl-C delivered twice, so it is logged at debug and
 * ignored.
 */
export function createBridgeShutdown(
  plan: BridgeShutdownPlan,
  limits: { stepMs?: number; cloneWaitMs?: number; repeatSignalMs?: number } = {},
): (signal: string) => Promise<void> {
  const stepMs = limits.stepMs ?? SHUTDOWN_STEP_MS;
  const cloneWaitMs = limits.cloneWaitMs ?? SHUTDOWN_CLONE_WAIT_MS;
  const repeatSignalMs = limits.repeatSignalMs ?? SHUTDOWN_REPEAT_SIGNAL_MS;
  const now = plan.now ?? Date.now;
  const timers = plan.timers ?? globalTimeouts;
  /** When the first signal arrived; null until then. */
  let firstSignal: { signal: string; at: number } | null = null;

  /** One step, capped at `ms`: an error or a hang is logged and shutdown carries on. */
  const step = async (what: string, work: () => Promise<void>, ms: number) => {
    let failed = false;
    const run = (async () => work())().catch((error: unknown) => {
      failed = true;
      plan.log("error", `${what} failed (${describe(error)})`);
    });
    if (!(await settlesWithin(run, ms, timers)) && !failed) plan.log("warn", `${what} took over ${Math.round(ms / 1000)} s; carrying on`);
  };

  return async (signal) => {
    if (firstSignal) {
      const sinceFirst = now() - firstSignal.at;
      if (sinceFirst < repeatSignalMs) {
        // The terminal and npm/tsx each pass the one keypress on: exiting now would skip the clone wait and unregistering.
        plan.log(
          "debug",
          `${signal} ${Math.max(0, Math.round(sinceFirst))} ms after ${firstSignal.signal}: taken as the same keypress ` +
            "passed on twice (terminal and npm/tsx); ignored",
        );
        return;
      }
      const pending = plan.inFlight.pending();
      plan.log(
        "warn",
        pending.length
          ? `second ${signal}: exiting now without waiting for ${describeInFlight(pending, now())}. An AI Voice Twin ` +
              "clone may be left orphaned at ElevenLabs; housekeeping will sweep it."
          : `second ${signal}: exiting now`,
      );
      plan.exit(1);
      return;
    }
    firstSignal = { signal, at: now() };
    plan.log(
      "info",
      `${signal}: unregistering and stopping (${signal} again, ${repeatSignalMs / 1000} s or more from now, to exit at once)`,
    );

    await step("unregistering the bridge", () => plan.unregister(), stepMs);
    try {
      plan.stopAccepting();
    } catch (error) {
      plan.log("error", `stopping the listener failed (${describe(error)})`);
    }
    await step("closing the streams", () => plan.closeSessions(), stepMs);

    const pending = plan.inFlight.pending();
    let drained = true;
    if (pending.length) {
      plan.log("info", `waiting up to ${Math.round(cloneWaitMs / 1000)} s for ${describeInFlight(pending, now())}`);
      drained = await plan.inFlight.drained(cloneWaitMs);
      if (!drained) {
        plan.log(
          "warn",
          `gave up waiting after ${Math.round(cloneWaitMs / 1000)} s for ${describeInFlight(plan.inFlight.pending(), now())}. ` +
            "An AI Voice Twin clone may be left orphaned at ElevenLabs; housekeeping will sweep it.",
        );
      }
    }

    await step("closing the tunnel", () => plan.release(), stepMs);
    plan.exit(drained ? 0 : 1);
  };
}

const STRAY_SOCKET_ERROR_CODES = new Set(["EPIPE", "ECONNRESET", "ECONNABORTED"]);

/** A socket error the peer caused (hung up mid-write, reset): never a reason for the bridge to die. */
export function isStraySocketError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && STRAY_SOCKET_ERROR_CODES.has(code);
}
