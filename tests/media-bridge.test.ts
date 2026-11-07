import { describe, expect, it, vi } from "vitest";
import {
  captureProblem,
  CLOSE_NORMAL,
  createBridgeShutdown,
  createInFlightWork,
  createMediaSession,
  describeInFlight,
  FLUSH_INTERVAL_MS,
  isStraySocketError,
  MEDIA_SAMPLE_RATE,
  SESSION_TICK_MS,
  SHUTDOWN_CLONE_WAIT_MS,
  SHUTDOWN_REPEAT_SIGNAL_MS,
  type BridgeLogLevel,
  type BridgeShutdownPlan,
  type MediaSessionDeps,
  type SessionTimers,
  type SessionTwin,
} from "@/services/media-bridge/session";
import type { VoiceTwinRow, VoiceTwinState } from "@/lib/types";
import { streamToken, verifyStreamToken, type StreamTokenPayload } from "@/lib/voice-twin/capture";
import { MemoryVoiceTwin } from "@/lib/voice-twin/memory-store";
import { encodeMulaw } from "@/lib/voice-twin/mulaw";
import { DEFAULT_VAD } from "@/lib/voice-twin/vad";
import {
  giveConsent,
  maybeStartClone,
  revokeAndDelete,
  storeAudioChunk,
  type CloneOutcome,
  type StoreChunkInput,
  type StoreChunkResult,
} from "@/lib/voice-twin/service";
import { decodeWav, wavDurationSeconds } from "@/lib/voice-twin/wav";
import { speechLikePcm16 } from "./helpers/voice-fixtures";

const SECRET = "tool-secret-0123456789abcdef";
const CALL_ID = "11111111-1111-4111-8111-111111111111";
const TWIN_ID = "77777777-7777-4777-8777-777777777777";
const CHILD = `CA${"b".repeat(32)}`;
const PARENT = `CA${"a".repeat(32)}`;
const STREAM = `MZ${"c".repeat(32)}`;
const START_MS = Date.parse("2026-11-06T12:00:00.000Z");
/** When the account holder consented (the stream token is made under this consent). */
const CONSENT_AT = "2026-11-06T11:00:00.000Z";
/** A later consent: what consent_given_at reads after a revoke and a new consent. */
const NEW_CONSENT_AT = "2026-11-06T12:00:30.000Z";
const FRAME_SECONDS = 0.03; // the VAD's 30 ms frames (240 samples at 8 kHz)

/* ---------- real μ-law audio ---------- */

/** Continuous speech-like audio at the given active RMS level as PCM16 (what the bridge's VAD counts as speech). */
function voice(seconds: number, dbfs = -20): Int16Array {
  return speechLikePcm16(MEDIA_SAMPLE_RATE, seconds, dbfs, { gaps: false });
}

function silence(seconds: number): Int16Array {
  return new Int16Array(Math.round(MEDIA_SAMPLE_RATE * seconds));
}

/** Twilio-style payloads: μ-law, 160 bytes (20 ms) each, base64. */
function payloads(pcm: Int16Array): string[] {
  const mulaw = encodeMulaw(pcm);
  const out: string[] = [];
  for (let i = 0; i < mulaw.length; i += 160) out.push(Buffer.from(mulaw.subarray(i, i + 160)).toString("base64"));
  return out;
}

function rms(samples: Int16Array): number {
  let sum = 0;
  for (const s of samples) sum += (s / 32768) ** 2;
  return Math.sqrt(sum / samples.length);
}

/* ---------- Twilio Media Streams messages ---------- */

const connected = JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" });

interface StartOverrides {
  token?: string | null;
  tracks?: string[];
  callSid?: string;
  encoding?: string;
  sampleRate?: number;
  streamSid?: string;
}

function startMessage(o: StartOverrides = {}): string {
  const token = o.token === undefined ? goodToken() : o.token;
  return JSON.stringify({
    event: "start",
    sequenceNumber: "1",
    start: {
      accountSid: `AC${"1".repeat(32)}`,
      streamSid: o.streamSid ?? STREAM,
      callSid: o.callSid ?? CHILD,
      tracks: o.tracks ?? ["inbound"],
      customParameters: token === null ? {} : { token },
      mediaFormat: { encoding: o.encoding ?? "audio/x-mulaw", sampleRate: o.sampleRate ?? 8000, channels: 1 },
    },
    streamSid: o.streamSid ?? STREAM,
  });
}

function mediaMessage(payload: string, chunk: number, track = "inbound"): string {
  return JSON.stringify({ event: "media", sequenceNumber: String(chunk + 1), media: { track, chunk: String(chunk), timestamp: String(chunk * 20), payload }, streamSid: STREAM });
}

const stopMessage = JSON.stringify({ event: "stop", sequenceNumber: "9999", stop: { accountSid: `AC${"1".repeat(32)}`, callSid: CHILD }, streamSid: STREAM });

function goodToken(overrides: Partial<StreamTokenPayload> = {}, secret = SECRET): string {
  return streamToken(
    { callId: CALL_ID, twinId: TWIN_ID, childCallSid: CHILD, consentAt: CONSENT_AT, exp: START_MS / 1000 + 7200, ...overrides },
    secret,
  );
}

/** The consenting, collecting twin the default token was made for. */
const consentingTwin: SessionTwin = { id: TWIN_ID, voice_twin_consent: true, consent_given_at: CONSENT_AT, state: "collecting" };

/* ---------- fake deps ---------- */

interface HarnessOptions {
  twin?: SessionTwin | null;
  minSeconds?: number;
  /** Override the store's answer (default: accept, adding to a running total). */
  store?: (input: StoreChunkInput, total: number) => StoreChunkResult | null;
  clone?: () => Promise<CloneOutcome>;
  timers?: SessionTimers | null;
}

function twinRow(speech: number, state: VoiceTwinState = "collecting"): VoiceTwinRow {
  return { ...new MemoryVoiceTwin(START_MS).withConsent().twin!, id: TWIN_ID, speech_seconds: speech, state };
}

