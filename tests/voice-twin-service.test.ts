import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { CallRisk, VoiceTwinRow } from "@/lib/types";
import {
  VOICE_TWIN_CLONE_TTL_MS,
  VOICE_TWIN_CONSENT_VERSION,
  VOICE_TWIN_LABEL,
  VOICE_TWIN_STALE_CLONING_SECONDS,
} from "@/lib/voice-twin/config";
import { MemoryVoiceTwin } from "@/lib/voice-twin/memory-store";
import {
  audioPath,
  consentedByLabel,
  discardUnflaggedCallAudio,
  getCustomerTwinView,
  giveConsent,
  maybeStartClone,
  revokeAndDelete,
  storeAudioChunk,
  twinForTakeover,
  voiceTwinHousekeeping,
  type CloneOutcome,
  type RevokeResult,
  type StoreChunkInput,
  type VoiceTwinDeps,
} from "@/lib/voice-twin/service";
import { isCallFlagged } from "@/lib/voice-twin/store";
import { customerTwinView, progressLabel, roundSeconds } from "@/lib/voice-twin/view";
import { decodeWav, encodeWav } from "@/lib/voice-twin/wav";
import { speechLike } from "./helpers/voice-fixtures";

// ---------- fixtures ----------

const TWIN_ID = "77777777-7777-4777-8777-777777777777";
const SAMPLE_SESSION = "5a1e5e55-0000-4000-8000-000000000001";
const CALL_U = "11111111-1111-4111-8111-111111111111"; // stays unflagged
const CALL_F = "22222222-2222-4222-8222-222222222222"; // gets flagged
const HOUR = 60 * 60 * 1000;
const OTHER_TWIN_OBJECT = "someone-else/sample/x/00000.wav";

const iso = (ms: number) => new Date(ms).toISOString();

/** A risk score that crossed the threshold (one of the ways a call counts as flagged). */
function crossedRisk(at: string): CallRisk {
  return {
    score: 88,
    peak: 88,
    scam_type: "hmrc",
    tactics: ["fear"],
    reason: "Threatening arrest.",
    segments_scored: 2,
    scored_at: at,
    threshold_crossed_at: at,
    threshold_crossed_score: 88,
  };
}

/** A short PCM16 WAV whose samples all equal `tag`, so merged output can be traced back to its chunks. */
function chunkWav(rate: number, tag: number, samples = 160): Uint8Array {
  return encodeWav(new Int16Array(samples).fill(tag), rate);
}

function sampleChunk(seq: number, speechSeconds: number, overrides: Partial<StoreChunkInput> = {}): StoreChunkInput {
  const wav = chunkWav(16_000, 100 + seq);
  return { source: "sample", callId: null, sessionId: SAMPLE_SESSION, seq, wav, sampleRate: 16_000, speechSeconds, ...overrides };
}

const streamSid = (callId: string) => `MZ${callId.replace(/-/g, "").slice(0, 32)}`;

function callChunk(callId: string, seq: number, speechSeconds: number, overrides: Partial<StoreChunkInput> = {}): StoreChunkInput {
  return { source: "call", callId, sessionId: streamSid(callId), seq, wav: chunkWav(8_000, 7), sampleRate: 8_000, speechSeconds, ...overrides };
}

function samplePath(seq: number): string {
  return audioPath(TWIN_ID, "sample", SAMPLE_SESSION, seq);
}

function callPath(callId: string, seq: number): string {
  return audioPath(TWIN_ID, "call", streamSid(callId), seq);
}

/** The memory twin row (throws if there isn't one). */
function twinOf(m: MemoryVoiceTwin): VoiceTwinRow {
  if (!m.twin) throw new Error("no twin");
  return m.twin;
}

function setup(settings: Parameters<MemoryVoiceTwin["deps"]>[0] = {}) {
  const m = new MemoryVoiceTwin().withConsent();
  return { m, deps: m.deps(settings) };
}

/** Store 36 s of Settings samples (3 × 12 s). */
async function collect(deps: VoiceTwinDeps, chunks = 3, seconds = 12): Promise<void> {
  for (let seq = 0; seq < chunks; seq++) {
    const result = await storeAudioChunk(sampleChunk(seq, seconds), deps);
    expect(result.stored).toBe(true);
  }
}

