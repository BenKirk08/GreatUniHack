import { describe, expect, it } from "vitest";
import { decodeMulaw, encodeMulaw, float32ToPcm16, pcm16ToFloat32 } from "@/lib/voice-twin/mulaw";
import { DEFAULT_VAD, dtmfScore, frameStats, isCleanSpeechFrame, periodicity, SpeechCounter, tonalFlatness } from "@/lib/voice-twin/vad";
import { decodeWav, encodeWav, mergeWavs, normaliseLoudness, normaliseWavLoudness, resampleLinear, wavDurationSeconds } from "@/lib/voice-twin/wav";
import { bandPassNoise, bursts, cadence, DTMF_KEYS, hum, join, lowPassNoise, mix, speechLike, tones } from "./helpers/voice-fixtures";

// ---------- synthetic signals ----------

/** Sine with the given RMS level in dBFS. */
function sine(rate: number, seconds: number, dbfs: number, freq = 300): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  const amp = Math.SQRT2 * 10 ** (dbfs / 20);
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function silence(rate: number, seconds: number): Float32Array {
  return new Float32Array(Math.round(rate * seconds));
}

/** Deterministic uniform white noise with the given RMS level in dBFS. */
function noise(rate: number, seconds: number, dbfs: number, seed = 1): Float32Array {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const amp = Math.sqrt(3) * 10 ** (dbfs / 20);
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * (2 * random() - 1);
  return out;
}

/** Full-scale square wave: every sample at ±1. */
function square(rate: number, seconds: number, freq = 300): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.floor((2 * freq * i) / rate) % 2 === 0 ? 1 : -1;
  return out;
}

/** Add deterministic white noise at the given RMS level to a signal (same length). */
function withNoise(signal: Float32Array, dbfs: number, seed = 9): Float32Array {
  const added = noise(1, signal.length, dbfs, seed); // rate is irrelevant: it just sizes the array
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] + added[i];
  return out;
}

/** Short broadband clicks: a ~20 ms noise burst every 250 ms (each shorter than minRunFrames). */
function clicks(rate: number, seconds: number, dbfs = -4): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  const period = Math.round(rate * 0.25);
  const width = Math.round(rate * 0.02);
  const burst = noise(rate, width / rate, dbfs, 31);
  for (let i = 0; i + width < out.length; i += period) out.set(burst, i);
  return out;
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

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.sqrt(sum / samples.length);
}

/** Index of the first differing sample, or -1 when the arrays are identical. */
function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** Run a whole signal through a fresh counter in one push and a flush (whose judged-whole tail is included). */
function count(signal: Float32Array | Int16Array, rate: number) {
  const counter = new SpeechCounter({ sampleRate: rate });
  const pushed = counter.push(signal);
  const tail = counter.flush();
  const result = { frames: pushed.frames, speechFrames: pushed.speechFrames + tail.speechFrames, kept: concat(pushed.kept, tail.kept) };
  return { counter, result };
}

// ---------- WAV construction helpers for the parser tests ----------