function harness(o: HarnessOptions = {}) {
  const clock = { now: START_MS };
  let total = 0;
  const chunks: StoreChunkInput[] = [];
  const storeChunk = vi.fn(async (input: StoreChunkInput): Promise<StoreChunkResult> => {
    const custom = o.store?.(input, total);
    if (custom) return custom;
    chunks.push(input);
    total += input.speechSeconds;
    return { stored: true, duplicate: false, speechSeconds: total, twin: twinRow(total) };
  });
  /** What getTwin answers: change it mid-stream with setTwin (a revoke, a new consent, the twin becoming ready…). */
  let currentTwin: SessionTwin | null = o.twin === undefined ? { ...consentingTwin } : o.twin;
  const setTwin = (twin: SessionTwin | null) => {
    currentTwin = twin;
  };
  const getTwin = vi.fn(async (): Promise<SessionTwin | null> => (currentTwin ? { ...currentTwin } : null));
  const maybeStartCloneFake = vi.fn(o.clone ?? (async (): Promise<CloneOutcome> => ({ outcome: "skipped", reason: "not_enough_audio" })));
  const close = vi.fn<MediaSessionDeps["close"]>();
  const logs: string[] = [];
  const session = createMediaSession({
    verifyToken: (token) => verifyStreamToken(token, SECRET, clock.now),
    getTwin,
    storeChunk,
    maybeStartClone: maybeStartCloneFake,
    minSeconds: () => o.minSeconds ?? 30,
    now: () => clock.now,
    close,
    timers: o.timers === undefined ? null : o.timers,
    log: (level, message) => logs.push(`${level}: ${message}`),
  });

  /** Send audio as 20 ms media messages, advancing the clock like a real stream. */
  const send = async (pcm: Int16Array, track = "inbound") => {
    for (const p of payloads(pcm)) {
      clock.now += 20;
      await session.onMessage(mediaMessage(p, Math.round((clock.now - START_MS) / 20), track));
    }
  };
  return { session, clock, chunks, storeChunk, getTwin, setTwin, maybeStartClone: maybeStartCloneFake, close, logs, send };
}

async function started(o: HarnessOptions = {}) {
  const h = harness(o);
  await h.session.onMessage(connected);
  await h.session.onMessage(startMessage());
  expect(h.close).not.toHaveBeenCalled();
  expect(h.session.stats().phase).toBe("capturing");
  return h;
}

/* ---------- tests ---------- */

