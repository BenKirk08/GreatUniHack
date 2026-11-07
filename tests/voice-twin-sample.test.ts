import { describe, expect, it } from "vitest";
import { MemoryVoiceTwin } from "@/lib/voice-twin/memory-store";
import { bytesToBase64 } from "@/lib/voice-twin/recorder";
import {
  acceptSampleChunk,
  decodeSampleBase64,
  NO_CONSENT_ERROR,
  prepareSampleChunk,
  SAMPLE_CHUNK_MAX_BASE64,
  SAMPLE_CHUNK_MAX_BYTES,
} from "@/lib/voice-twin/sample";
import { DEFAULT_VAD, SpeechCounter } from "@/lib/voice-twin/vad";
import { decodeWav, encodeWav } from "@/lib/voice-twin/wav";
import { speechLike } from "./helpers/voice-fixtures";

// ---------- synthetic audio ----------

/** Continuous speech-like audio at the given active RMS level (what the server-side VAD counts as speech). */
function speech(rate: number, seconds: number, dbfs = -20): Float32Array {
  return speechLike(rate, seconds, dbfs, { gaps: false });
}

function silence(rate: number, seconds: number): Float32Array {
  return new Float32Array(Math.round(rate * seconds));
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A hand-built RIFF/WAVE file (for formats encodeWav won't write: stereo, 8-bit). */
function rawWav(opts: { channels: number; bits: number; sampleRate: number; data: Uint8Array }): Uint8Array {
  const { channels, bits, sampleRate, data } = opts;
  const out = new Uint8Array(44 + data.length);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + data.length, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, (sampleRate * channels * bits) / 8, true);
  v.setUint16(32, (channels * bits) / 8, true);
  v.setUint16(34, bits, true);
  tag(36, "data");
  v.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

/** 1 s of speech then 2 s of silence: about 1 s of clean speech. */
function speechThenSilence(rate = 24_000): Uint8Array {
  return encodeWav(concat(speech(rate, 1), silence(rate, 2)), rate);
}

const SESSION = "0f8b6f8e-3c1a-4d2b-9a77-5b1d2c3e4f50";

// ---------- prepareSampleChunk ----------

describe("prepareSampleChunk", () => {
  it("accepts a WAV of speech + silence and re-counts the speech on the server", () => {
    const prepared = prepareSampleChunk(speechThenSilence());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.sampleRate).toBe(24_000);
    expect(prepared.inputSeconds).toBeCloseTo(3, 5);
    // about 1 s of continuous speech-like audio, counted by the server VAD.
    expect(prepared.speechSeconds).toBeGreaterThanOrEqual(0.99);
    expect(prepared.speechSeconds).toBeLessThanOrEqual(1.05);
  });

  it("keeps only the kept audio (speech plus a short hangover), not the silence", () => {
    const prepared = prepareSampleChunk(speechThenSilence());
    if (!prepared.ok) throw new Error(prepared.error);
    const out = decodeWav(prepared.wav);
    expect(out.channels).toBe(1);
    expect(out.sampleRate).toBe(24_000);
    expect(out.samples.length / 24_000).toBeCloseTo(prepared.keptSeconds, 6);
    // Speech plus at most the VAD's hangover frames of 30 ms; the 2 s of silence is gone.
    expect(prepared.keptSeconds).toBeGreaterThanOrEqual(prepared.speechSeconds);
    expect(prepared.keptSeconds).toBeLessThanOrEqual(prepared.speechSeconds + DEFAULT_VAD.hangoverFrames * 0.03 + 1e-9);
    expect(prepared.keptSeconds).toBeLessThan(prepared.inputSeconds / 2);
  });

  it("counts nothing (and keeps nothing) in silence or a faint hiss", () => {
    for (const samples of [silence(24_000, 2), speech(24_000, 2, -60)]) {
      const prepared = prepareSampleChunk(encodeWav(samples, 24_000));
      expect(prepared).toMatchObject({ ok: true, speechSeconds: 0, keptSeconds: 0 });
    }
  });

  it("stores the speech as recorded: levelling is done once, over the merged file, when the clone is made", () => {
    const quiet = encodeWav(concat(speech(24_000, 1, -32), silence(24_000, 1)), 24_000);
    const prepared = prepareSampleChunk(quiet);
    if (!prepared.ok) throw new Error(prepared.error);
    const kept = decodeWav(prepared.wav).samples;
    let sum = 0;
    for (const v of kept) sum += (v / 32768) ** 2;
    const db = 10 * Math.log10(sum / kept.length);
    expect(db).toBeLessThan(-30); // not pulled up to -20 dBFS chunk by chunk
    expect(db).toBeGreaterThan(-36);
  });

  it("re-counts what the browser counted, give or take a frame per chunk: the pause between utterances is never counted", () => {
    // The browser (lib/voice-twin/recorder.ts) counts with the same VAD, sends only what it kept every ~3 s, and the
    // server re-counts each chunk with a fresh counter. Between two utterances a chunk holds only the browser's
    // hangover and the next pre-roll, which the re-count must not take for a pause inside an utterance.
    const rate = 24_000;
    for (const [seconds, pause] of [
      [0.4, 0.5],
      [0.8, 0.6],
      [1.5, 0.5],
    ]) {
      const parts: Float32Array[] = [silence(rate, 0.5)];
      for (let i = 0; i < 12; i++) {
        parts.push(speechLike(rate, seconds, -24, { gaps: false, seed: i + 3, f0: 140 + (i % 3) * 15 }), silence(rate, pause));
      }
      const signal = concat(...parts);

      const browser = new SpeechCounter({ sampleRate: rate });
      let kept: Float32Array[] = [];
      let sinceChunk = 0;
      let chunks = 0;
      let server = 0;
      const send = () => {
        const prepared = prepareSampleChunk(encodeWav(concat(...kept), rate));
        if (!prepared.ok) throw new Error(prepared.error);
        server += prepared.speechSeconds;
        kept = [];
        chunks++;
      };
      for (let offset = 0; offset < signal.length; offset += 4096) {
        const block = signal.subarray(offset, offset + 4096);
        kept.push(browser.push(block).kept);
        sinceChunk += block.length;
        if (sinceChunk >= 3 * rate) {
          sinceChunk = 0;
          send();
        }
      }
      browser.flush(); // the recording ends in a pause: nothing is left to judge
      send();

      const voiced = 12 * seconds;
      const label = `${seconds} s utterances, ${pause} s pauses`;
      expect(Math.abs(server - browser.speechSeconds), label).toBeLessThanOrEqual(2 * chunks * 0.03 + 1e-9);
      // Both count about the voiced time: each utterance's pre-roll and edge frames at most, never the pauses.
      for (const counted of [browser.speechSeconds, server]) {
        expect(counted, label).toBeGreaterThanOrEqual(0.9 * voiced);
        expect(counted, label).toBeLessThanOrEqual(voiced + 12 * (DEFAULT_VAD.prerollFrames + 2) * 0.03);
      }
    }
  });

  it("works at the file's own rate, from 8 kHz to 48 kHz", () => {
    for (const rate of [8_000, 16_000, 44_100, 48_000]) {
      const prepared = prepareSampleChunk(speechThenSilence(rate));
      expect(prepared.ok, `${rate} Hz`).toBe(true);
      if (!prepared.ok) continue;
      expect(prepared.sampleRate).toBe(rate);
      expect(prepared.speechSeconds).toBeGreaterThan(0.95);
      expect(prepared.speechSeconds).toBeLessThan(1.06);
    }
  });

  it("rejects stereo", () => {
    const stereo = rawWav({ channels: 2, bits: 16, sampleRate: 24_000, data: new Uint8Array(24_000 * 4) });
    expect(prepareSampleChunk(stereo)).toMatchObject({ ok: false, reason: "not_mono" });
  });

  it("rejects 8-bit PCM", () => {
    const eightBit = rawWav({ channels: 1, bits: 8, sampleRate: 8_000, data: new Uint8Array(8_000).fill(128) });
    expect(prepareSampleChunk(eightBit)).toMatchObject({ ok: false, reason: "unsupported_wav" });
  });

  it("rejects sample rates outside 8–48 kHz", () => {
    expect(prepareSampleChunk(encodeWav(speech(96_000, 0.5), 96_000))).toMatchObject({ ok: false, reason: "bad_rate" });
    expect(prepareSampleChunk(encodeWav(speech(4_000, 1), 4_000))).toMatchObject({ ok: false, reason: "bad_rate" });
  });

  it("rejects anything over 10 s", () => {
    expect(prepareSampleChunk(encodeWav(speech(8_000, 10), 8_000)).ok).toBe(true);
    expect(prepareSampleChunk(encodeWav(speech(8_000, 10.5), 8_000))).toMatchObject({ ok: false, reason: "too_long" });
  });

  it("rejects oversized files before decoding them", () => {
    const big = new Uint8Array(SAMPLE_CHUNK_MAX_BYTES + 1);
    expect(prepareSampleChunk(big)).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("rejects garbage", () => {
    const garbage = new Uint8Array(4_096);
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 7919) & 0xff;
    for (const bytes of [garbage, new Uint8Array(0), new TextEncoder().encode("RIFF....WAVEnope")]) {
      const prepared = prepareSampleChunk(bytes);
      expect(prepared).toMatchObject({ ok: false, reason: "unsupported_wav" });
      if (!prepared.ok) expect(prepared.error).not.toMatch(/WAV:/); // the customer gets plain language; details go to the log
    }
  });
});

// ---------- base64 (browser encoder → server decoder) ----------

describe("decodeSampleBase64", () => {
  it("round-trips the browser's bytesToBase64", () => {
    const wav = speechThenSilence();
    const encoded = bytesToBase64(wav);
    expect(encoded).toBe(Buffer.from(wav).toString("base64"));
    const decoded = decodeSampleBase64(encoded);
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.bytes).toEqual(wav);
  });

  it("rejects malformed and oversized base64", () => {
    expect(decodeSampleBase64("not base64!")).toMatchObject({ ok: false, reason: "not_base64" });
    expect(decodeSampleBase64("abc")).toMatchObject({ ok: false, reason: "not_base64" });
    expect(decodeSampleBase64("")).toMatchObject({ ok: false, reason: "not_base64" });
    expect(decodeSampleBase64("A".repeat(SAMPLE_CHUNK_MAX_BASE64 + 4))).toMatchObject({ ok: false, reason: "too_large" });
  });
});

// ---------- acceptSampleChunk (the route's logic, over the in-memory store) ----------

function chunk(wav: Uint8Array, seq = 0, final = false) {
  return { sessionId: SESSION, seq, final, audioBase64: bytesToBase64(wav) };
}

describe("acceptSampleChunk", () => {
  it("refuses without consent (403) and stores nothing", async () => {
    for (const m of [new MemoryVoiceTwin(), new MemoryVoiceTwin().withConsent({ voice_twin_consent: false, consent_given_at: null })]) {
      const outcome = await acceptSampleChunk(chunk(speechThenSilence(), 0, true), m.deps());
      expect(outcome.status).toBe(403);
      expect(outcome.body).toMatchObject({ ok: false, error: NO_CONSENT_ERROR });
      expect(outcome.startClone).toBe(false);
      expect(m.objects.size).toBe(0);
      expect(m.audio).toHaveLength(0);
    }
  });

  it("stores only the server-counted speech, as a sample with no call", async () => {
    const m = new MemoryVoiceTwin().withConsent();
    const outcome = await acceptSampleChunk(chunk(speechThenSilence()), m.deps());
    expect(outcome.status).toBe(200);
    expect(outcome.startClone).toBe(false);
    if (!outcome.body.ok) throw new Error(outcome.body.error);
    expect(outcome.body.stored).toBe(true);
    expect(outcome.body.speechSeconds).toBeGreaterThan(0.95);
    expect(outcome.body.twin.speechSeconds).toBeCloseTo(outcome.body.speechSeconds, 1);

    expect(m.audio).toHaveLength(1);
    expect(m.audio[0]).toMatchObject({ source: "sample", call_id: null, session_id: SESSION, seq: 0, sample_rate: 24_000 });
    expect(m.twin?.speech_seconds).toBeCloseTo(outcome.body.speechSeconds, 6);
    const stored = decodeWav(m.objects.get(m.audio[0].storage_path) as Uint8Array);
    // The speech and its hangover: the 2 s of silence wasn't kept.
    expect(stored.samples.length / 24_000).toBeLessThan(1 + (DEFAULT_VAD.hangoverFrames + 2) * 0.03);
  });

  it("asks for the clone on the final chunk", async () => {
    const m = new MemoryVoiceTwin().withConsent();
    const outcome = await acceptSampleChunk(chunk(speechThenSilence(), 3, true), m.deps());
    expect(outcome).toMatchObject({ status: 200, startClone: true, body: { ok: true, stored: true } });
  });

  it("a final chunk with no speech stores nothing but still ends the session", async () => {
    const m = new MemoryVoiceTwin().withConsent();
    const outcome = await acceptSampleChunk(chunk(encodeWav(silence(24_000, 1), 24_000), 4, true), m.deps());
    expect(outcome).toMatchObject({ status: 200, startClone: true, body: { ok: true, stored: false, speechSeconds: 0 } });
    expect(m.objects.size).toBe(0);
  });

  it("is idempotent per session and seq (the browser retries once)", async () => {
    const m = new MemoryVoiceTwin().withConsent();
    await acceptSampleChunk(chunk(speechThenSilence(), 1), m.deps());
    const total = m.twin?.speech_seconds;
    const again = await acceptSampleChunk(chunk(speechThenSilence(), 1), m.deps());
    expect(again.body).toMatchObject({ ok: true, stored: true });
    expect(m.audio).toHaveLength(1);
    expect(m.twin?.speech_seconds).toBe(total);
  });

  it("rejects unreadable audio with a 400 and stores nothing", async () => {
    const m = new MemoryVoiceTwin().withConsent();
    const stereo = rawWav({ channels: 2, bits: 16, sampleRate: 24_000, data: new Uint8Array(24_000 * 4) });
    for (const input of [chunk(stereo), { sessionId: SESSION, seq: 0, final: false, audioBase64: "%%%%" }]) {
      const outcome = await acceptSampleChunk(input, m.deps());
      expect(outcome.status).toBe(400);
      expect(outcome.body.ok).toBe(false);
      expect(outcome.body.twin?.consent).toBe(true);
    }
    expect(m.objects.size).toBe(0);
    expect(m.audio).toHaveLength(0);
  });

  it("doesn't store while the twin is being made", async () => {
    const m = new MemoryVoiceTwin().withConsent({ state: "cloning", speech_seconds: 31, cloning_started_at: new Date(0).toISOString() });
    const outcome = await acceptSampleChunk(chunk(speechThenSilence()), m.deps());
    expect(outcome).toMatchObject({ status: 200, body: { ok: true, stored: false, speechSeconds: 0, twin: { state: "cloning" } } });
    expect(m.objects.size).toBe(0);
  });
});