function chunk(id: string, body: Uint8Array): Uint8Array {
  const padded = body.length + (body.length & 1);
  const out = new Uint8Array(8 + padded);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  view.setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function fmtBody(opts: { format?: number; channels?: number; sampleRate?: number; bits?: number }): Uint8Array {
  const { format = 1, channels = 1, sampleRate = 16000, bits = 16 } = opts;
  const body = new Uint8Array(16);
  const view = new DataView(body.buffer);
  view.setUint16(0, format, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, (sampleRate * channels * bits) / 8, true);
  view.setUint16(12, (channels * bits) / 8, true);
  view.setUint16(14, bits, true);
  return body;
}

function pcmBody(samples: number[]): Uint8Array {
  const body = new Uint8Array(samples.length * 2);
  const view = new DataView(body.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return body;
}

function riff(...chunks: Uint8Array[]): Uint8Array {
  const total = 12 + chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  view.setUint32(4, total - 8, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  let offset = 12;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

// ---------- μ-law ----------

describe("μ-law", () => {
  it("decodes table spot values", () => {
    const decoded = decodeMulaw(new Uint8Array([0xff, 0x7f, 0x00, 0x80, 0xfe, 0x7e]));
    expect(Array.from(decoded)).toEqual([0, 0, -32124, 32124, 8, -8]);
  });

  it("decode table is sign-symmetric", () => {
    const all = decodeMulaw(Uint8Array.from({ length: 256 }, (_, i) => i));
    for (let b = 0; b < 128; b++) expect(all[b] + all[b | 0x80]).toBe(0);
  });

  it("re-encoding a decoded value gives back the same code (except negative zero 0x7F)", () => {
    const codes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const again = encodeMulaw(decodeMulaw(codes));
    for (let b = 0; b < 256; b++) expect(again[b]).toBe(b === 0x7f ? 0xff : b);
  });

  it("encode → decode stays within G.711 quantisation (half a step) across the range", () => {
    for (let x = -32635; x <= 32635; x += 7) {
      const [y] = decodeMulaw(encodeMulaw(Int16Array.of(x)));
      // Step size is 2^(exponent+3) and the biased magnitude is ≥ 2^(exponent+7), so half a step ≤ (|x| + 132) / 32.
      expect(Math.abs(y - x)).toBeLessThanOrEqual((Math.abs(x) + 0x84) / 32);
    }
    expect(encodeMulaw(Int16Array.of(0))[0]).toBe(0xff);
    expect(Array.from(decodeMulaw(encodeMulaw(Int16Array.of(32767, -32768))))).toEqual([32124, -32124]);
  });

  it("converts between PCM16 and float", () => {
    expect(Array.from(pcm16ToFloat32(Int16Array.of(0, 16384, -32768, 32767)))).toEqual([0, 0.5, -1, 32767 / 32768]);
    const pcm = float32ToPcm16(Float32Array.of(0, 0.5, -0.5, 1, -1, 2, -2, NaN));
    expect(Array.from(pcm)).toEqual([0, 16384, -16383, 32767, -32767, 32767, -32767, 0]);
  });
});

// ---------- WAV ----------

describe("WAV", () => {
  it("encodes a standard 44-byte PCM16 mono header and round-trips the samples", () => {
    const samples = Int16Array.from({ length: 1000 }, (_, i) => ((i * 97) % 65536) - 32768);
    const wav = encodeWav(samples, 24000);
    const view = new DataView(wav.buffer);
    expect(wav.length).toBe(44 + 2000);
    expect(ascii(wav, 0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 2000);
    expect(ascii(wav, 8)).toBe("WAVE");
    expect(ascii(wav, 12)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint32(28, true)).toBe(48000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(wav, 36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(2000);

    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(24000);
    expect(decoded.channels).toBe(1);
    expect(firstDifference(decoded.samples, samples)).toBe(-1);
  });

  it("converts float input with float32ToPcm16", () => {
    const input = Float32Array.of(0, 0.25, -0.75, 1.5);
    expect(Array.from(decodeWav(encodeWav(input, 8000)).samples)).toEqual(Array.from(float32ToPcm16(input)));
  });

  it("decodes from a Uint8Array view with a non-zero byte offset", () => {
    const wav = encodeWav(Int16Array.of(1, -2, 3), 16000);
    const padded = new Uint8Array(wav.length + 3);
    padded.set(wav, 3);
    expect(Array.from(decodeWav(padded.subarray(3)).samples)).toEqual([1, -2, 3]);
  });

  it("skips unknown chunks such as LIST, honouring odd-size padding", () => {
    const list = chunk("LIST", new Uint8Array([0x49, 0x4e, 0x46, 0x4f, 0x21])); // 5 bytes + pad byte
    const junk = chunk("JUNK", new Uint8Array(7));
    const wav = riff(junk, chunk("fmt ", fmtBody({ sampleRate: 22050 })), list, chunk("data", pcmBody([100, -200, 300])));
    expect(wav.length).toBe(12 + 16 + 24 + 14 + 14); // JUNK and LIST both carry a pad byte
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(22050);
    expect(Array.from(decoded.samples)).toEqual([100, -200, 300]);
    expect(wavDurationSeconds(wav)).toBeCloseTo(3 / 22050, 12);
  });

  it("downmixes stereo to mono by averaging channels", () => {
    const wav = riff(chunk("fmt ", fmtBody({ channels: 2, sampleRate: 44100 })), chunk("data", pcmBody([1000, 3000, -2000, 2000, 7, 8])));
    const decoded = decodeWav(wav);
    expect(decoded.channels).toBe(2);
    expect(decoded.sampleRate).toBe(44100);
    expect(Array.from(decoded.samples)).toEqual([2000, 0, 8]);
    expect(wavDurationSeconds(wav)).toBeCloseTo(3 / 44100, 12);
  });

  it("accepts WAVE_FORMAT_EXTENSIBLE with a PCM sub-format", () => {
    const body = new Uint8Array(40);
    body.set(fmtBody({ sampleRate: 48000 }));
    const view = new DataView(body.buffer);
    view.setUint16(0, 0xfffe, true);
    view.setUint16(16, 22, true); // cbSize
    view.setUint16(24, 1, true); // KSDATAFORMAT_SUBTYPE_PCM starts with 0x0001
    const decoded = decodeWav(riff(chunk("fmt ", body), chunk("data", pcmBody([5, 6]))));
    expect(decoded.sampleRate).toBe(48000);
    expect(Array.from(decoded.samples)).toEqual([5, 6]);
  });

  it("tolerates an oversized data length from a streaming writer", () => {
    const wav = encodeWav(Int16Array.of(1, 2, 3, 4), 8000);
    new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
    expect(Array.from(decodeWav(wav).samples)).toEqual([1, 2, 3, 4]);
  });

  it("throws clear errors on unsupported input", () => {
    expect(() => decodeWav(new Uint8Array(4))).toThrow(/too short/);
    expect(() => decodeWav(new TextEncoder().encode("OggS not a wav at all"))).toThrow(/RIFF\/WAVE/);
    expect(() => decodeWav(riff(chunk("data", pcmBody([1]))))).toThrow(/missing fmt/);
    expect(() => decodeWav(riff(chunk("fmt ", fmtBody({}))))).toThrow(/missing data/);
    expect(() => decodeWav(riff(chunk("fmt ", fmtBody({ format: 3, bits: 32 })), chunk("data", new Uint8Array(4))))).toThrow(
      /format 3/,
    );
    expect(() => decodeWav(riff(chunk("fmt ", fmtBody({ bits: 8 })), chunk("data", new Uint8Array(4))))).toThrow(/8-bit/);
    expect(() => encodeWav(new Int16Array(1), 0)).toThrow(/sample rate/);
  });

  it("reports duration from the header", () => {
    expect(wavDurationSeconds(encodeWav(new Int16Array(24000), 24000))).toBe(1);
    expect(wavDurationSeconds(encodeWav(new Int16Array(4000), 8000))).toBe(0.5);
    expect(wavDurationSeconds(encodeWav(new Int16Array(0), 16000))).toBe(0);
  });

  it("mergeWavs groups by sample rate, keeps order within a rate and orders outputs by first appearance", () => {
    const a = encodeWav(Int16Array.of(1, 2), 24000);
    const b = encodeWav(Int16Array.of(10), 16000);
    const c = encodeWav(Int16Array.of(3, 4, 5), 24000);
    const empty = encodeWav(new Int16Array(0), 8000);
    const d = encodeWav(Int16Array.of(11, 12), 16000);
    const merged = mergeWavs([a, b, empty, c, d]).map(decodeWav);
    expect(merged.map((m) => m.sampleRate)).toEqual([24000, 16000]);
    expect(Array.from(merged[0].samples)).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(merged[1].samples)).toEqual([10, 11, 12]);
    expect(mergeWavs([])).toEqual([]);
    expect(mergeWavs([empty])).toEqual([]);
  });
});

// ---------- loudness ----------

describe("normaliseLoudness", () => {
  const rate = 8000;

  it("brings quiet speech up toward the target RMS", () => {
    const quiet = speechLike(rate, 2, -38, { gaps: false });
    const out = normaliseLoudness(quiet, { targetDbfs: -20, peakDbfs: -3 });
    expect(20 * Math.log10(rms(out))).toBeCloseTo(-20, 0);
    expect(out).not.toBe(quiet); // a new array, input untouched
    expect(20 * Math.log10(rms(quiet))).toBeCloseTo(-38, 0);
  });

  it("brings loud speech down toward the target RMS", () => {
    const loud = speechLike(rate, 2, -8, { gaps: false });
    const out = normaliseLoudness(loud, { targetDbfs: -20 });
    expect(20 * Math.log10(rms(out))).toBeCloseTo(-20, 0);
  });

  it("never lets the peak exceed the ceiling (the ceiling wins over the RMS target)", () => {
    // A signal with a high crest factor: reaching -20 RMS would push the peak over -3.
    const spiky = new Float32Array(rate);
    for (let i = 0; i < spiky.length; i++) spiky[i] = i % 200 === 0 ? 0.5 : 0.0005;
    const out = normaliseLoudness(spiky, { targetDbfs: -20, peakDbfs: -3 });
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(20 * Math.log10(peak)).toBeLessThanOrEqual(-3 + 1e-6);
    expect(20 * Math.log10(rms(out))).toBeLessThan(-20); // couldn't reach the target without clipping
  });

  it("leaves near-silence and noise-only audio untouched (never amplifies it)", () => {
    for (const faint of [silence(rate, 1), noise(rate, 1, -55), noise(rate, 1, -48)]) {
      const out = normaliseLoudness(faint, { targetDbfs: -20, quietDbfs: -45 });
      expect(firstDifference(out, faint)).toBe(-1);
    }
    expect(normaliseLoudness(new Float32Array(0)).length).toBe(0);
  });

  it("caps amplification at maxGainDb", () => {
    const veryQuiet = speechLike(rate, 1, -44, { gaps: false });
    const out = normaliseLoudness(veryQuiet, { targetDbfs: -20, quietDbfs: -45, maxGainDb: 6 });
    // +6 dB from ~-44 lands near -38, well short of the -20 target.
    expect(20 * Math.log10(rms(out))).toBeLessThan(-34);
    expect(20 * Math.log10(rms(out))).toBeGreaterThan(-40);
  });
});

describe("normaliseWavLoudness (once per merged clone file)", () => {
  const rate = 8000;
  const dbOf = (x: ArrayLike<number>) => 20 * Math.log10(rms(Float32Array.from(x, (v) => v / 32768)));

  it("levels the whole file with one gain, so quieter and louder phrases keep their difference", () => {
    // A -28 dBFS phrase then a -44 dBFS phrase: per-chunk levelling used to pull both to -20 (a 16 dB → 0 dB jump, or
    // 25 dB steps when one chunk fell under the quiet gate). One gain keeps the 16 dB as recorded.
    const loud = speechLike(rate, 2, -28, { gaps: false });
    const soft = speechLike(rate, 2, -44, { gaps: false, seed: 5 });
    const out = decodeWav(normaliseWavLoudness(encodeWav(concat(loud, soft), rate)));
    expect(out.sampleRate).toBe(rate);
    const first = out.samples.subarray(0, loud.length);
    const second = out.samples.subarray(loud.length);
    expect(dbOf(first) - dbOf(second)).toBeCloseTo(16, 0);
    // The file as a whole is raised toward -20 dBFS RMS, as far as its loudest sample allows (-3 dBFS peak).
    expect(dbOf(out.samples)).toBeGreaterThan(dbOf(Float32Array.from(concat(loud, soft), (v) => v * 32768)) + 6);
    expect(dbOf(out.samples)).toBeLessThan(-19.5);
    let peak = 0;
    for (const v of out.samples) peak = Math.max(peak, Math.abs(v) / 32768);
    expect(20 * Math.log10(peak)).toBeLessThanOrEqual(-3 + 0.01);
  });

  it("leaves a near-silent file sample-exact (the quiet-audio guard), and keeps the rate", () => {
    const faint = encodeWav(Int16Array.from(noise(rate, 1, -55), (v) => Math.round(v * 32768)), rate);
    const out = normaliseWavLoudness(faint);
    expect(firstDifference(decodeWav(out).samples, decodeWav(faint).samples)).toBe(-1);
    const at16k = decodeWav(normaliseWavLoudness(encodeWav(speechLike(16000, 1, -30), 16000)));
    expect(at16k.sampleRate).toBe(16000);
  });
});

// ---------- resampling ----------

describe("resampleLinear", () => {
  it("is the identity (a copy) when the rates match", () => {
    const input = sine(16000, 0.1, -20);
    const out = resampleLinear(input, 16000, 16000);
    expect(out).not.toBe(input);
    expect(firstDifference(out, input)).toBe(-1);
  });

  it("scales length by the rate ratio", () => {
    expect(Math.abs(resampleLinear(new Float32Array(48001), 48000, 24000).length - 24000)).toBeLessThanOrEqual(1);
    expect(resampleLinear(new Float32Array(48000), 48000, 24000).length).toBe(24000);
    expect(resampleLinear(new Float32Array(8000), 8000, 24000).length).toBe(24000);
    expect(resampleLinear(new Float32Array(0), 8000, 24000).length).toBe(0);
  });

  it("keeps a low tone's level when downsampling and interpolates smoothly when upsampling", () => {
    const tone = sine(48000, 1, -20, 200);
    const down = resampleLinear(tone, 48000, 8000);
    expect(rms(down) / rms(tone)).toBeGreaterThan(0.95);
    expect(rms(down) / rms(tone)).toBeLessThan(1.05);
    const up = resampleLinear(sine(8000, 1, -20, 200), 8000, 24000);
    const reference = sine(24000, 1, -20, 200);
    let maxErr = 0;
    for (let i = 0; i < up.length - 3; i++) maxErr = Math.max(maxErr, Math.abs(up[i] - reference[i]));
    expect(maxErr).toBeLessThan(0.01);
  });

  it("box pre-filter attenuates content above the new Nyquist when downsampling ≥2×", () => {
    const high = sine(48000, 1, -20, 20000);
    expect(rms(resampleLinear(high, 48000, 8000)) / rms(high)).toBeLessThan(0.35);
  });

  it("rejects invalid rates", () => {
    expect(() => resampleLinear(new Float32Array(4), 0, 8000)).toThrow();
    expect(() => resampleLinear(new Float32Array(4), 8000, Number.NaN)).toThrow();
  });
});

// ---------- VAD ----------

/** The phone path: µ-law encoded, decoded in 20 ms Twilio packets, counted, flushed at the end of the stream. */
function viaPhone(signal: Float32Array): { counter: SpeechCounter; kept: Float32Array } {
  const mulaw = encodeMulaw(float32ToPcm16(signal));
  const counter = new SpeechCounter({ sampleRate: 8000 });
  const kept: Float32Array[] = [];
  for (let offset = 0; offset < mulaw.length; offset += 160) kept.push(counter.push(decodeMulaw(mulaw.subarray(offset, offset + 160))).kept);
  kept.push(counter.flush().kept);
  return { counter, kept: concat(...kept) };
}

/** µ-law round trip as floats (what the bridge's VAD sees). */
function muLaw(signal: Float32Array): Float32Array {
  return pcm16ToFloat32(decodeMulaw(encodeMulaw(float32ToPcm16(signal))));
}

/** Utterances of `seconds` separated by `pause` seconds of silence, with a lead-in and a trailing pause. */
function talk(rate: number, n: number, seconds: number, pause: number, dbfs: number): Float32Array {
  const parts: Float32Array[] = [silence(rate, 0.5)];
  for (let i = 0; i < n; i++) parts.push(speechLike(rate, seconds, dbfs, { gaps: false, seed: i + 3, f0: 140 + (i % 3) * 15 }), silence(rate, pause));
  return concat(...parts);
}

describe("frameStats / isCleanSpeechFrame", () => {
  it("digital silence has dbfs = -Infinity and is not speech", () => {
    const stats = frameStats(new Float32Array(240));
    expect(stats).toEqual({ rms: 0, dbfs: -Infinity, peak: 0, clippedFraction: 0 });
    expect(isCleanSpeechFrame(stats)).toBe(false);
    expect(frameStats(new Float32Array(0)).dbfs).toBe(-Infinity);
  });

  it("measures a -20 dBFS sine as above the static threshold and clean", () => {
    const stats = frameStats(sine(8000, 0.03, -20));
    expect(stats.dbfs).toBeCloseTo(-20, 1);
    expect(stats.peak).toBeCloseTo(Math.SQRT2 * 0.1, 2);
    expect(stats.clippedFraction).toBe(0);
    expect(isCleanSpeechFrame(stats)).toBe(true);
    expect(isCleanSpeechFrame(stats, { thresholdDbfs: -10 })).toBe(false);
  });

  it("a full-scale square wave is loud but clipped, so not clean", () => {
    const stats = frameStats(square(8000, 0.03));
    expect(stats.dbfs).toBeCloseTo(0, 6);
    expect(stats.clippedFraction).toBe(1);
    expect(isCleanSpeechFrame(stats)).toBe(false);
    expect(isCleanSpeechFrame(stats, { maxClippedFraction: 1 })).toBe(true);
  });

  it("detects clipping on the phone path, where µ-law decodes to at most 0.9803 (never 0.99)", () => {
    const decoded = muLaw(square(8000, 0.03));
    const stats = frameStats(decoded);
    expect(stats.peak).toBeCloseTo(32124 / 32768, 6);
    expect(stats.peak).toBeLessThan(0.99);
    expect(stats.clippedFraction).toBe(1);
    expect(isCleanSpeechFrame(stats)).toBe(false);
    // Loud but unclipped µ-law speech is not clipped.
    expect(frameStats(muLaw(speechLike(8000, 0.03, -12, { gaps: false }))).clippedFraction).toBeLessThanOrEqual(DEFAULT_VAD.maxClippedFraction);
  });

  it("has the documented defaults", () => {
    expect(DEFAULT_VAD).toEqual({
      frameMs: 30,
      thresholdDbfs: -40,
      minThresholdDbfs: -40,
      noiseMarginDb: 8,
      relativeLevelDb: 18,
      minRunFrames: 3,
      hangoverFrames: 8,
      prerollFrames: 3,
      maxGapFrames: 10,
      minPeriodicity: 0.35,
      minTonalFlatness: 0,
      clipLevel: 0.97,
      maxClippedFraction: 0.01,
    });
    // Re-counting kept audio (the sample route) never bridges two utterances: the seam is hangover + pre-roll.
    expect(DEFAULT_VAD.maxGapFrames).toBeLessThan(DEFAULT_VAD.hangoverFrames + DEFAULT_VAD.prerollFrames);
  });
});

describe("tonalFlatness / periodicity / dtmfScore", () => {
  it("tonalFlatness is ~0 for a pure sinusoid and high for harmonic speech and noise, at any rate", () => {
    expect(tonalFlatness(sine(8000, 0.03, -20, 425))).toBeLessThan(1e-6);
    expect(tonalFlatness(noise(8000, 0.03, -20))).toBeGreaterThan(0.5);
    for (const rate of [8000, 24000, 48000]) {
      const lag = Math.max(1, Math.round(rate / 8000));
      expect(tonalFlatness(sine(rate, 0.03, -20, 425), lag)).toBeLessThan(1e-6);
    }
  });

  it("periodicity is high for voiced speech and low for noise of any colour (60 ms windows)", () => {
    const windows = (x: Float32Array) => Array.from({ length: Math.floor(x.length / 240) - 1 }, (_, i) => x.subarray(i * 240, i * 240 + 480));
    const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
    const speech = windows(muLaw(speechLike(8000, 1, -20, { gaps: false })));
    expect(median(speech.map((w) => periodicity(w, 8000)))).toBeGreaterThan(0.6);
    expect(median(speech.map((w) => periodicity(w, 8000, true)))).toBeGreaterThan(0.6);
    for (const n of [noise(8000, 2, -30), lowPassNoise(8000, 2, -30, 0.9), lowPassNoise(8000, 2, -30, 0.99)]) {
      const ws = windows(muLaw(n));
      // Full band: never near a voice. Below 1 kHz a frame of low-passed noise can look pitched, but hardly ever
      // together with the full band (the counter needs both, and several such frames close together).
      expect(Math.max(...ws.map((w) => periodicity(w, 8000)))).toBeLessThan(0.35);
      const both = ws.filter((w) => periodicity(w, 8000) >= 0.2 && periodicity(w, 8000, true) >= DEFAULT_VAD.minPeriodicity);
      expect(both.length / ws.length).toBeLessThan(0.05);
    }
    expect(periodicity(new Float32Array(480), 8000)).toBe(0);
    // A plate's or glass's ringing (narrow-band, ~2.5 kHz) is pitched across the full band but not below 1 kHz.
    const ring = windows(muLaw(bandPassNoise(8000, 1, -26, 2500, 0.97)));
    expect(median(ring.map((w) => periodicity(w, 8000, true)))).toBeLessThan(DEFAULT_VAD.minPeriodicity);
  });

  it("dtmfScore is ≈ 1 for every key, even under -36 dBFS noise, and low for speech", () => {
    for (const [row, col] of DTMF_KEYS) {
      expect(dtmfScore(mix(tones(8000, 0.03, -21, row, col), noise(8000, 0.03, -36, row)), 8000)).toBeGreaterThan(0.85);
    }
    const speech = muLaw(speechLike(8000, 2, -20));
    let worst = 0;
    for (let i = 0; i + 240 <= speech.length; i += 240) worst = Math.max(worst, dtmfScore(speech.subarray(i, i + 240), 8000));
    expect(worst).toBeLessThan(0.7);
    expect(dtmfScore(new Float32Array(240), 8000)).toBe(0);
  });
});

describe.each([8000, 24000])("SpeechCounter at %i Hz", (rate) => {
  const frame = Math.round((rate * 30) / 1000);
  const frameSeconds = frame / rate;
  /** Exactly n frames, in seconds. */
  const frames = (n: number) => (n * frame) / rate;
  /** n frames of continuous, loud, voiced speech-like audio (loud but below the clipping ceiling). */
  const voiced = (n: number) => speechLike(rate, frames(n), -16, { gaps: false });

  it("uses round(sampleRate × frameMs / 1000) samples per frame", () => {
    const counter = new SpeechCounter({ sampleRate: rate });
    expect(counter.frameSamples).toBe(frame);
    expect(counter.frameSeconds).toBe(frameSeconds);
  });

  it("counts 0 s in 5 s of digital silence", () => {
    const { counter, result } = count(silence(rate, 5), rate);
    expect(counter.speechSeconds).toBe(0);
    expect(result.kept.length).toBe(0);
    expect(result.frames).toBe(Math.floor((5 * rate) / frame));
    expect(counter.totalSeconds).toBeCloseTo(result.frames * frameSeconds, 9);
  });

  it("counts 0 s in noise, quiet or loud (-55, -45 and -25 dBFS)", () => {
    for (const db of [-55, -45, -25]) {
      const { counter, result } = count(noise(rate, 5, db, 11), rate);
      expect(counter.speechSeconds, `${db} dBFS`).toBe(0);
      expect(result.kept.length, `${db} dBFS`).toBe(0);
    }
  });

  it("counts 0 s for a pure 425 Hz ringback-like tone (never mistaken for speech)", () => {
    const { counter } = count(concat(silence(rate, 0.5), sine(rate, 3, -18, 425), silence(rate, 0.5)), rate);
    expect(counter.speechSeconds).toBe(0);
  });

  it("counts 0 s for periodic clicks", () => {
    const { counter } = count(clicks(rate, 5), rate);
    expect(counter.speechSeconds).toBe(0);
  });

  it("counts a speech-like signal as >= 85% of its voiced time at -24 and -32 dBFS, with and without -50 dBFS noise", () => {
    const seconds = 4;
    const voicedSeconds = 0.75 * seconds; // speechLike's default 150 ms gaps every 0.6 s are silent
    for (const db of [-24, -32]) {
      for (const n of [null, -50] as (number | null)[]) {
        const signal = n === null ? speechLike(rate, seconds, db) : withNoise(speechLike(rate, seconds, db), n);
        const { counter } = count(signal, rate);
        const label = `${db} dBFS ${n === null ? "clean" : `+ ${n} dBFS noise`}`;
        expect(counter.speechSeconds, label).toBeGreaterThanOrEqual(0.85 * voicedSeconds);
        // The 150 ms gaps inside the utterance are counted (speaking time), but never more than the signal itself.
        expect(counter.speechSeconds, label).toBeLessThanOrEqual(seconds + frameSeconds);
      }
    }
  });

  it("at -40 dBFS counts only what clears the static -40 dBFS threshold: something, but never more than at -32", () => {
    const quiet = count(withNoise(speechLike(rate, 4, -40), -50), rate).counter.speechSeconds;
    const louder = count(withNoise(speechLike(rate, 4, -32), -50), rate).counter.speechSeconds;
    expect(quiet).toBeGreaterThan(0);
    expect(quiet).toBeLessThan(louder);
  });

  it("does not count a long pause (> 300 ms) between utterances", () => {
    const signal = concat(voiced(40), silence(rate, 0.6), voiced(40), silence(rate, 0.1)); // two ~1.2 s utterances, 0.6 s pause
    const { counter } = count(signal, rate);
    const spoken = 2 * frames(40);
    expect(counter.speechSeconds).toBeGreaterThanOrEqual(0.85 * spoken);
    // The 0.6 s pause is never counted (at most the next pre-roll is): the total stays well under spoken + the pause.
    expect(counter.speechSeconds).toBeLessThanOrEqual(spoken + frames(DEFAULT_VAD.prerollFrames) + 1e-9);
  });

  it("keeps and counts word onsets via pre-roll", () => {
    const lead = noise(rate, frames(4), -47); // 4 quiet frames, below the threshold
    const body = voiced(6);
    const { result } = count(concat(lead, body, silence(rate, frames(1))), rate);
    // 6 voiced frames + prerollFrames of lead are counted and kept; the kept audio starts with the lead's last 3 frames.
    expect(result.speechFrames).toBe(6 + DEFAULT_VAD.prerollFrames);
    expect(result.kept.length).toBe((6 + DEFAULT_VAD.prerollFrames) * frame);
    expect(firstDifference(result.kept.subarray(0, DEFAULT_VAD.prerollFrames * frame), lead.subarray(frame))).toBe(-1);
  });

  it("gives the same totals for many odd-sized pushes as for one push", () => {
    const signal = concat(noise(rate, 0.4, -55), voiced(44), silence(rate, 0.7), voiced(30), silence(rate, 1));
    const { counter: whole, result } = count(signal, rate);

    const chunked = new SpeechCounter({ sampleRate: rate });
    const sizes = [37, 160, 1001];
    const kept: Float32Array[] = [];
    let pushedSeconds = 0;
    for (let offset = 0, n = 0; offset < signal.length; n++) {
      const size = sizes[n % sizes.length];
      const r = chunked.push(signal.subarray(offset, offset + size));
      kept.push(r.kept);
      pushedSeconds += r.speechSeconds;
      offset += size;
    }
    const tail = chunked.flush();
    kept.push(tail.kept);
    pushedSeconds += tail.speechSeconds;

    expect(whole.speechSeconds).toBeGreaterThan(2);
    expect(chunked.speechSeconds).toBe(whole.speechSeconds);
    expect(chunked.totalSeconds).toBe(whole.totalSeconds);
    expect(pushedSeconds).toBeCloseTo(whole.speechSeconds, 9);
    expect(firstDifference(concat(...kept), result.kept)).toBe(-1);
  });

  it("treats Int16 input the same as the equivalent float input", () => {
    const pcm = float32ToPcm16(concat(voiced(50), silence(rate, 0.5), voiced(14), silence(rate, 0.5)));
    const fromInt = count(pcm, rate);
    const fromFloat = count(pcm16ToFloat32(pcm), rate);
    expect(fromInt.counter.speechSeconds).toBeGreaterThan(1.4);
    expect(fromInt.counter.speechSeconds).toBe(fromFloat.counter.speechSeconds);
    expect(firstDifference(fromInt.result.kept, fromFloat.result.kept)).toBe(-1);
  });

  it("flush judges a run still in progress as a whole: counted if it confirms, dropped if it doesn't", () => {
    const counter = new SpeechCounter({ sampleRate: rate });
    expect(counter.push(voiced(2)).speechFrames).toBe(0); // 2 < minRunFrames: pending
    expect(counter.flush()).toEqual({ frames: 0, speechFrames: 0, speechSeconds: 0, kept: new Float32Array(0) });
    // The flush forgot that run: one more frame doesn't complete it.
    expect(counter.push(voiced(1)).speechFrames).toBe(0);
    expect(counter.speechSeconds).toBe(0);
    expect(counter.totalSeconds).toBeCloseTo(3 * frameSeconds, 9);

    const fresh = new SpeechCounter({ sampleRate: rate });
    const run = voiced(4);
    expect(fresh.push(run).speechFrames).toBe(0); // still being judged (a tone could yet show itself)
    const tail = fresh.flush(); // the stream ends: judged whole, it confirms
    expect(tail.speechFrames).toBe(4);
    expect(firstDifference(tail.kept, run)).toBe(-1);
    expect(fresh.speechSeconds).toBeCloseTo(4 * frameSeconds, 9);
  });
});

describe("SpeechCounter semantics", () => {
  const rate = 8000;
  const frame = 240;
  const frameSeconds = frame / rate;
  /** Consecutive voiced frames of one continuous, loud speech-like stream. */
  const speechFrames = () => {
    const stream = speechLike(rate, 6, -16, { gaps: false });
    let next = 0;
    return () => stream.slice(next * frame, ++next * frame);
  };
  /** One silent frame. */
  const qf = () => silence(rate, frameSeconds);

  it("confirms a run once it is dense in speech (two frames behind while it goes on), then counts frame by frame", () => {
    const vf = speechFrames();
    const counter = new SpeechCounter({ sampleRate: rate });
    const first = counter.push(concat(vf(), vf(), vf(), vf()));
    expect(first).toMatchObject({ frames: 4, speechFrames: 0, speechSeconds: 0 });
    expect(first.kept.length).toBe(0);

    const fifth = counter.push(vf());
    expect(fifth.speechFrames).toBe(5); // no pre-roll on a fresh counter: the whole 5-frame run, counted retroactively
    expect(fifth.speechSeconds).toBeCloseTo(0.15, 12);
    expect(fifth.kept.length).toBe(5 * frame);

    const sixth = counter.push(vf());
    expect(sixth.speechFrames).toBe(1);
    expect(sixth.kept.length).toBe(frame);
    expect(counter.speechSeconds).toBeCloseTo(0.18, 12);
  });

  it("judges a run whole when it ends", () => {
    const vf = speechFrames();
    const counter = new SpeechCounter({ sampleRate: rate });
    expect(counter.push(concat(vf(), vf(), vf())).speechFrames).toBe(0);
    const end = counter.push(qf());
    expect(end.speechFrames).toBe(3);
    expect(end.kept.length).toBe(3 * frame);
  });

  it("keeps up to hangoverFrames unvoiced frames when an utterance ends, without counting them", () => {
    const vf = speechFrames();
    const counter = new SpeechCounter({ sampleRate: rate });
    counter.push(concat(vf(), vf(), vf()));
    const tail = counter.push(silence(rate, frameSeconds * 15)); // 15 quiet frames: the utterance ends
    expect(tail.speechFrames).toBe(3); // the run, judged whole at the first quiet frame
    expect(tail.kept.length).toBe((3 + DEFAULT_VAD.hangoverFrames) * frame);
    expect(counter.speechSeconds).toBeCloseTo(0.09, 12);
  });

  it("counts short gaps inside a confirmed utterance once a confirmed run resumes it", () => {
    const vf = speechFrames();
    const counter = new SpeechCounter({ sampleRate: rate });
    // 3 voiced (confirm) + 5 quiet (gap <= maxGapFrames, held) + 3 voiced (resume → the held gap is counted too) + 1 quiet.
    const result = counter.push(concat(vf(), vf(), vf(), qf(), qf(), qf(), qf(), qf(), vf(), vf(), vf(), qf()));
    expect(result.speechFrames).toBe(11); // 3 + 5 gap + 3
    expect(result.kept.length).toBe(11 * frame);
  });

  it("honours custom options (minRunFrames 1, no pre-roll, no gap, no hangover)", () => {
    const vf = speechFrames();
    const counter = new SpeechCounter({ sampleRate: rate, minRunFrames: 1, hangoverFrames: 0, prerollFrames: 0, maxGapFrames: 0 });
    const result = counter.push(concat(vf(), qf(), vf(), qf(), qf()));
    expect(result.speechFrames).toBe(2);
    expect(result.kept.length).toBe(2 * frame);
  });

  it("computes seconds from the real frame length (frameSamples / sampleRate)", () => {
    const counter = new SpeechCounter({ sampleRate: 22050 }); // 30 ms → 661.5 → 662 samples
    expect(counter.frameSamples).toBe(662);
    const whole = speechLike(22050, 1, -16, { gaps: false });
    counter.push(whole);
    const totalFrames = Math.floor(whole.length / 662);
    expect(counter.totalSeconds).toBeCloseTo((totalFrames * 662) / 22050, 12);
    expect(counter.speechSeconds).toBeGreaterThanOrEqual(0.8 * counter.totalSeconds);
    expect(counter.speechSeconds).toBeLessThanOrEqual(counter.totalSeconds);
  });

  it("reset clears totals and buffered state", () => {
    const vf = speechFrames();
    const counter = new SpeechCounter({ sampleRate: rate });
    counter.push(concat(vf(), vf(), vf(), vf(), vf(), vf()));
    expect(counter.speechSeconds).toBeGreaterThan(0);
    counter.reset();
    expect(counter.speechSeconds).toBe(0);
    expect(counter.totalSeconds).toBe(0);
  });

  it("never relaxes the threshold below the static -40 dBFS, and raises it above loud steady noise", () => {
    const counter = new SpeechCounter({ sampleRate: rate });
    expect(counter.thresholdDbfs).toBe(-40);
    counter.push(silence(rate, 2)); // silence pulls the noise floor down…
    expect(counter.noiseFloorDbfs).toBeLessThan(-60);
    expect(counter.thresholdDbfs).toBe(-40); // …but never the threshold
    counter.push(noise(rate, 5, -25, 3)); // a sustained level becomes the floor
    expect(counter.noiseFloorDbfs).toBeGreaterThan(-28);
    expect(counter.thresholdDbfs).toBeGreaterThan(-25);
  });

  it("rejects invalid options", () => {
    expect(() => new SpeechCounter({ sampleRate: 0 })).toThrow(/sample rate/);
    expect(() => new SpeechCounter({ sampleRate: 8000, frameMs: 0.01 })).toThrow(/frameMs/);
  });

  it("end-to-end phone path: µ-law speech decoded in 20 ms Twilio chunks counts ≈ its speaking time", () => {
    const { counter, kept } = viaPhone(concat(silence(rate, 1), speechLike(rate, 3, -20, { gaps: false }), silence(rate, 1)));
    expect(Math.abs(counter.speechSeconds - 3)).toBeLessThanOrEqual(0.3);
    // kept = counted speech (pre-roll included) + hangover frames at the single utterance's end.
    expect(kept.length).toBe(Math.round(counter.speechSeconds / counter.frameSeconds + DEFAULT_VAD.hangoverFrames) * frame);
  });

  it("counts realistic phrases at about their voiced time (pre-roll and short pauses only)", () => {
    for (const [seconds, pause] of [
      [1, 0.5],
      [0.5, 0.4],
    ]) {
      const { counter } = viaPhone(talk(rate, 12, seconds, pause, -20));
      const voicedSeconds = 12 * seconds;
      expect(counter.speechSeconds, `${seconds} s / ${pause} s`).toBeGreaterThanOrEqual(0.9 * voicedSeconds);
      // At most each utterance's pre-roll and the two frames its edges fall in.
      const most = voicedSeconds + 12 * (DEFAULT_VAD.prerollFrames + 2) * frameSeconds;
      expect(counter.speechSeconds, `${seconds} s / ${pause} s`).toBeLessThanOrEqual(most);
    }
  });
});

/**
 * Regression tests from the review of the adaptive VAD: a cloned voice must only ever be the consenting account
 * holder's, so none of this may count (well under 1 s per 20 s), whatever came before it. Counts are compared with the
 * customer's voiced time, never with wall time. Every case runs through the phone path (µ-law, 20 ms packets).
 */
describe("SpeechCounter never counts non-customer audio", () => {
  const rate = 8000;
  const NEAR_ZERO = 0.1; // seconds per 20 s
  const phone = (signal: Float32Array) => viaPhone(signal).counter.speechSeconds;

  describe("noise and background (F1)", () => {
    it("noise after a quiet start, a dropout or digital silence: silence → -42/-45/-48 dBFS, -60 → -46 dBFS step", () => {
      for (const db of [-42, -45, -48]) {
        expect(phone(concat(noise(rate, 1, -70, 5), noise(rate, 20, db, 7))), `${db} dBFS`).toBeLessThanOrEqual(NEAR_ZERO);
      }
      expect(phone(concat(silence(rate, 1), noise(rate, 20, -45, 7)))).toBeLessThanOrEqual(NEAR_ZERO);
      expect(phone(concat(silence(rate, 0.06), noise(rate, 20, -45, 7)))).toBeLessThanOrEqual(NEAR_ZERO);
      expect(phone(concat(noise(rate, 5, -45, 7), silence(rate, 0.2), noise(rate, 15, -45, 8)))).toBeLessThanOrEqual(NEAR_ZERO);
      expect(phone(concat(noise(rate, 3, -60, 5), noise(rate, 20, -46, 7)))).toBeLessThanOrEqual(NEAR_ZERO);
    });

    it("steady or slowly rising noise at any level: fan, car, traffic, loud white noise with dropouts", () => {
      for (const db of [-45, -28]) {
        for (const pole of [0.5, 0.9, 0.95, 0.99]) {
          expect(phone(concat(silence(rate, 1), lowPassNoise(rate, 20, db, pole))), `pole ${pole} at ${db} dBFS`).toBeLessThanOrEqual(NEAR_ZERO);
        }
      }
      expect(phone(concat(noise(rate, 5, -25, 4), silence(rate, 0.2), noise(rate, 15, -25, 6)))).toBeLessThanOrEqual(NEAR_ZERO);
      const rising = noise(rate, 20, 0, 10);
      for (let i = 0; i < rising.length; i++) rising[i] *= 10 ** ((-50 + (25 * i) / rising.length) / 20); // -50 → -25 dBFS
      expect(phone(rising)).toBeLessThanOrEqual(NEAR_ZERO);
    });

    it("a sustained pitched sound (hum, engine, whine) counts at most its first moments, even when it stops and starts", () => {
      for (const f0 of [66, 100, 180]) expect(phone(concat(silence(rate, 1), hum(rate, 20, -30, f0))), `hum ${f0} Hz`).toBeLessThan(0.5);
      for (const [hz, r] of [
        [300, 0.98],
        [1000, 0.99],
        [2000, 0.97],
      ]) {
        expect(phone(concat(silence(rate, 1), bandPassNoise(rate, 20, -30, hz, r))), `whine ${hz} Hz`).toBeLessThan(0.5);
      }
      expect(phone(cadence(rate, 1.5, 0.5, 10, (s) => hum(rate, s, -30, 100)))).toBeLessThan(0.5);
    });

    it("3 s of speech then 20 s of -44 dBFS noise counts just the speech", () => {
      const speech = phone(concat(silence(rate, 1), speechLike(rate, 3, -20), silence(rate, 1)));
      const withNoise = phone(concat(silence(rate, 1), speechLike(rate, 3, -20), silence(rate, 1), noise(rate, 20, -44, 9)));
      expect(speech).toBeGreaterThan(2);
      expect(withNoise).toBeCloseTo(speech, 6);
    });

    it("another person or a TV at -44/-46/-48 dBFS, after silence or from the start, counts nothing", () => {
      for (const db of [-44, -46, -48]) {
        expect(phone(concat(silence(rate, 1), speechLike(rate, 20, db))), `${db} dBFS after silence`).toBe(0);
        expect(phone(speechLike(rate, 20, db, { seed: 9, f0: 210 })), `${db} dBFS from t=0`).toBe(0);
      }
    });

    it("a -47 dBFS TV under the customer's speech adds nothing: 15 s of speech in a 60 s call", () => {
      const parts: Float32Array[] = [];
      for (let i = 0; i < 10; i++) parts.push(speechLike(rate, 1.5, -22, { seed: i + 1, f0: 140 }), silence(rate, 4.5));
      const customer = concat(...parts);
      const tv = speechLike(rate, customer.length / rate, -47, { seed: 99, f0: 220 });
      const alone = phone(customer);
      const withTv = phone(mix(customer, tv));
      expect(alone).toBeGreaterThanOrEqual(0.9 * 15);
      expect(alone).toBeLessThanOrEqual(15 + 10 * (DEFAULT_VAD.prerollFrames + 1) * 0.03);
      expect(Math.abs(withTv - alone)).toBeLessThanOrEqual(0.1);
    });

    it("a talker 18+ dB below the customer's speech is never counted, even above -40 dBFS", () => {
      const customer = phone(concat(speechLike(rate, 3, -16, { gaps: false }), silence(rate, 0.5)));
      const withEcho = phone(concat(speechLike(rate, 3, -16, { gaps: false }), silence(rate, 0.5), speechLike(rate, 6, -37, { seed: 7, f0: 230 })));
      expect(withEcho).toBeCloseTo(customer, 6);
    });
  });

  describe("impulse trains (F2)", () => {
    it("50 and 100 ms bursts every 200–400 ms, decaying impacts, typing and clatter count nothing", () => {
      const trains = [
        bursts(rate, 20, { width: 0.05, minGap: 0.2, maxGap: 0.4, dbfs: -28, seed: 77 }),
        bursts(rate, 20, { width: 0.1, minGap: 0.2, maxGap: 0.4, dbfs: -28, seed: 78 }),
        bursts(rate, 20, { width: 0.12, minGap: 0.2, maxGap: 0.45, dbfs: -22, decay: 0.02, seed: 5 }),
        bursts(rate, 20, { width: 0.25, minGap: 0.25, maxGap: 0.5, dbfs: -20, decay: 0.05, seed: 6 }),
        bursts(rate, 20, { width: 0.04, minGap: 0.08, maxGap: 0.2, dbfs: -28, seed: 7 }),
      ];
      for (const [i, train] of trains.entries()) expect(phone(concat(silence(rate, 1), train)), `train ${i}`).toBe(0);
    });

    it("bursts right after speech don't chain onto the utterance: the count stays the speech's", () => {
      const lead = concat(silence(rate, 1), speechLike(rate, 1, -20, { gaps: false }));
      const speech = phone(concat(lead, silence(rate, 1)));
      const train = bursts(rate, 20, { width: 0.05, minGap: 0.2, maxGap: 0.4, dbfs: -28, seed: 77 });
      expect(phone(concat(lead, train))).toBeCloseTo(speech, 6);
    });
  });

  describe("tones (F6)", () => {
    it("DTMF key presses count nothing: 100 ms keys, and fast 50 ms keys under -36 dBFS noise", () => {
      const keys = (n: number, on: number, off: number) => {
        const parts: Float32Array[] = [silence(rate, 0.5)];
        for (let i = 0; i < n; i++) parts.push(tones(rate, on, -21, ...DTMF_KEYS[(i * 5) % 16]), silence(rate, off));
        return concat(...parts);
      };
      expect(phone(keys(16, 0.1, 0.1))).toBe(0);
      const fast = keys(100, 0.05, 0.05);
      expect(phone(mix(fast, noise(rate, fast.length / rate, -36, 24)))).toBe(0);
    });

    it("tones under noise count nothing: 425 Hz at 22/18/15/12 dB SNR, and beeps", () => {
      for (const snr of [22, 18, 15, 12]) {
        expect(phone(concat(silence(rate, 0.5), mix(sine(rate, 5, -18, 425), noise(rate, 5, -18 - snr, 3)))), `${snr} dB SNR`).toBe(0);
      }
      const beeps = cadence(rate, 0.15, 0.2, 40, (s) => sine(rate, s, -20, 2000));
      expect(phone(mix(beeps, noise(rate, beeps.length / rate, -45, 21)))).toBe(0);
    });

    it("call-progress tones count nothing, clean or under noise (US/UK ringback, busy)", () => {
      const ring = cadence(rate, 2, 4, 3, (s) => tones(rate, s, -21, 440, 480));
      expect(phone(ring)).toBe(0);
      expect(phone(mix(ring, noise(rate, ring.length / rate, -36, 18)))).toBe(0);
      const ukRing = cadence(rate, 1, 2, 5, () => join(tones(rate, 0.4, -21, 400, 450), silence(rate, 0.2), tones(rate, 0.4, -21, 400, 450)));
      expect(phone(mix(ukRing, noise(rate, ukRing.length / rate, -36, 17)))).toBe(0);
      const busy = cadence(rate, 0.5, 0.5, 10, (s) => tones(rate, s, -21, 480, 620));
      expect(phone(mix(busy, noise(rate, busy.length / rate, -36, 19)))).toBe(0);
    });
  });

  describe("clipping (F5)", () => {
    it("clipped µ-law audio is never counted or kept", () => {
      const { counter, kept } = viaPhone(concat(silence(rate, 0.5), square(rate, 5)));
      expect(counter.speechSeconds).toBe(0);
      expect(kept.length).toBe(0);
      const shouting = speechLike(rate, 10, 0, { gaps: false }).map((v) => Math.max(-1, Math.min(1, 4 * v)));
      expect(phone(shouting)).toBe(0);
    });

    it("a clipped frame inside an utterance is never counted or kept, not even as part of a pause", () => {
      const speech = speechLike(rate, 2, -20, { gaps: false });
      // A 30 ms clipped burst in the middle of a word, frame-aligned (the bridge sees 30 ms frames from the start).
      const { counter, kept } = viaPhone(concat(speech.subarray(0, 7920), square(rate, 0.03), speech.subarray(7920), silence(rate, 0.5)));
      for (let i = 0; i < kept.length; i += 240) {
        // No kept frame has more than a stray sample at the µ-law ceiling (0.9803).
        const atCeiling = kept.subarray(i, i + 240).filter((v) => Math.abs(v) >= 0.97).length;
        expect(atCeiling, `kept frame ${i / 240}`).toBeLessThanOrEqual(2);
      }
      expect(kept.length / 8000).toBeLessThanOrEqual(2 + (2 * DEFAULT_VAD.prerollFrames + DEFAULT_VAD.hangoverFrames) * 0.03);
      expect(counter.speechSeconds).toBeLessThanOrEqual(2 + 2 * DEFAULT_VAD.prerollFrames * 0.03);
      expect(counter.speechSeconds).toBeGreaterThan(1.6);
    });
  });

  describe("pre-roll (F7)", () => {
    const frame = 240;
    /** Which of `source` frames each kept frame is (-1 if none). */
    const whichFrames = (kept: Float32Array, source: Float32Array[]) => {
      const out: number[] = [];
      for (let i = 0; i < kept.length / frame; i++) {
        const keptFrame = kept.subarray(i * frame, (i + 1) * frame);
        out.push(source.findIndex((f) => firstDifference(f, keptFrame) === -1));
      }
      return out;
    };

    it("a run too short to count becomes pre-roll in order, so the kept onset is contiguous", () => {
      const speech = speechLike(rate, 0.3, -16, { gaps: false });
      const v = (i: number) => speech.slice(i * frame, (i + 1) * frame);
      const q = (seed: number) => noise(rate, 0.03, -56, seed);
      // q1 q2 q3 v8 v9 q4 v10 v11 v12 q5
      const source = [q(1), q(2), q(3), v(0), v(1), q(4), v(3), v(4), v(5), q(5)];
      const counter = new SpeechCounter({ sampleRate: rate });
      const result = counter.push(concat(...source));
      expect(whichFrames(result.kept, source)).toEqual([3, 4, 5, 6, 7, 8]); // v8 v9 q4 v10 v11 v12
      expect(result.speechFrames).toBe(6);
    });

    it("after a pause longer than maxGapFrames, the onset's pre-roll is the end of that pause", () => {
      const speech = speechLike(rate, 0.6, -16, { gaps: false });
      const v = (i: number) => speech.slice(i * frame, (i + 1) * frame);
      const pause = Array.from({ length: DEFAULT_VAD.maxGapFrames + 1 }, (_, i) => noise(rate, 0.03, -56, 100 + i));
      const source = [v(0), v(1), v(2), v(3), ...pause, v(10), v(11), v(12), noise(rate, 0.03, -56, 99)];
      const counter = new SpeechCounter({ sampleRate: rate });
      const result = counter.push(concat(...source));
      const ids = whichFrames(result.kept, source);
      // Every frame from the first word to the second is kept, in order: hangover then pre-roll, no splice.
      expect(ids).toEqual(Array.from({ length: 4 + pause.length + 3 }, (_, i) => i));
      // Counted: the first word, the pre-roll and the second word; never the hangover.
      expect(result.speechFrames).toBe(4 + DEFAULT_VAD.prerollFrames + 3);
    });
  });
});