describe("media bridge session: capture", () => {
  it("counts clean speech and stores decodable 8 kHz WAV chunks with seq 0, 1, 2…", async () => {
    const h = await started();
    await h.send(voice(5));
    await h.send(silence(1));
    await h.session.onMessage(stopMessage);

    // Seq numbers run 0, 1, 2, … with no gaps.
    expect(h.chunks.map((c) => c.seq)).toEqual(h.chunks.map((_, i) => i));
    for (const c of h.chunks) {
      expect(c).toMatchObject({ source: "call", callId: CALL_ID, sessionId: STREAM, sampleRate: 8000 });
      const wav = decodeWav(c.wav);
      expect(wav.sampleRate).toBe(8000);
      expect(wav.channels).toBe(1);
      // The WAV holds the counted speech plus at most the VAD's hangover frames.
      const duration = wavDurationSeconds(c.wav);
      expect(duration).toBeGreaterThanOrEqual(c.speechSeconds - 1e-9);
      expect(duration).toBeLessThanOrEqual(c.speechSeconds + DEFAULT_VAD.hangoverFrames * FRAME_SECONDS + 1e-9);
    }
    // Flushed about every 1 s of new speech now, so the progress bar fills smoothly; the rest on stop.
    expect(h.chunks.length).toBeGreaterThanOrEqual(4);
    expect(h.chunks[0].speechSeconds).toBeGreaterThan(0.9);
    expect(h.chunks[0].speechSeconds).toBeLessThan(1.3);
    const totalSpeech = h.chunks.reduce((s, c) => s + c.speechSeconds, 0);
    expect(totalSpeech).toBeGreaterThan(4.7);
    expect(totalSpeech).toBeLessThan(5.05);
    expect(h.session.stats()).toMatchObject({ phase: "ended", chunksStored: h.chunks.length });
    expect(h.session.stats().speechSecondsStored).toBeCloseTo(totalSpeech, 9);

    // Real audio, stored as recorded (the -20 dBFS voice; levelling happens once, over the merged clone file).
    const first = decodeWav(h.chunks[0].wav).samples;
    expect(20 * Math.log10(rms(first))).toBeGreaterThan(-21.5);
    expect(20 * Math.log10(rms(first))).toBeLessThan(-18.5);
  });

  it("stores a quiet speaker's chunks as recorded, at one consistent level (no per-chunk levelling)", async () => {
    // A constant -36 dBFS speaker in phrases: per-chunk levelling used to pull some chunks to -20 dBFS and leave others
    // under the quiet gate, so the merged clone audio jumped by up to 25 dB between chunks of the same voice.
    const h = await started();
    for (let i = 0; i < 8; i++) {
      await h.send(speechLikePcm16(MEDIA_SAMPLE_RATE, 0.9, -36, { gaps: false, seed: i + 1 }));
      await h.send(silence(0.45));
    }
    await h.session.onMessage(stopMessage);
    expect(h.chunks.length).toBeGreaterThanOrEqual(3);
    const levels = h.chunks.map((c) => 20 * Math.log10(rms(decodeWav(c.wav).samples)));
    for (const db of levels) {
      expect(db).toBeLessThan(-33); // never pumped up toward -20
      expect(db).toBeGreaterThan(-42);
    }
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(3);
  });

  it("judges the last run whole when the stream ends, and stores it", async () => {
    const h = await started();
    await h.send(voice(0.12)); // 4 frames: still being judged when the call ends
    await h.session.onMessage(stopMessage);
    expect(h.chunks).toHaveLength(1);
    expect(h.chunks[0].speechSeconds).toBeCloseTo(4 * FRAME_SECONDS, 9);
    expect(wavDurationSeconds(h.chunks[0].wav)).toBeCloseTo(4 * FRAME_SECONDS, 9);
  });

  it("keeps silence out: no speech, no chunks", async () => {
    const h = await started();
    await h.send(silence(6));
    await h.session.onMessage(stopMessage);
    expect(h.storeChunk).not.toHaveBeenCalled();
  });

  it("stores buffered speech once it has waited FLUSH_INTERVAL_MS, even under 1 s of it", async () => {
    const h = await started();
    await h.send(voice(1));
    await h.send(silence(FLUSH_INTERVAL_MS / 1000 + 0.5));
    expect(h.chunks).toHaveLength(1);
    expect(h.chunks[0].speechSeconds).toBeGreaterThan(0.9);
    expect(h.chunks[0].speechSeconds).toBeLessThan(1.1);
    await h.session.onMessage(stopMessage);
    expect(h.chunks).toHaveLength(1); // nothing left to store
  });

  it("the tick stores speech that is due when no more media arrives", async () => {
    const h = await started();
    await h.send(voice(0.6)); // under the 1 s speech threshold, so not flushed yet
    await h.session.tick();
    expect(h.chunks).toHaveLength(0);
    h.clock.now += FLUSH_INTERVAL_MS;
    await h.session.tick();
    expect(h.chunks).toHaveLength(1);
    expect(h.chunks[0].seq).toBe(0);
  });

  it("flushes on stop, and on close without a stop, exactly once", async () => {
    const h = await started();
    await h.send(voice(1));
    await h.session.onMessage(stopMessage);
    await h.session.onClose();
    expect(h.chunks).toHaveLength(1);
    expect(h.chunks[0].speechSeconds).toBeGreaterThan(0.9);

    const closed = await started();
    await closed.send(voice(0.5));
    await closed.session.onClose();
    await closed.session.onMessage(stopMessage);
    expect(closed.chunks).toHaveLength(1);
    expect(closed.session.stats().phase).toBe("ended");
  });

  it("ignores the caller's (outbound) track, media before start, and non-media events", async () => {
    const h = harness();
    for (const p of payloads(voice(3))) await h.session.onMessage(mediaMessage(p, 1)); // before start
    await h.session.onMessage(startMessage());
    await h.send(voice(3), "outbound");
    for (const text of ["not json", "[]", JSON.stringify({ event: "mark", mark: { name: "x" } }), JSON.stringify({ event: "dtmf", dtmf: { digit: "1" } })]) {
      await h.session.onMessage(text);
    }
    await h.session.onMessage(stopMessage);
    expect(h.storeChunk).not.toHaveBeenCalled();
  });

  it("runs its tick on a 3 s interval while capturing, and stops it at the end", async () => {
    const handles: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const timers: SessionTimers = {
      setInterval: (fn, ms) => {
        const handle = { fn, ms, cleared: false };
        handles.push(handle);
        return handle;
      },
      clearInterval: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    };
    const h = await started({ timers });
    expect(handles).toHaveLength(1);
    expect(handles[0].ms).toBe(SESSION_TICK_MS);
    await h.send(voice(1));
    h.clock.now += FLUSH_INTERVAL_MS;
    handles[0].fn();
    await h.session.settled();
    expect(h.chunks).toHaveLength(1);
    await h.session.onMessage(stopMessage);
    expect(handles[0].cleared).toBe(true);
  });

  it("never logs audio, tokens or full CallSids", async () => {
    const h = await started({ minSeconds: 1, clone: async () => ({ outcome: "ready", voiceSource: "clone", voiceId: "v1", speechSeconds: 2 }) });
    await h.send(voice(3));
    await h.session.onMessage(stopMessage);
    await h.session.settled();
    const all = h.logs.join("\n");
    expect(all).not.toContain(CHILD);
    expect(all).not.toContain(PARENT);
    expect(all).not.toContain(goodToken());
    expect(all).not.toContain(STREAM);
    expect(all).not.toContain(payloads(voice(0.02))[0]);
  });
});

describe("media bridge session: refusing a stream", () => {
  const refused = async (overrides: StartOverrides, expectedReason: RegExp, o: HarnessOptions = {}) => {
    const h = harness(o);
    await h.session.onMessage(connected);
    await h.session.onMessage(startMessage(overrides));
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.close.mock.calls[0][0]).toBe(1008);
    expect(h.close.mock.calls[0][1]).toMatch(expectedReason);
    expect(h.session.stats().phase).toBe("rejected");
    await h.send(voice(4));
    await h.session.onMessage(stopMessage);
    await h.session.onClose();
    expect(h.storeChunk).not.toHaveBeenCalled();
    expect(h.maybeStartClone).not.toHaveBeenCalled();
    return h;
  };

  it("refuses a missing, tampered, expired or wrongly signed token (before even looking at consent)", async () => {
    const t = goodToken();
    const flipped = t.slice(0, 5) + (t[5] === "A" ? "B" : "A") + t.slice(6);
    for (const token of [null, "", "garbage", flipped, goodToken({ exp: START_MS / 1000 - 1 }), goodToken({}, "another-secret-0123456789")]) {
      const h = await refused({ token }, /token/);
      expect(h.getTwin).not.toHaveBeenCalled();
    }
  });

  it.each([[["outbound"]], [["inbound", "outbound"]], [["both_tracks"]], [[]]])("refuses tracks %j (only the customer's inbound track)", async (tracks) => {
    await refused({ tracks }, /inbound/);
  });

  it("refuses anything but μ-law at 8 kHz", async () => {
    await refused({ encoding: "audio/l16" }, /mulaw/);
    await refused({ sampleRate: 16000 }, /8000/);
  });

  it("refuses a stream on another call leg than the token's (e.g. the caller's parent leg)", async () => {
    await refused({ callSid: PARENT }, /leg/);
  });

  it("stores nothing without consent (the bridge re-checks it before keeping any audio)", async () => {
    const h = await refused({}, /consent/, { twin: { ...consentingTwin, voice_twin_consent: false } });
    expect(h.getTwin).toHaveBeenCalledOnce();
    await refused({}, /consent/, { twin: null });
  });

  it("refuses a stream whose token was made under another consent (consentAt doesn't match consent_given_at)", async () => {
    // A revoke and a new consent after the stream was started: the old stream may not feed the new consent.
    const h = await refused({}, /^consent changed$/, { twin: { ...consentingTwin, consent_given_at: NEW_CONSENT_AT } });
    expect(h.getTwin).toHaveBeenCalledOnce();
    // The same twin, the same consent time written differently, or none at all: not the token's consent either.
    await refused({}, /^consent changed$/, { twin: { ...consentingTwin, consent_given_at: "2026-11-06T11:00:00+00:00" } });
    await refused({}, /^consent changed$/, { twin: { ...consentingTwin, consent_given_at: null } });
    // A token for an older consent, checked against the current one.
    await refused({ token: goodToken({ consentAt: "2026-11-05T09:00:00.000Z" }) }, /^consent changed$/);
  });

  it("refuses when the consent check can't be made", async () => {
    const h = harness();
    h.getTwin.mockRejectedValueOnce(new Error("database unreachable"));
    await h.session.onMessage(startMessage());
    expect(h.close).toHaveBeenCalledWith(1008, expect.stringMatching(/consent/));
  });

  it("refuses a token for another twin, and a twin that no longer needs audio", async () => {
    await refused({}, /another/, { twin: { ...consentingTwin, id: "88888888-8888-4888-8888-888888888888" } });
    await refused({}, /need/, { twin: { ...consentingTwin, state: "ready" } });
  });
});