/** Collect 36 s and clone; returns the outcome (asserted ready). */
async function makeReady(deps: VoiceTwinDeps): Promise<CloneOutcome> {
  await collect(deps);
  const outcome = await maybeStartClone({}, deps);
  expect(outcome.outcome).toBe("ready");
  return outcome;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- consent gate ----------

describe("consent gate", () => {
  it("without a twin row: storeAudioChunk uploads nothing and reports no_twin", async () => {
    const m = new MemoryVoiceTwin();
    const deps = m.deps();
    const upload = vi.spyOn(m.storage, "upload");
    const addAudio = vi.spyOn(m.store, "addAudio");

    expect(await storeAudioChunk(sampleChunk(0, 12), deps)).toEqual({ stored: false, reason: "no_twin" });
    expect(upload).not.toHaveBeenCalled();
    expect(addAudio).not.toHaveBeenCalled();
    expect(m.objects.size).toBe(0);
    expect(m.audio).toHaveLength(0);
  });

  it("without consent: neither samples nor call audio are uploaded or registered, and nothing is counted", async () => {
    const m = new MemoryVoiceTwin();
    await m.store.ensureTwin();
    m.addCall({ id: CALL_F, offered_at: iso(m.clock), handoff_status: "offered" });
    const deps = m.deps();
    const upload = vi.spyOn(m.storage, "upload");
    const addAudio = vi.spyOn(m.store, "addAudio");

    expect(await storeAudioChunk(sampleChunk(0, 12), deps)).toEqual({ stored: false, reason: "no_consent" });
    expect(await storeAudioChunk(callChunk(CALL_F, 0, 12), deps)).toEqual({ stored: false, reason: "no_consent" });
    expect(upload).not.toHaveBeenCalled();
    expect(addAudio).not.toHaveBeenCalled();
    expect(m.objects.size).toBe(0);
    expect(m.audio).toHaveLength(0);
    expect(twinOf(m).speech_seconds).toBe(0);
    expect(twinOf(m).last_audio_at).toBeNull();
  });

  it("the store refuses audio without consent as well (the database re-checks)", async () => {
    const m = new MemoryVoiceTwin();
    await m.store.ensureTwin();
    const result = await m.store.addAudio({
      twinId: TWIN_ID,
      source: "sample",
      callId: null,
      sessionId: SAMPLE_SESSION,
      seq: 0,
      path: samplePath(0),
      mimeType: "audio/wav",
      sampleRate: 16_000,
      speechSeconds: 12,
      bytes: 100,
    });
    expect(result).toEqual({ accepted: false, reason: "no_consent" });
    expect(m.audio).toHaveLength(0);
  });

  it("maybeStartClone without a twin or without consent → skipped, and voices.create is never called", async () => {
    const m = new MemoryVoiceTwin();
    const deps = m.deps({ minSeconds: 0 });
    const create = vi.spyOn(m.elevenlabs, "create");

    expect(await maybeStartClone({}, deps)).toEqual({ outcome: "skipped", reason: "no_consent" });
    await m.store.ensureTwin();
    expect(await maybeStartClone({}, deps)).toEqual({ outcome: "skipped", reason: "no_consent" });
    expect(await maybeStartClone({ allowFailed: true }, deps)).toEqual({ outcome: "skipped", reason: "no_consent" });
    expect(create).not.toHaveBeenCalled();
    expect(m.created).toHaveLength(0);
    const claim = await m.store.claimClone(TWIN_ID, { minSeconds: 0, staleSeconds: 180, allowFailed: true });
    expect(claim).toEqual({ claimed: false, reason: "no_consent" });
  });

  it("giveConsent records who (consentedByLabel) and when, logs a 'given' event, and keeps the first consent time", async () => {
    const m = new MemoryVoiceTwin();
    const deps = m.deps();
    const at = iso(m.clock);

    const row = await giveConsent({ userAgent: "Mozilla/5.0 (iPhone)" }, deps);
    expect(consentedByLabel("Ben")).toBe("Ben (account holder, Call Guard Settings)");
    expect(row).toMatchObject({
      voice_twin_consent: true,
      consent_given_at: at,
      consent_given_by: "Ben (account holder, Call Guard Settings)",
      consent_text_version: VOICE_TWIN_CONSENT_VERSION,
      consent_user_agent: "Mozilla/5.0 (iPhone)",
      state: "collecting",
      speech_seconds: 0,
      voice_id: null,
    });
    expect(m.consentEvents).toEqual([
      { event: "given", at, by: "Ben (account holder, Call Guard Settings)", userAgent: "Mozilla/5.0 (iPhone)" },
    ]);

    m.clock += 60_000;
    const again = await giveConsent({ userAgent: "Other" }, deps);
    expect(again.consent_given_at).toBe(at);
    expect(again.consent_user_agent).toBe("Mozilla/5.0 (iPhone)");
    expect(m.consentEvents).toHaveLength(1);
  });

  it("consentedByLabel falls back to 'Account holder' for a blank name", () => {
    expect(consentedByLabel("  ")).toBe("Account holder (account holder, Call Guard Settings)");
    expect(consentedByLabel(" Ben ")).toBe("Ben (account holder, Call Guard Settings)");
  });

  it("after consent, chunks are stored at their audioPath and counted; a repeated chunk isn't double-counted", async () => {
    const { m, deps } = setup();
    const first = sampleChunk(0, 12.5);

    expect(await storeAudioChunk(first, deps)).toMatchObject({ stored: true, duplicate: false, speechSeconds: 12.5 });
    const second = await storeAudioChunk(sampleChunk(1, 8), deps);
    expect(second).toMatchObject({ stored: true, duplicate: false, speechSeconds: 20.5 });
    if (second.stored) expect(second.twin.speech_seconds).toBe(20.5);
    expect(await storeAudioChunk(sampleChunk(1, 8), deps)).toMatchObject({ stored: true, duplicate: true, speechSeconds: 20.5 });

    expect(twinOf(m).speech_seconds).toBe(20.5);
    expect(twinOf(m).last_audio_at).toBe(iso(m.clock));
    expect(m.audio.map((a) => a.storage_path)).toEqual([samplePath(0), samplePath(1)]);
    expect([...m.objects.keys()].sort()).toEqual([samplePath(0), samplePath(1)].sort());
    expect(m.objects.get(samplePath(0))).toEqual(first.wav);
    expect(m.audio[0]).toMatchObject({
      twin_id: TWIN_ID,
      source: "sample",
      call_id: null,
      session_id: SAMPLE_SESSION,
      seq: 0,
      mime_type: "audio/wav",
      sample_rate: 16_000,
      speech_seconds: 12.5,
      bytes: first.wav.byteLength,
    });
  });

  it("negative speech seconds count as 0", async () => {
    const { m, deps } = setup();
    expect(await storeAudioChunk(sampleChunk(0, -5), deps)).toMatchObject({ stored: true, speechSeconds: 0 });
    expect(m.audio[0].speech_seconds).toBe(0);
  });

  it("live call audio is stored under the call (the customer's leg) with its call id", async () => {
    const { m, deps } = setup();
    m.addCall({ id: CALL_U });
    expect(await storeAudioChunk(callChunk(CALL_U, 0, 5), deps)).toMatchObject({ stored: true, speechSeconds: 5 });
    expect(m.audio[0]).toMatchObject({
      source: "call",
      call_id: CALL_U,
      session_id: streamSid(CALL_U),
      storage_path: callPath(CALL_U, 0),
      sample_rate: 8_000,
    });
  });

  it("a flagged call's audio is accepted even after the call ended", async () => {
    const { m, deps } = setup();
    m.addCall({ id: CALL_F, status: "ended", risk: crossedRisk(iso(m.clock)) });
    expect(await storeAudioChunk(callChunk(CALL_F, 0, 5), deps)).toMatchObject({ stored: true });
  });

  it("a chunk the store refuses (call ended unflagged) has its object deleted again", async () => {
    const { m, deps } = setup();
    m.addCall({ id: CALL_U, status: "ended" });
    const upload = vi.spyOn(m.storage, "upload");
    const remove = vi.spyOn(m.storage, "remove");

    expect(await storeAudioChunk(callChunk(CALL_U, 0, 5), deps)).toEqual({ stored: false, reason: "call_not_flagged" });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith([callPath(CALL_U, 0)]);
    expect(m.objects.size).toBe(0);
    expect(m.audio).toHaveLength(0);
    expect(twinOf(m).speech_seconds).toBe(0);
  });

  it("a chunk for an unknown call is refused (missing_call) and its object deleted", async () => {
    const { m, deps } = setup();
    expect(await storeAudioChunk(callChunk(CALL_U, 0, 5), deps)).toEqual({ stored: false, reason: "missing_call" });
    expect(m.objects.size).toBe(0);
    expect(m.audio).toHaveLength(0);
  });

  it("call audio without a call id is refused before anything is uploaded", async () => {
    const { m, deps } = setup();
    const upload = vi.spyOn(m.storage, "upload");
    expect(await storeAudioChunk(callChunk(CALL_U, 0, 5, { callId: null }), deps)).toEqual({ stored: false, reason: "missing_call" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("a twin that is cloning or ready takes no audio (nothing uploaded)", async () => {
    for (const state of ["cloning", "ready"] as const) {
      const { m, deps } = setup();
      const voice = { voice_id: "v", voice_source: "clone", voice_expires_at: iso(m.clock + HOUR) };
      Object.assign(twinOf(m), { state, cloning_started_at: iso(m.clock), ...voice });
      const upload = vi.spyOn(m.storage, "upload");
      expect(await storeAudioChunk(sampleChunk(0, 5), deps)).toEqual({ stored: false, reason: "not_collecting" });
      expect(upload).not.toHaveBeenCalled();
      expect(m.objects.size).toBe(0);
    }
  });

  it("a failed twin keeps collecting (a retry then has more to work with)", async () => {
    const { m, deps } = setup();
    Object.assign(twinOf(m), { state: "failed", clone_error: "boom" });
    expect(await storeAudioChunk(sampleChunk(0, 5), deps)).toMatchObject({ stored: true, speechSeconds: 5 });
  });

  it("when registering the chunk throws, the object is deleted and the error propagates", async () => {
    const { m, deps } = setup();
    vi.spyOn(m.store, "addAudio").mockRejectedValueOnce(new Error("db down"));
    await expect(storeAudioChunk(sampleChunk(0, 5), deps)).rejects.toThrow("db down");
    expect(m.objects.size).toBe(0);
    expect(m.audio).toHaveLength(0);
  });
});

// ---------- cloning ----------

describe("maybeStartClone", () => {
  it("below the minimum → skipped, still collecting, nothing created", async () => {
    const { m, deps } = setup();
    await storeAudioChunk(sampleChunk(0, 29.9), deps);
    expect(await maybeStartClone({}, deps)).toEqual({ outcome: "skipped", reason: "not_enough_audio" });
    expect(twinOf(m).state).toBe("collecting");
    expect(m.created).toHaveLength(0);
  });

  it("at the minimum: claim → create from merged WAVs → ready for 24 h, and every raw recording deleted", async () => {
    const { m, deps } = setup();
    m.addCall({ id: CALL_F, offered_at: iso(m.clock), handoff_status: "offered" });
    m.addCall({ id: CALL_U });
    await storeAudioChunk(sampleChunk(0, 12), deps);
    await storeAudioChunk(sampleChunk(1, 12), deps);
    await storeAudioChunk(callChunk(CALL_F, 0, 6), deps);
    await storeAudioChunk(callChunk(CALL_U, 0, 20, { wav: chunkWav(8_000, 9) }), deps); // live and unflagged: not eligible
    m.objects.set(`${TWIN_ID}/sample/lost-session/00000.wav`, chunkWav(16_000, 1)); // no table row
    m.objects.set(OTHER_TWIN_OBJECT, chunkWav(16_000, 1));
    const consentAt = twinOf(m).consent_given_at as string;
    const createdAt = m.clock;

    const outcome = await maybeStartClone({}, deps);
    expect(outcome).toEqual({ outcome: "ready", voiceSource: "clone", voiceId: "cloned-voice-1", speechSeconds: 30 });

    // What ElevenLabs was sent.
    expect(m.created).toHaveLength(1);
    const input = m.created[0];
    expect(input.name).toContain(VOICE_TWIN_LABEL);
    expect(input.name.length).toBeLessThanOrEqual(100);
    expect(input.description).toMatch(/consent/i);
    expect(input.description).toContain(consentAt);
    expect(input.removeBackgroundNoise).toBe(false);
    expect(input.files.map((f) => [f.filename, f.contentType])).toEqual([
      ["voice-twin-1.wav", "audio/wav"],
      ["voice-twin-2.wav", "audio/wav"],
    ]);
    const [wide, narrow] = input.files.map((f) => decodeWav(f.bytes));
    expect(wide.sampleRate).toBe(16_000);
    expect([...wide.samples]).toEqual([...new Array<number>(160).fill(100), ...new Array<number>(160).fill(101)]);
    expect(narrow.sampleRate).toBe(8_000);
    expect(narrow.samples).toHaveLength(160); // the flagged call only
    expect(new Set(narrow.samples)).toEqual(new Set([7]));

    // The twin.
    const twin = twinOf(m);
    expect(twin).toMatchObject({
      state: "ready",
      voice_twin_consent: true,
      voice_id: "cloned-voice-1",
      voice_source: "clone",
      voice_created_at: iso(createdAt),
      voice_expires_at: iso(createdAt + VOICE_TWIN_CLONE_TTL_MS),
      clone_speech_seconds: 30,
      clone_error: null,
      cloning_started_at: null,
    });
    expect(Date.parse(twin.voice_expires_at as string) - Date.parse(twin.voice_created_at as string)).toBe(24 * HOUR);

    // Raw audio: every row and every object under the twin's folder is gone (the other twin's object stays).
    expect(m.audio).toHaveLength(0);
    expect([...m.objects.keys()]).toEqual([OTHER_TWIN_OBJECT]);
    expect(m.voices.has("cloned-voice-1")).toBe(true);
    expect(m.deleted).toHaveLength(0);
  });

  it("levels each merged clone file once, with one gain: chunk levels keep their difference", async () => {
    const { m, deps } = setup();
    // Two Settings chunks of the same voice, stored as recorded: one at -28 dBFS, one at -40 dBFS.
    const asPcm = (x: Float32Array) => Int16Array.from(x, (v) => Math.round(v * 32767));
    const loud = asPcm(speechLike(16_000, 1, -28, { gaps: false }));
    const soft = asPcm(speechLike(16_000, 1, -40, { gaps: false, seed: 5 }));
    await storeAudioChunk(sampleChunk(0, 15, { wav: encodeWav(loud, 16_000) }), deps);
    await storeAudioChunk(sampleChunk(1, 15, { wav: encodeWav(soft, 16_000) }), deps);
    expect((await maybeStartClone({}, deps)).outcome).toBe("ready");

    const files = m.created[0].files.map((f) => decodeWav(f.bytes));
    expect(files).toHaveLength(1);
    const merged = files[0].samples;
    expect(merged).toHaveLength(loud.length + soft.length);
    const db = (x: Int16Array) => {
      let sum = 0;
      for (const v of x) sum += (v / 32768) ** 2;
      return 10 * Math.log10(sum / x.length);
    };
    // One gain over the whole file: the 12 dB between the chunks is kept (per-chunk levelling made it 0)…
    expect(db(merged.subarray(0, loud.length)) - db(merged.subarray(loud.length))).toBeCloseTo(db(loud) - db(soft), 1);
    // …and the file as a whole is raised toward -20 dBFS.
    expect(db(merged)).toBeGreaterThan(db(Int16Array.from([...loud, ...soft])) + 3);
  });

  it("create fails and there is no fallback → failed with the error, and the audio is kept for a retry", async () => {
    const { m, deps } = setup();
    await collect(deps);
    m.createError = new Error("ElevenLabs POST /v1/voices/add → 500: busy");

    expect(await maybeStartClone({}, deps)).toEqual({ outcome: "failed", error: "ElevenLabs POST /v1/voices/add → 500: busy" });
    expect(twinOf(m)).toMatchObject({
      state: "failed",
      clone_error: "ElevenLabs POST /v1/voices/add → 500: busy",
      voice_id: null,
      cloning_started_at: null,
    });
    expect(m.audio).toHaveLength(3);
    expect(m.objects.size).toBe(3);
    expect(customerTwinView(m.twin, deps.settings(), m.clock)).toMatchObject({ state: "failed", usable: false });
  });

  it("create fails with VOICE_TWIN_FALLBACK_VOICE_ID set → ready on the fallback voice, audio deleted", async () => {
    const { m, deps } = setup({ fallbackVoiceId: "fallback-voice" });
    m.voices.add("fallback-voice"); // the account holder's hand-made clone exists at ElevenLabs
    await collect(deps);
    m.createError = new Error("ElevenLabs down");
    const createdAt = m.clock;

    expect(await maybeStartClone({}, deps)).toEqual({ outcome: "ready", voiceSource: "fallback", voiceId: "fallback-voice", speechSeconds: 36 });
    expect(twinOf(m)).toMatchObject({
      state: "ready",
      voice_id: "fallback-voice",
      voice_source: "fallback",
      voice_expires_at: iso(createdAt + VOICE_TWIN_CLONE_TTL_MS),
      clone_speech_seconds: 36,
    });
    expect(m.audio).toHaveLength(0);
    expect(m.objects.size).toBe(0);
    expect(m.deleted).toHaveLength(0);
  });

  it("requires_verification → the new voice is deleted and it counts as a failure", async () => {
    const { m, deps } = setup();
    await collect(deps);
    m.requiresVerification = true;

    const outcome = await maybeStartClone({}, deps);
    expect(outcome).toMatchObject({ outcome: "failed" });
    if (outcome.outcome === "failed") expect(outcome.error).toMatch(/verification/i);
    expect(m.deleted).toEqual(["cloned-voice-1"]);
    expect(m.voices.size).toBe(0);
    expect(m.deletionQueue.size).toBe(0);
    expect(twinOf(m)).toMatchObject({ state: "failed", voice_id: null });
    expect(m.audio).toHaveLength(3);
  });

  it("requires_verification with a fallback → the clone is deleted and the fallback voice is used", async () => {
    const { m, deps } = setup({ fallbackVoiceId: "fallback-voice" });
    m.voices.add("fallback-voice");
    await collect(deps);
    m.requiresVerification = true;

    expect(await maybeStartClone({}, deps)).toMatchObject({ outcome: "ready", voiceSource: "fallback", voiceId: "fallback-voice" });
    expect(m.deleted).toEqual(["cloned-voice-1"]);
    expect(twinOf(m)).toMatchObject({ state: "ready", voice_id: "fallback-voice", voice_source: "fallback" });
  });

  it("requires_verification and the delete fails → the voice stays queued (orphan) until housekeeping deletes it", async () => {
    const { m, deps } = setup();
    await collect(deps);
    m.requiresVerification = true;
    m.removeError = new Error("timeout");

    expect(await maybeStartClone({}, deps)).toMatchObject({ outcome: "failed" });
    expect(m.deletionQueue.get("cloned-voice-1")).toMatchObject({ reason: "orphan", attempts: 1 });
    expect(m.voices.has("cloned-voice-1")).toBe(true);

    m.removeError = null;
    expect((await voiceTwinHousekeeping(deps)).voicesDeleted).toBe(1);
    expect(m.deletionQueue.size).toBe(0);
    expect(m.voices.size).toBe(0);
    expect(twinOf(m).state).toBe("failed"); // housekeeping never retries a failed twin by itself
  });

  it("a failed twin is only retried with allowFailed (Settings 'Try again')", async () => {
    const { m, deps } = setup();
    await collect(deps);
    m.createError = new Error("boom");
    expect(await maybeStartClone({}, deps)).toMatchObject({ outcome: "failed" });
    m.createError = null;

    expect(await maybeStartClone({}, deps)).toEqual({ outcome: "skipped", reason: "not_collecting" });
    expect(m.created).toHaveLength(1);
    expect(twinOf(m).state).toBe("failed");

    const retried = await maybeStartClone({ allowFailed: true }, deps);
    expect(retried).toEqual({ outcome: "ready", voiceSource: "clone", voiceId: "cloned-voice-2", speechSeconds: 36 });
    expect(twinOf(m)).toMatchObject({ state: "ready", clone_error: null, voice_id: "cloned-voice-2" });
    expect(m.audio).toHaveLength(0);
  });

  it("a live unflagged call's audio isn't eligible; once the call is flagged it is, and samples always are", async () => {
    const { m, deps } = setup();
    m.addCall({ id: CALL_U });
    await storeAudioChunk(sampleChunk(0, 10), deps);
    await storeAudioChunk(callChunk(CALL_U, 0, 25), deps);
    expect(twinOf(m).speech_seconds).toBe(35);

    expect(await maybeStartClone({}, deps)).toEqual({ outcome: "skipped", reason: "not_enough_audio" });
    expect(twinOf(m).state).toBe("collecting");
    expect(m.created).toHaveLength(0);

    m.updateCall(CALL_U, { risk: crossedRisk(iso(m.clock)) });
    expect(await maybeStartClone({}, deps)).toMatchObject({ outcome: "ready", speechSeconds: 35 });
    expect(m.created[0].files).toHaveLength(2); // 16 kHz sample + 8 kHz call audio
  });

  it("a stale 'cloning' claim (its run died) can be claimed again; a fresh one can't", async () => {
    const { m, deps } = setup();
    await collect(deps);
    Object.assign(twinOf(m), { state: "cloning", cloning_started_at: iso(m.clock - 60_000) });

    expect(await maybeStartClone({}, deps)).toEqual({ outcome: "skipped", reason: "busy" });
    expect(m.created).toHaveLength(0);

    twinOf(m).cloning_started_at = iso(m.clock - (VOICE_TWIN_STALE_CLONING_SECONDS + 1) * 1000);
    expect(await maybeStartClone({}, deps)).toMatchObject({ outcome: "ready", voiceSource: "clone" });
    expect(m.created).toHaveLength(1);
  });

  it("a ready twin isn't cloned again", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    expect(await maybeStartClone({ allowFailed: true }, deps)).toEqual({ outcome: "skipped", reason: "not_collecting" });
    expect(m.created).toHaveLength(1);
  });

  it("revoke while cloning: the new voice is deleted (discarded) and the twin stays without consent", async () => {
    const m = new MemoryVoiceTwin().withConsent();
    const revokes: RevokeResult[] = [];
    const deps: VoiceTwinDeps = {
      ...m.deps(),
      voices: {
        ...m.elevenlabs,
        create: async (input) => {
          revokes.push(await revokeAndDelete({ userAgent: "Mozilla/5.0" }, deps)); // the customer revokes mid-clone
          return m.elevenlabs.create(input);
        },
      },
    };
    await collect(deps);

    const outcome = await maybeStartClone({}, deps);
    expect(outcome).toMatchObject({ outcome: "discarded" });
    expect(revokes).toEqual([{ audioDeleted: 3, voice: "none", problem: null }]);
    expect(m.created).toHaveLength(1);
    expect(m.deleted).toEqual(["cloned-voice-1"]);
    expect(m.voices.size).toBe(0);
    expect(m.deletionQueue.size).toBe(0);
    expect(twinOf(m)).toMatchObject({ voice_twin_consent: false, state: "collecting", speech_seconds: 0, voice_id: null, voice_source: null });
    expect(m.audio).toHaveLength(0);
    expect(m.objects.size).toBe(0);
    expect(await twinForTakeover(deps)).toBeNull();
  });

  it("revoke while cloning and the clone fails: the twin isn't marked failed (the claim is gone)", async () => {
    const m = new MemoryVoiceTwin().withConsent();
    const deps: VoiceTwinDeps = {
      ...m.deps(),
      voices: {
        ...m.elevenlabs,
        create: async () => {
          await revokeAndDelete({ userAgent: null }, deps);
          throw new Error("ElevenLabs down");
        },
      },
    };
    await collect(deps);
    expect(await maybeStartClone({}, deps)).toMatchObject({ outcome: "failed" });
    expect(twinOf(m)).toMatchObject({ voice_twin_consent: false, state: "collecting", clone_error: null });
  });

  it("a voice created after its claim was lost is queued and retried if deleting it fails", async () => {
    const m = new MemoryVoiceTwin().withConsent();
    const deps: VoiceTwinDeps = {
      ...m.deps(),
      voices: {
        ...m.elevenlabs,
        create: async (input) => {
          await revokeAndDelete({ userAgent: null }, deps);
          m.removeError = new Error("ElevenLabs 503");
          return m.elevenlabs.create(input);
        },
      },
    };
    await collect(deps);
    expect(await maybeStartClone({}, deps)).toMatchObject({ outcome: "discarded" });
    expect(m.deletionQueue.get("cloned-voice-1")).toMatchObject({ reason: "orphan", attempts: 1 });

    m.removeError = null;
    expect((await voiceTwinHousekeeping(deps)).voicesDeleted).toBe(1);
    expect(m.voices.size).toBe(0);
    expect(m.deletionQueue.size).toBe(0);
  });
});

// ---------- revoke ----------

describe("revokeAndDelete", () => {
  it("deletes every recording (table paths and stray objects in the twin's folder), resets the twin and logs the revoke", async () => {
    const { m, deps } = setup();
    m.addCall({ id: CALL_F, offered_at: iso(m.clock), handoff_status: "offered" });
    await storeAudioChunk(sampleChunk(0, 10), deps);
    await storeAudioChunk(callChunk(CALL_F, 0, 5), deps);
    m.objects.set(`${TWIN_ID}/call/old-stream/00003.wav`, chunkWav(8_000, 1)); // no table row
    m.objects.set(OTHER_TWIN_OBJECT, chunkWav(8_000, 1));
    m.clock += 1_000;

    const result = await revokeAndDelete({ userAgent: "Mozilla/5.0" }, deps);
    expect(result).toEqual({ audioDeleted: 3, voice: "none", problem: null });
    expect([...m.objects.keys()]).toEqual([OTHER_TWIN_OBJECT]);
    expect(m.audio).toHaveLength(0);
    expect(twinOf(m)).toMatchObject({
      voice_twin_consent: false,
      consent_revoked_at: iso(m.clock),
      state: "collecting",
      speech_seconds: 0,
      voice_id: null,
      voice_source: null,
      voice_created_at: null,
      voice_expires_at: null,
      clone_speech_seconds: null,
    });
    expect(m.consentEvents.at(-1)).toEqual({ event: "revoked", at: iso(m.clock), by: consentedByLabel("Ben"), userAgent: "Mozilla/5.0" });

    // Nothing is captured or cloned afterwards.
    expect(await storeAudioChunk(sampleChunk(1, 40), deps)).toEqual({ stored: false, reason: "no_consent" });
    expect(await maybeStartClone({}, deps)).toEqual({ outcome: "skipped", reason: "no_consent" });
    expect(m.objects.size).toBe(1);
  });

  it("deletes the app-made clone at ElevenLabs", async () => {
    const { m, deps } = setup();
    await makeReady(deps);

    expect(await revokeAndDelete({ userAgent: null }, deps)).toEqual({ audioDeleted: 0, voice: "deleted", problem: null });
    expect(m.deleted).toEqual(["cloned-voice-1"]);
    expect(m.voices.size).toBe(0);
    expect(m.deletionQueue.size).toBe(0);
    expect(twinOf(m)).toMatchObject({ voice_twin_consent: false, state: "collecting", speech_seconds: 0, voice_id: null, voice_source: null });
    expect(m.consentEvents.map((e) => e.event)).toEqual(["revoked"]);
    expect(await twinForTakeover(deps)).toBeNull();
  });

  it("keeps the hand-made fallback voice (voice 'fallback_kept')", async () => {
    const { m, deps } = setup({ fallbackVoiceId: "fallback-voice" });
    m.createError = new Error("down");
    expect((await makeReady(deps)).outcome).toBe("ready");
    m.voices.add("fallback-voice");

    expect(await revokeAndDelete({ userAgent: null }, deps)).toEqual({ audioDeleted: 0, voice: "fallback_kept", problem: null });
    expect(m.deleted).toHaveLength(0);
    expect(m.voices.has("fallback-voice")).toBe(true);
    expect(m.deletionQueue.size).toBe(0);
    expect(twinOf(m)).toMatchObject({ voice_twin_consent: false, voice_id: null, voice_source: null });
  });

  it("when ElevenLabs can't delete the voice: queued, reported as failed with a problem, and retried by housekeeping", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    m.removeError = new Error("ElevenLabs DELETE /v1/voices/cloned-voice-1 → 500");

    const result = await revokeAndDelete({ userAgent: null }, deps);
    expect(result.voice).toBe("failed");
    expect(result.problem).toMatch(/couldn't be deleted at ElevenLabs/);
    expect(m.deletionQueue.get("cloned-voice-1")).toMatchObject({ reason: "revoked", attempts: 1 });
    expect(m.voices.has("cloned-voice-1")).toBe(true);
    expect(twinOf(m).voice_twin_consent).toBe(false); // the revoke itself still happened

    expect((await voiceTwinHousekeeping(deps)).voicesDeleted).toBe(0); // still failing
    expect(m.deletionQueue.get("cloned-voice-1")).toMatchObject({ attempts: 2 });

    m.removeError = null;
    expect((await voiceTwinHousekeeping(deps)).voicesDeleted).toBe(1);
    expect(m.deletionQueue.size).toBe(0);
    expect(m.voices.size).toBe(0);
    expect(m.deleted).toEqual(["cloned-voice-1"]);
    expect((await voiceTwinHousekeeping(deps)).voicesDeleted).toBe(0);
  });

  it("a voice that is already gone at ElevenLabs reads as not_found and leaves the queue", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    m.voices.clear();
    expect(await revokeAndDelete({ userAgent: null }, deps)).toEqual({ audioDeleted: 0, voice: "not_found", problem: null });
    expect(m.deletionQueue.size).toBe(0);
  });

  it("when Storage fails, consent is still revoked, the problem is reported, and housekeeping sweeps the leftovers", async () => {
    const { m, deps } = setup();
    await collect(deps, 2);
    vi.spyOn(m.storage, "remove").mockRejectedValueOnce(new Error("storage down"));

    const result = await revokeAndDelete({ userAgent: null }, deps);
    expect(result).toEqual({ audioDeleted: 0, voice: "none", problem: expect.stringMatching(/recordings couldn't be deleted yet/) });
    expect(twinOf(m).voice_twin_consent).toBe(false);
    expect(m.audio).toHaveLength(0);
    expect(m.objects.size).toBe(2);

    const summary = await voiceTwinHousekeeping(deps);
    expect(summary.discardedChunks).toBe(2);
    expect(m.objects.size).toBe(0);
  });

  it("housekeeping doesn't sweep the folder of a twin that has consent again", async () => {
    const { m, deps } = setup();
    await revokeAndDelete({ userAgent: null }, deps);
    await giveConsent({ userAgent: null }, deps);
    await collect(deps, 1);
    expect((await voiceTwinHousekeeping(deps)).discardedChunks).toBe(0);
    expect(m.objects.size).toBe(1);
    expect(m.audio).toHaveLength(1);
  });

  it("without a twin it's a no-op", async () => {
    const m = new MemoryVoiceTwin();
    expect(await revokeAndDelete({ userAgent: null }, m.deps())).toEqual({ audioDeleted: 0, voice: "none", problem: null });
    expect(m.consentEvents).toHaveLength(0);
  });
});

// ---------- housekeeping ----------

describe("voiceTwinHousekeeping", () => {
  it("is a no-op without a twin", async () => {
    const m = new MemoryVoiceTwin();
    expect(await voiceTwinHousekeeping(m.deps())).toEqual({ expired: false, voicesDeleted: 0, discardedChunks: 0, clone: null });
  });

  it("retires the clone 24 h after creation: deleted at ElevenLabs, back to collecting with 0 s", async () => {
    const { m, deps } = setup();
    const createdAt = m.clock;
    await makeReady(deps);

    // Not yet due outside the final minute (0011: a voice in its last minute is already retired).
    m.clock = createdAt + VOICE_TWIN_CLONE_TTL_MS - 61_000;
    expect(await voiceTwinHousekeeping(deps)).toMatchObject({ expired: false, voicesDeleted: 0 });
    expect(twinOf(m).state).toBe("ready");

    m.clock = createdAt + VOICE_TWIN_CLONE_TTL_MS;
    expect(await voiceTwinHousekeeping(deps)).toMatchObject({ expired: true, voicesDeleted: 1, clone: null });
    expect(m.deleted).toEqual(["cloned-voice-1"]);
    expect(m.voices.size).toBe(0);
    expect(m.deletionQueue.size).toBe(0);
    expect(twinOf(m)).toMatchObject({
      voice_twin_consent: true,
      state: "collecting",
      speech_seconds: 0,
      voice_id: null,
      voice_source: null,
      voice_created_at: null,
      voice_expires_at: null,
      clone_speech_seconds: null,
    });
    expect(customerTwinView(m.twin, deps.settings(), m.clock)).toMatchObject({ state: "collecting", speechSeconds: 0, usable: false });
  });

  it("defers expiry while a live call is on the twin's voice (requested or connected)", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    m.clock += VOICE_TWIN_CLONE_TTL_MS - 10 * 60_000;
    // Handed over 10 minutes before the voice expires: still in use when expiry comes round.
    m.addCall({ id: CALL_F, offered_at: iso(m.clock), handoff_status: "connected", takeover_kind: "voice_twin", handoff_at: iso(m.clock) });
    m.clock += 10 * 60_000 + 1;

    expect(await voiceTwinHousekeeping(deps)).toMatchObject({ expired: false, voicesDeleted: 0 });
    expect(twinOf(m).state).toBe("ready");
    m.updateCall(CALL_F, { handoff_status: "requested" });
    expect((await voiceTwinHousekeeping(deps)).expired).toBe(false);
    expect(m.deleted).toHaveLength(0);

    m.updateCall(CALL_F, { status: "ended", handoff_status: "connected" });
    expect(await voiceTwinHousekeeping(deps)).toMatchObject({ expired: true, voicesDeleted: 1 });
    expect(twinOf(m).state).toBe("collecting");
  });

  it("never defers for long: a twin call stuck 'live' for over an hour (lost post-call webhook) doesn't block deletion", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    m.addCall({ id: CALL_F, offered_at: iso(m.clock), handoff_status: "connected", takeover_kind: "voice_twin", handoff_at: iso(m.clock) });
    m.clock += VOICE_TWIN_CLONE_TTL_MS + 1;
    expect(await voiceTwinHousekeeping(deps)).toMatchObject({ expired: true, voicesDeleted: 1 });
    expect(twinOf(m)).toMatchObject({ state: "collecting", voice_id: null });
  });

  it("a stuck twin call from before the current voice was made doesn't defer its expiry", async () => {
    const { m, deps } = setup();
    m.addCall({ id: CALL_F, offered_at: iso(m.clock), handoff_status: "connected", takeover_kind: "voice_twin", handoff_at: iso(m.clock - 60_000) });
    await makeReady(deps);
    m.clock += VOICE_TWIN_CLONE_TTL_MS + 1;
    // Even "recent" relative to a bound of now - 1 h would not matter: the handover predates this voice.
    m.updateCall(CALL_F, { handoff_at: iso(m.clock - VOICE_TWIN_CLONE_TTL_MS - 120_000) });
    expect((await voiceTwinHousekeeping(deps)).expired).toBe(true);
  });

  it("a live persona takeover doesn't defer the twin's expiry", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    m.addCall({ id: CALL_F, offered_at: iso(m.clock), handoff_status: "connected", takeover_kind: "persona" });
    m.clock += VOICE_TWIN_CLONE_TTL_MS + 1;
    expect((await voiceTwinHousekeeping(deps)).expired).toBe(true);
  });

  it("expiring a fallback twin keeps the fallback voice", async () => {
    const { m, deps } = setup({ fallbackVoiceId: "fallback-voice" });
    m.createError = new Error("down");
    await makeReady(deps);
    m.clock += VOICE_TWIN_CLONE_TTL_MS;
    expect(await voiceTwinHousekeeping(deps)).toMatchObject({ expired: true, voicesDeleted: 0 });
    expect(m.deleted).toHaveLength(0);
    expect(twinOf(m)).toMatchObject({ state: "collecting", voice_id: null });
  });

  it("discards the audio of a call that ended unflagged (seconds subtracted) and keeps flagged call audio", async () => {
    const { m, deps } = setup();
    m.addCall({ id: CALL_U });
    m.addCall({ id: CALL_F });
    await storeAudioChunk(callChunk(CALL_U, 0, 6), deps);
    await storeAudioChunk(callChunk(CALL_U, 1, 4), deps);
    await storeAudioChunk(callChunk(CALL_F, 0, 5), deps);
    await storeAudioChunk(sampleChunk(0, 3), deps);
    expect(twinOf(m).speech_seconds).toBe(18);

    // While both calls are live nothing is discarded.
    expect((await voiceTwinHousekeeping(deps)).discardedChunks).toBe(0);
    expect(m.audio).toHaveLength(4);

    m.updateCall(CALL_U, { status: "ended" });
    m.updateCall(CALL_F, { status: "ended", offered_at: iso(m.clock), handoff_status: "declined" });
    expect(await voiceTwinHousekeeping(deps)).toMatchObject({ discardedChunks: 2, clone: null });
    expect(twinOf(m).speech_seconds).toBe(8);
    expect(m.audio.map((a) => a.storage_path)).toEqual([callPath(CALL_F, 0), samplePath(0)]);
    expect([...m.objects.keys()].sort()).toEqual([callPath(CALL_F, 0), samplePath(0)].sort());

    expect((await voiceTwinHousekeeping(deps)).discardedChunks).toBe(0);
  });

  it("removes call audio whose call row was deleted, with its seconds", async () => {
    const { m, deps } = setup();
    m.addCall({ id: CALL_F, offered_at: iso(m.clock), handoff_status: "offered" });
    await storeAudioChunk(callChunk(CALL_F, 0, 7), deps);
    await storeAudioChunk(sampleChunk(0, 3), deps);
    m.deleteCall(CALL_F);
    expect(m.audio.find((a) => a.source === "call")?.call_id).toBeNull();

    expect((await voiceTwinHousekeeping(deps)).discardedChunks).toBe(1);
    expect(m.audio.map((a) => a.storage_path)).toEqual([samplePath(0)]);
    expect([...m.objects.keys()]).toEqual([samplePath(0)]);
    expect(twinOf(m).speech_seconds).toBe(3);
  });

  it("clones an idle collecting twin with enough speech, but not one with recent audio", async () => {
    const { m, deps } = setup();
    await collect(deps);

    m.clock += 5_000;
    expect((await voiceTwinHousekeeping(deps)).clone).toBeNull();
    expect(twinOf(m).state).toBe("collecting");
    expect(m.created).toHaveLength(0);

    m.clock += 15_000; // 20 s since the last chunk (the default idleMs)
    expect((await voiceTwinHousekeeping(deps)).clone).toMatchObject({ outcome: "ready", voiceSource: "clone" });
    expect(twinOf(m).state).toBe("ready");
  });

  it("honours a custom idleMs", async () => {
    const { m, deps } = setup();
    await collect(deps);
    m.clock += 5_000;
    expect((await voiceTwinHousekeeping(deps, { idleMs: 60_000 })).clone).toBeNull();
    expect((await voiceTwinHousekeeping(deps, { idleMs: 1_000 })).clone).toMatchObject({ outcome: "ready" });
  });

  it("doesn't clone below the minimum, a failed twin, or a twin without consent", async () => {
    const below = setup();
    await collect(below.deps, 2); // 24 s
    below.m.clock += HOUR;
    expect((await voiceTwinHousekeeping(below.deps)).clone).toBeNull();

    const failed = setup();
    await collect(failed.deps);
    Object.assign(twinOf(failed.m), { state: "failed", clone_error: "boom" });
    failed.m.clock += HOUR;
    expect((await voiceTwinHousekeeping(failed.deps)).clone).toBeNull();
    expect(failed.m.created).toHaveLength(0);

    const none = new MemoryVoiceTwin();
    await none.store.ensureTwin();
    expect((await voiceTwinHousekeeping(none.deps({ minSeconds: 0 }))).clone).toBeNull();
    expect(none.created).toHaveLength(0);
  });

  it("restarts a stale 'cloning' claim, but leaves a fresh one alone", async () => {
    const { m, deps } = setup();
    await collect(deps);
    Object.assign(twinOf(m), { state: "cloning", cloning_started_at: iso(m.clock) });

    m.clock += 60_000;
    expect((await voiceTwinHousekeeping(deps)).clone).toBeNull();
    expect(m.created).toHaveLength(0);

    m.clock += VOICE_TWIN_STALE_CLONING_SECONDS * 1000;
    expect((await voiceTwinHousekeeping(deps)).clone).toMatchObject({ outcome: "ready" });
  });

  it("never deletes the fallback voice, even if it ended up in the deletion queue, and clears the entry", async () => {
    const { m, deps } = setup({ fallbackVoiceId: "fallback-voice" });
    m.voices.add("fallback-voice");
    await m.store.queueVoiceDeletion("fallback-voice", null, "orphan");

    await voiceTwinHousekeeping(deps);
    expect(m.deleted).toHaveLength(0);
    expect(m.voices.has("fallback-voice")).toBe(true);
    expect(m.deletionQueue.size).toBe(0);
  });
});

// ---------- takeover ----------

describe("twinForTakeover", () => {
  it("null without a twin or without consent", async () => {
    const m = new MemoryVoiceTwin();
    expect(await twinForTakeover(m.deps())).toBeNull();
    await m.store.ensureTwin();
    expect(await twinForTakeover(m.deps())).toBeNull();
  });

  it("null unless the twin is ready", async () => {
    for (const state of ["collecting", "cloning", "failed"] as const) {
      const { m, deps } = setup();
      Object.assign(twinOf(m), { state, voice_id: "cloned-voice-9", voice_source: "clone", voice_expires_at: iso(m.clock + HOUR) });
      m.voices.add("cloned-voice-9");
      expect(await twinForTakeover(deps)).toBeNull();
    }
  });

  it("returns the voice, its source, the consent reference and the seconds it was built from", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    expect(await twinForTakeover(deps)).toEqual({
      voiceId: "cloned-voice-1",
      voiceSource: "clone",
      consentGivenAt: twinOf(m).consent_given_at,
      speechSeconds: 36,
    });
  });

  it("null once the voice expires within the next minute", async () => {
    const { m, deps } = setup();
    const createdAt = m.clock;
    await makeReady(deps);
    m.clock = createdAt + VOICE_TWIN_CLONE_TTL_MS - 60_000;
    expect(await twinForTakeover(deps)).not.toBeNull();
    m.clock += 1;
    expect(await twinForTakeover(deps)).toBeNull();
    m.clock = createdAt + VOICE_TWIN_CLONE_TTL_MS + HOUR;
    expect(await twinForTakeover(deps)).toBeNull();
  });

  it("null when ElevenLabs says the voice no longer exists; still usable when it can't tell", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    vi.spyOn(m.elevenlabs, "exists").mockResolvedValueOnce(null);
    expect(await twinForTakeover(deps)).toMatchObject({ voiceId: "cloned-voice-1" });
    m.voices.delete("cloned-voice-1");
    expect(await twinForTakeover(deps)).toBeNull();
  });

  it("works with the fallback voice", async () => {
    const { m, deps } = setup({ fallbackVoiceId: "fallback-voice" });
    m.voices.add("fallback-voice");
    m.createError = new Error("down");
    await makeReady(deps);
    expect(await twinForTakeover(deps)).toMatchObject({ voiceId: "fallback-voice", voiceSource: "fallback", speechSeconds: 36 });
  });

  it("rounds speechSeconds to one decimal and falls back to speech_seconds", async () => {
    const { m, deps } = setup();
    await makeReady(deps);
    twinOf(m).clone_speech_seconds = 31.26;
    expect((await twinForTakeover(deps))?.speechSeconds).toBe(31.3);
    Object.assign(twinOf(m), { clone_speech_seconds: null, speech_seconds: 40.04 });
    expect((await twinForTakeover(deps))?.speechSeconds).toBe(40);
  });
});

// ---------- call audio ----------

describe("discardUnflaggedCallAudio", () => {
  it("leaves a live call's audio alone", async () => {
    const { m, deps } = setup();
    m.addCall({ id: CALL_U });
    await storeAudioChunk(callChunk(CALL_U, 0, 6), deps);
    expect(await discardUnflaggedCallAudio(CALL_U, deps)).toBe(0);
    expect(m.audio).toHaveLength(1);
    expect(m.objects.size).toBe(1);
  });

  it("deletes an ended unflagged call's chunks (rows and objects) and subtracts their seconds", async () => {
    const { m, deps } = setup();
    m.addCall({ id: CALL_U });
    await storeAudioChunk(callChunk(CALL_U, 0, 6), deps);
    await storeAudioChunk(callChunk(CALL_U, 1, 4), deps);
    await storeAudioChunk(sampleChunk(0, 3), deps);
    m.updateCall(CALL_U, { status: "ended" });

    expect(await discardUnflaggedCallAudio(CALL_U, deps)).toBe(2);
    expect(m.audio.map((a) => a.storage_path)).toEqual([samplePath(0)]);
    expect([...m.objects.keys()]).toEqual([samplePath(0)]);
    expect(twinOf(m).speech_seconds).toBe(3);
    expect(await discardUnflaggedCallAudio(CALL_U, deps)).toBe(0);
  });

  it("keeps a flagged call's audio (offered, threshold crossed, declined or handed over)", async () => {
    const flags = [
      { offered_at: "2026-11-06T12:00:00.000Z" },
      { risk: crossedRisk("2026-11-06T12:00:00.000Z") },
      { handoff_status: "declined" as const },
      { handoff_status: "failed" as const },
      { handoff_status: "connected" as const },
    ];
    for (const flag of flags) {
      const { m, deps } = setup();
      m.addCall({ id: CALL_F });
      await storeAudioChunk(callChunk(CALL_F, 0, 6), deps);
      m.updateCall(CALL_F, { status: "ended", ...flag });
      expect(await discardUnflaggedCallAudio(CALL_F, deps)).toBe(0);
      expect(m.audio).toHaveLength(1);
      expect(twinOf(m).speech_seconds).toBe(6);
    }
  });
});

describe("isCallFlagged (mirrors SQL call_is_flagged)", () => {
  const base = { offered_at: null, risk: null, handoff_status: "none" as const };
  it("is flagged once offered, once the threshold was crossed, or after any handover state", () => {
    expect(isCallFlagged(base)).toBe(false);
    expect(isCallFlagged({ ...base, offered_at: "2026-11-06T12:00:00.000Z" })).toBe(true);
    expect(isCallFlagged({ ...base, risk: crossedRisk("2026-11-06T12:00:00.000Z") })).toBe(true);
    expect(isCallFlagged({ ...base, risk: { ...crossedRisk("x"), threshold_crossed_at: undefined } })).toBe(false);
    for (const status of ["offered", "declined", "requested", "connected", "failed"] as const) {
      expect(isCallFlagged({ ...base, handoff_status: status })).toBe(true);
    }
  });
});

// ---------- paths and the customer's view ----------

describe("audioPath", () => {
  it("is <twin>/<source>/<session>/<seq padded>.wav", () => {
    expect(audioPath(TWIN_ID, "sample", SAMPLE_SESSION, 7)).toBe(`${TWIN_ID}/sample/${SAMPLE_SESSION}/00007.wav`);
    expect(audioPath("t", "call", "MZabc_1", 12345)).toBe("t/call/MZabc_1/12345.wav");
  });

  it("sanitises the session so a path can never leave the twin's folder", () => {
    expect(audioPath("t", "call", "../../etc/passwd", 0)).toBe("t/call/etcpasswd/00000.wav");
    expect(audioPath("t", "sample", "a/b\\c d.e?f", 1)).toBe("t/sample/abcdef/00001.wav");
    expect(audioPath("t", "sample", "", 1)).toBe("t/sample/session/00001.wav");
    expect(audioPath("t", "sample", "../..//", 1)).toBe("t/sample/session/00001.wav");
    expect(audioPath("t", "sample", "x".repeat(200), 1)).toBe(`t/sample/${"x".repeat(64)}/00001.wav`);
    for (const session of ["..", "../x", "/abs", "a/../../b", "%2e%2e", "ü-ñ"]) {
      const p = audioPath("t", "sample", session, 0);
      expect(p.startsWith("t/sample/")).toBe(true);
      expect(p.split("/")).toHaveLength(4);
      expect(p).not.toContain("..");
    }
  });
});

describe("customerTwinView", () => {
  const settings = { minSeconds: 30, targetSeconds: 60 };
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  const row = (overrides: Partial<VoiceTwinRow> = {}): VoiceTwinRow => {
    const twin = new MemoryVoiceTwin(now).withConsent(overrides).twin;
    if (!twin) throw new Error("no twin");
    return twin;
  };
  const nothing = {
    consent: false,
    consentGivenAt: null,
    consentGivenBy: null,
    state: "collecting",
    speechSeconds: 0,
    minSeconds: 30,
    targetSeconds: 60,
    usable: false,
    voiceSource: null,
    voiceCreatedAt: null,
    voiceExpiresAt: null,
    cloneSpeechSeconds: null,
    error: null,
    liveCapture: false,
  };

  it("no twin → nothing", () => {
    expect(customerTwinView(null, settings, now)).toEqual(nothing);
    expect(customerTwinView(undefined, settings, now)).toEqual(nothing);
  });

  it("no consent hides everything (even an earlier consent's details)", () => {
    const revoked = row({ voice_twin_consent: false, consent_revoked_at: iso(now), clone_error: "old" });
    expect(customerTwinView(revoked, settings, now)).toEqual(nothing);
  });

  it("collecting shows the consent and the speech so far (one decimal)", () => {
    const view = customerTwinView(row({ speech_seconds: 12.345 }), settings, now);
    expect(view).toMatchObject({
      consent: true,
      consentGivenBy: "Ben (account holder, Call Guard Settings)",
      state: "collecting",
      speechSeconds: 12.3,
    });
    expect(view.consentGivenAt).toBe(iso(now));
    expect(view.usable).toBe(false);
  });

  it("ready → usable with the voice's source and dates, never the voice id", () => {
    const ready = row({
      state: "ready",
      speech_seconds: 36,
      voice_id: "secret-voice-id",
      voice_source: "clone",
      voice_created_at: iso(now - HOUR),
      voice_expires_at: iso(now + HOUR),
      clone_speech_seconds: 35.96,
    });
    const view = customerTwinView(ready, settings, now);
    expect(view).toMatchObject({
      state: "ready",
      usable: true,
      speechSeconds: 36,
      voiceSource: "clone",
      voiceCreatedAt: iso(now - HOUR),
      voiceExpiresAt: iso(now + HOUR),
      cloneSpeechSeconds: 36,
      error: null,
    });
    expect(JSON.stringify(view)).not.toContain("secret-voice-id");
  });

  it("an expired ready voice reads as collecting with 0 s and isn't usable", () => {
    for (const expires of [iso(now), iso(now - 1), null]) {
      const view = customerTwinView(
        row({ state: "ready", speech_seconds: 36, voice_id: "v", voice_source: "clone", voice_expires_at: expires, clone_speech_seconds: 36 }),
        settings,
        now,
      );
      expect(view).toMatchObject({
        state: "collecting",
        speechSeconds: 0,
        usable: false,
        voiceSource: null,
        voiceExpiresAt: null,
        cloneSpeechSeconds: null,
      });
    }
  });

  it("failed shows a plain-language error, not the technical one", () => {
    const view = customerTwinView(row({ state: "failed", speech_seconds: 36, clone_error: "ElevenLabs → 500: stack trace" }), settings, now);
    expect(view.state).toBe("failed");
    expect(view.usable).toBe(false);
    expect(view.error).toBe("We couldn't make your AI Voice Twin. You can try again from Settings.");
    expect(JSON.stringify(view)).not.toContain("stack trace");
  });

  it("targetSeconds is never below minSeconds", () => {
    expect(customerTwinView(null, { minSeconds: 90, targetSeconds: 60 }, now).targetSeconds).toBe(90);
  });

  it("getCustomerTwinView uses the deps' settings and clock", async () => {
    const { m, deps } = setup({ minSeconds: 45, targetSeconds: 90 });
    await collect(deps, 1);
    const view = await getCustomerTwinView(deps);
    expect(view).toMatchObject({ consent: true, minSeconds: 45, targetSeconds: 90, state: "collecting", speechSeconds: 12 });
    Object.assign(twinOf(m), { state: "ready", voice_id: "v", voice_source: "clone", voice_expires_at: iso(m.clock + HOUR) });
    expect((await getCustomerTwinView(deps)).usable).toBe(true);
    m.clock += HOUR;
    expect(await getCustomerTwinView(deps)).toMatchObject({ usable: false, state: "collecting", speechSeconds: 0 });
  });

  it("progressLabel and roundSeconds", () => {
    expect(progressLabel(18.9, 30)).toBe("18s / 30s of your voice");
    expect(progressLabel(-3, 30)).toBe("0s / 30s of your voice");
    expect(roundSeconds(12.345)).toBe(12.3);
    expect(roundSeconds(-1)).toBe(0);
    expect(roundSeconds(Number.NaN)).toBe(0);
    expect(roundSeconds(null)).toBe(0);
  });
});