describe("media bridge session: the server's answer", () => {
  it.each(["no_consent", "not_collecting", "call_not_flagged", "no_twin", "missing_call"] as const)(
    "stops capturing for the rest of the stream after %s",
    async (reason) => {
      const h = await started({ store: () => ({ stored: false, reason }) });
      await h.send(voice(2.5));
      expect(h.storeChunk).toHaveBeenCalledOnce();
      expect(h.session.stats().phase).toBe("halted");
      // The websocket is closed normally, so Twilio stops streaming the customer's voice (the call goes on).
      expect(h.close).toHaveBeenCalledOnce();
      expect(h.close).toHaveBeenCalledWith(CLOSE_NORMAL, `audio refused (${reason})`);
      expect(CLOSE_NORMAL).toBe(1000);
      await h.send(voice(6));
      await h.session.onMessage(stopMessage);
      expect(h.storeChunk).toHaveBeenCalledOnce();
      expect(h.maybeStartClone).not.toHaveBeenCalled();
    },
  );

  it("carries on after a store error (that chunk is lost, the next one gets the next seq)", async () => {
    let calls = 0;
    const h = await started({
      store: () => {
        calls++;
        if (calls === 1) throw new Error("storage timeout");
        return null;
      },
    });
    await h.send(voice(4.5));
    await h.session.onMessage(stopMessage);
    const seqs = h.storeChunk.mock.calls.map((c) => c[0].seq);
    expect(seqs).toEqual(seqs.map((_, i) => i)); // contiguous from 0, no gaps
    expect(seqs.length).toBeGreaterThanOrEqual(3);
    expect(h.chunks.map((c) => c.seq)).toEqual(seqs.slice(1)); // seq 0 threw; every later chunk was stored
  });
});

describe("media bridge session: consent is re-checked during the stream", () => {
  const revoked: SessionTwin = { ...consentingTwin, voice_twin_consent: false };
  const reconsented: SessionTwin = { ...consentingTwin, consent_given_at: NEW_CONSENT_AT };
  const changes: [string, SessionTwin | null, RegExp][] = [
    ["consent revoked", revoked, /^no consent$/],
    ["consent revoked and given again (a new consent_given_at)", reconsented, /^consent changed$/],
    ["the twin deleted", null, /^no consent$/],
    ["the twin became ready", { ...consentingTwin, state: "ready" }, /need more audio/],
    ["the twin is cloning", { ...consentingTwin, state: "cloning" }, /need more audio/],
  ];

  /** After a halt: further audio, ticks, stop and close store nothing and start no clone. */
  const expectNothingMore = async (h: ReturnType<typeof harness>, storedBefore: number) => {
    await h.send(voice(5));
    await h.session.tick();
    await h.session.onMessage(stopMessage);
    await h.session.onClose();
    await h.session.settled();
    expect(h.storeChunk).toHaveBeenCalledTimes(storedBefore);
    expect(h.maybeStartClone).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.session.stats().phase).toBe("ended");
  };

  it("a tick that finds consent intact changes nothing", async () => {
    const h = await started();
    await h.send(voice(1));
    await h.session.tick();
    expect(h.getTwin).toHaveBeenCalledTimes(2); // at start, and on the tick
    expect(h.close).not.toHaveBeenCalled();
    expect(h.session.stats().phase).toBe("capturing");
    await h.session.onMessage(stopMessage);
    expect(h.chunks).toHaveLength(1); // the buffered second was kept and stored at the end
  });

  it.each(changes)("on the tick, %s: the buffered audio is NOT stored and the websocket is closed", async (_, twin, reason) => {
    const h = await started();
    await h.send(voice(1)); // buffered, not due yet
    expect(h.storeChunk).not.toHaveBeenCalled();
    h.setTwin(twin);
    await h.session.tick();
    expect(h.session.stats().phase).toBe("halted");
    expect(h.close).toHaveBeenCalledWith(1000, expect.stringMatching(reason));
    await expectNothingMore(h, 0);
  });

  it.each(changes)("right before a flush, %s: nothing is stored, even without a tick in between", async (_, twin, reason) => {
    const h = await started();
    await h.send(voice(0.6)); // buffered, under the 1 s threshold
    h.setTwin(twin);
    await h.send(voice(0.6)); // crosses the threshold here → the flush falls due and re-checks
    expect(h.storeChunk).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledWith(1000, expect.stringMatching(reason));
    await expectNothingMore(h, 0);
  });

  it("a revoke and a quick new consent between flushes: nothing captured before it is stored", async () => {
    const h = await started({ timers: null });
    await h.send(voice(1.2)); // chunk 0 flushed at ~1 s, stored under the original consent (the revoke deletes it)
    expect(h.chunks).toHaveLength(1);

    h.setTwin(revoked);
    h.setTwin(reconsented); // given again before the bridge looked: consent is true, but it isn't the token's consent

    await h.send(voice(1)); // crosses the threshold again → the next flush re-checks and refuses
    expect(h.chunks).toHaveLength(1);
    expect(h.storeChunk).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledWith(1000, "consent changed");
    expect(h.logs.some((l) => l.includes("stopped capturing (consent changed)"))).toBe(true);
    await expectNothingMore(h, 1);
  });

  it("a stop right after a revoke stores nothing (the final flush re-checks too)", async () => {
    const h = await started();
    await h.send(voice(0.6)); // buffered, not yet flushed
    h.setTwin(revoked);
    await h.session.onMessage(stopMessage);
    expect(h.storeChunk).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledWith(1000, "no consent");
    expect(h.session.stats().phase).toBe("ended");
  });

  it("when the twin can't be re-read before a flush, that chunk is dropped and capture carries on", async () => {
    const h = await started();
    h.getTwin.mockRejectedValueOnce(new Error("database unreachable"));
    await h.send(voice(1.1)); // due at ~1 s: the re-check fails, so that second of speech is discarded unstored
    expect(h.storeChunk).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    expect(h.session.stats().phase).toBe("capturing");
    expect(h.logs.some((l) => l.startsWith("error:") && l.includes("database unreachable"))).toBe(true);

    await h.send(voice(1.1)); // the next flush checks again, and stores
    expect(h.chunks).toHaveLength(1);
    expect(h.chunks[0].seq).toBe(0);
    expect(h.chunks[0].speechSeconds).toBeLessThan(1.3);
  });

  it("captureProblem names the first reason audio may not be kept", () => {
    const token = verifyStreamToken(goodToken(), SECRET, START_MS)!;
    expect(captureProblem(consentingTwin, token)).toBeNull();
    expect(captureProblem({ ...consentingTwin, state: "failed" }, token)).toBeNull();
    expect(captureProblem(null, token)).toBe("no consent");
    expect(captureProblem({ ...revoked, consent_given_at: NEW_CONSENT_AT }, token)).toBe("no consent");
    expect(captureProblem({ ...consentingTwin, id: "88888888-8888-4888-8888-888888888888" }, token)).toMatch(/another/);
    expect(captureProblem(reconsented, token)).toBe("consent changed");
    expect(captureProblem({ ...consentingTwin, state: "ready" }, token)).toMatch(/need more audio/);
  });
});

describe("media bridge session: starting the clone", () => {
  it("asks for a clone once the twin has the minimum, never twice at once, and retries on the tick while it's not enough", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: ((outcome: CloneOutcome) => void)[] = [];
    const h = await started({
      minSeconds: 3,
      clone: () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<CloneOutcome>((resolve) =>
          pending.push((outcome) => {
            inFlight--;
            resolve(outcome);
          }),
        );
      },
    });

    await h.send(voice(2.2)); // ~2.2 s stored in total, under the 3 s minimum
    expect(h.maybeStartClone).not.toHaveBeenCalled();

    await h.send(voice(1.5)); // now over 3 s in total → a clone is requested
    expect(h.maybeStartClone).toHaveBeenCalledOnce();

    await h.send(voice(4)); // more chunks and ticks while the attempt is in flight: no second attempt
    await h.session.tick();
    await h.session.tick();
    expect(h.chunks.length).toBeGreaterThanOrEqual(3);
    expect(h.maybeStartClone).toHaveBeenCalledOnce();

    pending.shift()!({ outcome: "skipped", reason: "not_enough_audio" }); // e.g. the call isn't flagged yet
    await h.session.settled();
    await h.session.tick();
    expect(h.maybeStartClone).toHaveBeenCalledTimes(2);

    pending.shift()!({ outcome: "ready", voiceSource: "clone", voiceId: "cloned-voice-1", speechSeconds: 8 });
    await h.session.settled();
    expect(h.session.stats().phase).toBe("halted"); // the twin is ready: no more audio needed
    expect(h.close).toHaveBeenCalledWith(1000, "the AI Voice Twin is ready");
    const stored = h.chunks.length;
    await h.send(voice(4));
    await h.session.tick();
    await h.session.onMessage(stopMessage);
    expect(h.chunks).toHaveLength(stored);
    expect(h.maybeStartClone).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
  });

  it("catches clone errors and tries again on the next tick", async () => {
    const h = await started({ minSeconds: 1, clone: vi.fn().mockRejectedValueOnce(new Error("ElevenLabs down")).mockResolvedValue({ outcome: "skipped", reason: "busy" }) });
    await h.send(voice(1.1)); // one flush (≈1 s) reaches the minimum and makes the single in-send attempt
    await h.session.settled();
    expect(h.maybeStartClone).toHaveBeenCalledOnce();
    expect(h.logs.some((l) => l.startsWith("error:") && l.includes("ElevenLabs down"))).toBe(true);
    await h.session.tick();
    await h.session.settled();
    expect(h.maybeStartClone).toHaveBeenCalledTimes(2);
  });

  it("stops asking once a clone attempt has settled the matter (failed)", async () => {
    const h = await started({ minSeconds: 1, clone: async () => ({ outcome: "failed", error: "boom" }) });
    await h.send(voice(2.1));
    await h.session.settled();
    await h.session.tick();
    await h.send(voice(2.1));
    await h.session.settled();
    expect(h.maybeStartClone).toHaveBeenCalledOnce();
    expect(h.session.stats().phase).toBe("capturing"); // a failed twin still collects for a retry
  });
});

describe("media bridge session with the real service over the in-memory store", () => {
  it("captures a flagged call into stored audio and clones the twin from it", async () => {
    const m = new MemoryVoiceTwin(START_MS).withConsent();
    m.addCall({ id: CALL_ID, twilio_call_sid: PARENT });
    const deps = m.deps({ minSeconds: 6, targetSeconds: 12 });
    const clock = { now: START_MS };
    const session = createMediaSession({
      verifyToken: (token) => verifyStreamToken(token, SECRET, clock.now),
      getTwin: () => m.store.getTwin(),
      storeChunk: (input) => storeAudioChunk(input, deps),
      maybeStartClone: () => maybeStartClone({}, deps),
      minSeconds: () => 6,
      now: () => clock.now,
      close: () => undefined,
      timers: null,
      log: () => undefined,
    });
    await session.onMessage(startMessage({ token: goodToken({ twinId: m.twin!.id, consentAt: m.twin!.consent_given_at! }) }));
    const speak = async (seconds: number) => {
      for (const p of payloads(voice(seconds))) {
        clock.now += 20;
        await session.onMessage(mediaMessage(p, 1));
      }
    };

    await speak(7); // over the minimum, but the call isn't flagged yet: kept, not cloned
    await session.settled();
    expect(m.twin!.speech_seconds).toBeGreaterThan(6);
    expect(m.audio.length).toBeGreaterThanOrEqual(3);
    expect(m.audio.every((a) => a.source === "call" && a.call_id === CALL_ID && a.session_id === STREAM)).toBe(true);
    expect(m.objects.size).toBe(m.audio.length);
    expect(m.created).toHaveLength(0);
    expect(m.twin!.state).toBe("collecting");

    m.calls.get(CALL_ID)!.offered_at = new Date(START_MS + 5_000).toISOString(); // screening flags the call
    await session.tick();
    await session.settled();
    expect(m.twin!.state).toBe("ready");
    expect(m.created).toHaveLength(1);
    const files = m.created[0].files;
    expect(files.length).toBe(1);
    expect(decodeWav(files[0].bytes).sampleRate).toBe(8000);
    expect(m.audio).toHaveLength(0); // raw audio deleted once the clone exists
    expect(m.objects.size).toBe(0);
    expect(session.stats().phase).toBe("halted");
  });

  it("a revoke and a new consent mid-call: the old stream stores nothing more and is closed", async () => {
    const m = new MemoryVoiceTwin(START_MS).withConsent();
    m.addCall({ id: CALL_ID, twilio_call_sid: PARENT, offered_at: new Date(START_MS).toISOString() });
    const deps = m.deps({ minSeconds: 60, targetSeconds: 120 });
    const close = vi.fn<MediaSessionDeps["close"]>();
    const clock = { now: START_MS };
    const session = createMediaSession({
      verifyToken: (token) => verifyStreamToken(token, SECRET, clock.now),
      getTwin: () => m.store.getTwin(),
      storeChunk: (input) => storeAudioChunk(input, deps),
      maybeStartClone: () => maybeStartClone({}, deps),
      minSeconds: () => 60,
      now: () => clock.now,
      close,
      timers: null,
      log: () => undefined,
    });
    await session.onMessage(startMessage({ token: goodToken({ twinId: m.twin!.id, consentAt: m.twin!.consent_given_at! }) }));
    const speak = async (seconds: number) => {
      for (const p of payloads(voice(seconds))) {
        clock.now += 20;
        await session.onMessage(mediaMessage(p, 1));
      }
    };

    await speak(1.2); // one chunk flushed at ~1 s, stored under the original consent
    expect(m.audio).toHaveLength(1);
    await speak(0.6); // still buffered when the customer revokes…
    await revokeAndDelete({ userAgent: null }, deps);
    expect(m.objects.size).toBe(0);
    m.clock += 30_000;
    await giveConsent({ userAgent: null }, deps); // …and consents again
    expect(m.twin!.voice_twin_consent).toBe(true);

    await speak(1.5); // the server alone would accept this chunk now: the bridge must not send it
    expect(m.audio).toHaveLength(0); // the revoke deleted chunk 0; nothing from before the new consent was added
    expect(m.objects.size).toBe(0);
    expect(m.twin!.speech_seconds).toBe(0);
    expect(close).toHaveBeenCalledWith(1000, "consent changed");
    expect(session.stats().phase).toBe("halted");
  });

  it("stores nothing for an account holder without consent", async () => {
    const m = new MemoryVoiceTwin(START_MS);
    await m.store.ensureTwin();
    m.addCall({ id: CALL_ID, twilio_call_sid: PARENT });
    const deps = m.deps();
    const close = vi.fn();
    const session = createMediaSession({
      verifyToken: (token) => verifyStreamToken(token, SECRET, START_MS),
      getTwin: () => m.store.getTwin(),
      storeChunk: (input) => storeAudioChunk(input, deps),
      maybeStartClone: () => maybeStartClone({}, deps),
      minSeconds: () => 1,
      now: () => START_MS,
      close,
      timers: null,
      log: () => undefined,
    });
    await session.onMessage(startMessage({ token: goodToken({ twinId: m.twin!.id }) }));
    for (const p of payloads(voice(3))) await session.onMessage(mediaMessage(p, 1));
    await session.onMessage(stopMessage);
    expect(close).toHaveBeenCalledWith(1008, "no consent");
    expect(m.audio).toHaveLength(0);
    expect(m.objects.size).toBe(0);
    expect(m.twin!.speech_seconds).toBe(0);
  });
});

/* ---------- the bridge's shutdown ---------- */

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("media bridge: work in flight", () => {
  it("tracks work until it settles (rejections too) and hands the same promise back", async () => {
    const inFlight = createInFlightWork({ now: () => 1_000 });
    const ok = deferred<string>();
    const bad = deferred<string>();
    const tracked = inFlight.track("an AI Voice Twin clone attempt", ok.promise);
    expect(tracked).toBe(ok.promise);
    const failing = inFlight.track("housekeeping (it may be cloning)", bad.promise);
    expect(inFlight.pending()).toEqual([
      { label: "an AI Voice Twin clone attempt", startedAt: 1_000 },
      { label: "housekeeping (it may be cloning)", startedAt: 1_000 },
    ]);
    ok.resolve("done");
    bad.reject(new Error("boom"));
    await expect(tracked).resolves.toBe("done");
    await expect(failing).rejects.toThrow("boom");
    expect(await inFlight.drained(1_000)).toBe(true);
    expect(inFlight.pending()).toEqual([]);
  });

  it("drains work started while it waits, and gives up after the timeout", async () => {
    const inFlight = createInFlightWork();
    const first = deferred();
    const second = deferred();
    inFlight.track("a call stream storing its last audio", first.promise);
    // The stream's last flush starts a clone just as it finishes.
    void first.promise.then(() => inFlight.track("an AI Voice Twin clone attempt", second.promise));
    const drained = inFlight.drained(5_000);
    first.resolve();
    await vi.waitFor(() => expect(inFlight.pending().map((p) => p.label)).toEqual(["an AI Voice Twin clone attempt"]));
    second.resolve();
    expect(await drained).toBe(true);

    inFlight.track("an AI Voice Twin clone attempt", new Promise<never>(() => undefined));
    expect(await inFlight.drained(20)).toBe(false);
    expect(await createInFlightWork().drained(0)).toBe(true); // nothing in flight: no wait at all
  });

  it("describes what it waits for", () => {
    expect(
      describeInFlight(
        [
          { label: "an AI Voice Twin clone attempt", startedAt: 0 },
          { label: "a call stream storing its last audio", startedAt: 11_600 },
        ],
        12_000,
      ),
    ).toBe("an AI Voice Twin clone attempt (running 12 s), a call stream storing its last audio (running 0 s)");
  });
});

describe("media bridge: shutdown", () => {
  function shutdownHarness(o: { closeSessions?: () => Promise<void>; unregister?: () => Promise<void> } = {}) {
    const steps: string[] = [];
    const logs: { level: BridgeLogLevel; message: string }[] = [];
    // The signal debounce reads this clock; tests move it on by hand (real timers still drive the capped waits).
    const clock = { ms: 1_000_000 };
    const now = () => clock.ms;
    const inFlight = createInFlightWork({ now });
    const exit = vi.fn((code: number) => void steps.push(`exit ${code}`));
    const plan: BridgeShutdownPlan = {
      unregister: async () => {
        steps.push("unregister");
        await o.unregister?.();
      },
      stopAccepting: () => void steps.push("stop accepting"),
      closeSessions: async () => {
        steps.push("close sessions");
        await o.closeSessions?.();
      },
      inFlight,
      release: async () => void steps.push("close tunnel"),
      exit,
      log: (level, message) => void logs.push({ level, message }),
      now,
    };
    const logged = () => logs.map((l) => `${l.level}: ${l.message}`).join("\n");
    const advance = (ms: number) => void (clock.ms += ms);
    return { plan, steps, logs, logged, inFlight, exit, advance };
  }

  it("unregisters, stops accepting, closes the streams, then waits for the clone in flight before exiting", async () => {
    const h = shutdownHarness();
    const clone = deferred<CloneOutcome>();
    h.inFlight.track("an AI Voice Twin clone attempt", clone.promise);
    const done = createBridgeShutdown(h.plan)("SIGINT");

    await vi.waitFor(() => expect(h.logged()).toContain("waiting up to 55 s for an AI Voice Twin clone attempt (running"));
    expect(h.steps).toEqual(["unregister", "stop accepting", "close sessions"]); // still waiting: no exit, tunnel open
    expect(SHUTDOWN_CLONE_WAIT_MS).toBe(55_000);

    clone.resolve({ outcome: "ready", voiceSource: "clone", voiceId: "cloned-voice-1", speechSeconds: 31 });
    await done;
    expect(h.steps).toEqual(["unregister", "stop accepting", "close sessions", "close tunnel", "exit 0"]);
    expect(h.logged()).not.toContain("orphan");
  });

  it("waits for a clone that a stream's last flush starts while closing", async () => {
    const clone = deferred<CloneOutcome>();
    const h = shutdownHarness({
      closeSessions: async () => {
        void h.inFlight.track("an AI Voice Twin clone attempt", clone.promise);
      },
    });
    const done = createBridgeShutdown(h.plan)("SIGTERM");
    await vi.waitFor(() => expect(h.logged()).toContain("waiting up to 55 s for an AI Voice Twin clone attempt"));
    expect(h.exit).not.toHaveBeenCalled();
    clone.resolve({ outcome: "skipped", reason: "no_consent" });
    await done;
    expect(h.steps.at(-1)).toBe("exit 0");
  });

  it("exits straight away when nothing is in flight", async () => {
    const h = shutdownHarness();
    await createBridgeShutdown(h.plan)("SIGINT");
    expect(h.steps).toEqual(["unregister", "stop accepting", "close sessions", "close tunnel", "exit 0"]);
    expect(h.logged()).not.toContain("waiting");
  });

  it("caps the wait: a clone still running after it is logged as possibly orphaned", async () => {
    const h = shutdownHarness();
    h.inFlight.track("an AI Voice Twin clone attempt", new Promise<never>(() => undefined));
    await createBridgeShutdown(h.plan, { cloneWaitMs: 30 })("SIGINT");
    expect(h.steps).toEqual(["unregister", "stop accepting", "close sessions", "close tunnel", "exit 1"]);
    expect(h.logs.some((l) => l.level === "warn" && /gave up waiting.*orphaned.*housekeeping will sweep it/.test(l.message))).toBe(true);
  });

  it("a second Ctrl-C (after the repeat window) exits at once, saying a clone may be orphaned", async () => {
    const h = shutdownHarness();
    const clone = deferred<CloneOutcome>();
    h.inFlight.track("an AI Voice Twin clone attempt", clone.promise);
    const shutdown = createBridgeShutdown(h.plan);
    const first = shutdown("SIGINT");
    await vi.waitFor(() => expect(h.logged()).toContain("waiting up to 55 s"));

    h.advance(SHUTDOWN_REPEAT_SIGNAL_MS);
    await shutdown("SIGINT");
    expect(h.exit).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.logs.at(-1)).toMatchObject({ level: "warn" });
    expect(h.logs.at(-1)!.message).toMatch(/^second SIGINT: exiting now without waiting for an AI Voice Twin clone attempt/);
    expect(h.logs.at(-1)!.message).toMatch(/orphaned.*housekeeping will sweep it/);

    clone.resolve({ outcome: "failed", error: "boom" });
    await first; // in the real process the first exit already ended it
    expect(h.exit.mock.calls[0]).toEqual([1]);
  });

  it("a second Ctrl-C with nothing in flight just exits", async () => {
    const h = shutdownHarness({ unregister: () => new Promise<void>(() => undefined) });
    const shutdown = createBridgeShutdown(h.plan, { stepMs: 5_000 });
    void shutdown("SIGINT");
    h.advance(2_000);
    await shutdown("SIGINT");
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.logs.at(-1)!.message).toBe("second SIGINT: exiting now");
  });

  it("one Ctrl-C delivered twice 30 ms apart (terminal + npm/tsx) still waits for the clone, unregisters and exits 0", async () => {
    expect(SHUTDOWN_REPEAT_SIGNAL_MS).toBe(1_500);
    const h = shutdownHarness();
    const clone = deferred<CloneOutcome>();
    h.inFlight.track("an AI Voice Twin clone attempt", clone.promise);
    const shutdown = createBridgeShutdown(h.plan);
    const first = shutdown("SIGINT");
    expect(h.logged()).toContain("SIGINT: unregistering and stopping (SIGINT again, 1.5 s or more from now, to exit at once)");

    h.advance(30);
    await shutdown("SIGINT"); // the duplicate lands while the first is still unregistering
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.logs.at(-1)).toEqual({
      level: "debug",
      message: "SIGINT 30 ms after SIGINT: taken as the same keypress passed on twice (terminal and npm/tsx); ignored",
    });

    await vi.waitFor(() => expect(h.logged()).toContain("waiting up to 55 s for an AI Voice Twin clone attempt"));
    expect(h.exit).not.toHaveBeenCalled();
    clone.resolve({ outcome: "ready", voiceSource: "clone", voiceId: "cloned-voice-1", speechSeconds: 31 });
    await first;

    expect(h.steps).toEqual(["unregister", "stop accepting", "close sessions", "close tunnel", "exit 0"]);
    expect(h.exit).toHaveBeenCalledOnce();
    expect(h.logged()).not.toMatch(/second SIGINT|orphan|exiting now/);
    expect(h.logs.filter((l) => l.level === "warn" || l.level === "error")).toEqual([]);
  });

  it("a duplicate during the clone wait is ignored too, right up to the end of the window", async () => {
    const h = shutdownHarness();
    const clone = deferred<CloneOutcome>();
    h.inFlight.track("an AI Voice Twin clone attempt", clone.promise);
    const shutdown = createBridgeShutdown(h.plan);
    const first = shutdown("SIGTERM");
    await vi.waitFor(() => expect(h.logged()).toContain("waiting up to 55 s"));

    h.advance(SHUTDOWN_REPEAT_SIGNAL_MS - 1);
    await shutdown("SIGINT");
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.logs.at(-1)).toMatchObject({ level: "debug", message: expect.stringMatching(/^SIGINT 1499 ms after SIGTERM: .*ignored$/) });

    clone.resolve({ outcome: "skipped", reason: "no_consent" });
    await first;
    expect(h.steps).toEqual(["unregister", "stop accepting", "close sessions", "close tunnel", "exit 0"]);
  });

  it("a real second press 2 s later still exits at once with the orphan warning (after ignoring the duplicate)", async () => {
    const h = shutdownHarness();
    const clone = deferred<CloneOutcome>();
    h.inFlight.track("an AI Voice Twin clone attempt", clone.promise);
    const shutdown = createBridgeShutdown(h.plan);
    const first = shutdown("SIGINT");
    h.advance(30);
    await shutdown("SIGINT"); // the same keypress, passed on by npm/tsx
    await vi.waitFor(() => expect(h.logged()).toContain("waiting up to 55 s"));
    expect(h.exit).not.toHaveBeenCalled();

    h.advance(2_000 - 30);
    await shutdown("SIGINT"); // the operator really pressed Ctrl-C again
    expect(h.exit).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.steps).toEqual(["unregister", "stop accepting", "close sessions", "exit 1"]); // no tunnel close: it left at once
    expect(h.logs.at(-1)).toMatchObject({ level: "warn" });
    expect(h.logs.at(-1)!.message).toMatch(
      /^second SIGINT: exiting now without waiting for an AI Voice Twin clone attempt \(running 2 s\)\. .*orphaned.*housekeeping will sweep it/,
    );
    expect(h.logs.filter((l) => l.level === "debug")).toHaveLength(1);

    clone.resolve({ outcome: "failed", error: "boom" });
    await first;
  });

  it("a step that fails or hangs doesn't stop the shutdown", async () => {
    const h = shutdownHarness({
      unregister: async () => {
        throw new Error("database unreachable");
      },
      closeSessions: () => new Promise<void>(() => undefined),
    });
    await createBridgeShutdown(h.plan, { stepMs: 20 })("SIGTERM");
    expect(h.steps).toEqual(["unregister", "stop accepting", "close sessions", "close tunnel", "exit 0"]);
    expect(h.logged()).toContain("error: unregistering the bridge failed (database unreachable)");
    expect(h.logged()).toMatch(/warn: closing the streams took over/);
  });
});

describe("media bridge: stray socket errors", () => {
  const withCode = (code: string) => Object.assign(new Error(`write ${code}`), { code });

  it("EPIPE and ECONNRESET (a peer hanging up) are stray; anything else is not", () => {
    expect(isStraySocketError(withCode("EPIPE"))).toBe(true);
    expect(isStraySocketError(withCode("ECONNRESET"))).toBe(true);
    expect(isStraySocketError(withCode("ECONNABORTED"))).toBe(true);
    expect(isStraySocketError(withCode("EADDRINUSE"))).toBe(false);
    expect(isStraySocketError(withCode("ERR_INVALID_ARG_TYPE"))).toBe(false);
    expect(isStraySocketError(new TypeError("x is not a function"))).toBe(false);
    expect(isStraySocketError({ code: "EPIPE" })).toBe(false);
    expect(isStraySocketError("EPIPE")).toBe(false);
    expect(isStraySocketError(null)).toBe(false);
  });
});
