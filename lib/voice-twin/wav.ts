/**
 * Minimal RIFF/WAVE (16-bit PCM) codec, merging and resampling for the AI Voice Twin.
 * Pure and environment-agnostic: typed arrays and DataView only (no Buffer, no DOM).
 */
import { float32ToPcm16, pcm16ToFloat32 } from "./mulaw";

const HEADER_BYTES = 44;
const PCM_FORMAT = 1;
const EXTENSIBLE_FORMAT = 0xfffe;

/** A decoded WAV. `samples` are always mono; `channels` is the channel count of the source file. */
export interface DecodedWav {
  sampleRate: number;
  channels: number;
  samples: Int16Array;
}

interface WavLayout {
  sampleRate: number;
  channels: number;
  dataOffset: number;
  frameCount: number;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

function writeTag(view: DataView, offset: number, tag: string): void {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, tag.charCodeAt(i));
}

/** Walk the RIFF chunks, validate the fmt chunk and locate the PCM data. Throws on anything but 16-bit PCM. */
function parseWav(bytes: Uint8Array): WavLayout {
  if (bytes.length < 12) throw new Error("WAV: too short to be a RIFF/WAVE file");
  const view = viewOf(bytes);
  if (readTag(view, 0) !== "RIFF" || readTag(view, 8) !== "WAVE") throw new Error("WAV: not a RIFF/WAVE file");

  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let data: { offset: number; length: number } | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = readTag(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    const available = bytes.length - body;
    if (id === "fmt ") {
      if (size < 16 || size > available) throw new Error("WAV: truncated fmt chunk");
      let format = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format tag is the first two bytes of the sub-format GUID.
      if (format === EXTENSIBLE_FORMAT && size >= 40) format = view.getUint16(body + 24, true);
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      // Streaming writers sometimes leave the size unset or oversized: take what is actually there.
      data = { offset: body, length: Math.min(size, available) };
      if (fmt) break;
    }
    offset = body + size + (size & 1); // chunks are word-aligned: odd sizes carry a pad byte
  }

  if (!fmt) throw new Error("WAV: missing fmt chunk");
  if (fmt.format !== PCM_FORMAT) throw new Error(`WAV: unsupported format ${fmt.format} (only PCM format 1)`);
  if (fmt.bitsPerSample !== 16) throw new Error(`WAV: unsupported ${fmt.bitsPerSample}-bit samples (only 16-bit PCM)`);
  if (fmt.channels < 1) throw new Error("WAV: no audio channels");
  if (fmt.sampleRate < 1) throw new Error("WAV: invalid sample rate 0");
  if (!data) throw new Error("WAV: missing data chunk");
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    dataOffset: data.offset,
    frameCount: Math.floor(data.length / (fmt.channels * 2)),
  };
}

/** Encode mono samples as a 16-bit PCM WAV with the standard 44-byte header. Float input is clamped and scaled. */
export function encodeWav(samples: Int16Array | Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate < 1) throw new Error(`WAV: invalid sample rate ${sampleRate}`);
  const pcm = samples instanceof Float32Array ? float32ToPcm16(samples) : samples;
  const dataBytes = pcm.length * 2;
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = viewOf(bytes);
  writeTag(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeTag(view, 8, "WAVE");
  writeTag(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeTag(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(HEADER_BYTES + i * 2, pcm[i], true);
  return bytes;
}

/** Decode a 16-bit PCM WAV (unknown chunks skipped, multi-channel averaged to mono). Throws a descriptive Error otherwise. */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const { sampleRate, channels, dataOffset, frameCount } = parseWav(bytes);
  const view = viewOf(bytes);
  const samples = new Int16Array(frameCount);
  if (channels === 1) {
    for (let i = 0; i < frameCount; i++) samples[i] = view.getInt16(dataOffset + i * 2, true);
  } else {
    const blockAlign = channels * 2;
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += view.getInt16(dataOffset + i * blockAlign + c * 2, true);
      samples[i] = Math.round(sum / channels);
    }
  }
  return { sampleRate, channels, samples };
}

/** Duration of a 16-bit PCM WAV in seconds, read from its header (no sample decoding). */
export function wavDurationSeconds(bytes: Uint8Array): number {
  const { sampleRate, frameCount } = parseWav(bytes);
  return frameCount / sampleRate;
}

/**
 * Concatenate WAVs: one mono WAV per distinct sample rate, input order kept within each rate,
 * outputs ordered by first appearance. Inputs with no samples are skipped; empty input → [].
 */
export function mergeWavs(files: Uint8Array[]): Uint8Array[] {
  const groups = new Map<number, Int16Array[]>();
  for (const file of files) {
    const { sampleRate, samples } = decodeWav(file);
    if (samples.length === 0) continue;
    const group = groups.get(sampleRate);
    if (group) group.push(samples);
    else groups.set(sampleRate, [samples]);
  }
  const merged: Uint8Array[] = [];
  for (const [sampleRate, parts] of groups) {
    const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    merged.push(encodeWav(out, sampleRate));
  }
  return merged;
}

export interface LoudnessOptions {
  /** Aim for this RMS level (dBFS). ElevenLabs recommends roughly −23…−18 dB RMS. Default -20. */
  targetDbfs?: number;
  /** Never let the peak exceed this (dBFS). ElevenLabs recommends about −3 dB peak. Default -3. */
  peakDbfs?: number;
  /** Audio whose RMS is below this is left untouched: near-silence and noise-only chunks are never pumped up. Default -45. */
  quietDbfs?: number;
  /** Cap on amplification (dB); attenuation to respect the peak ceiling is never capped. Default 30. */
  maxGainDb?: number;
}

/**
 * Scale mono float samples toward `targetDbfs` RMS without the peak passing `peakDbfs`, for a cleaner, more consistent
 * AI Voice Twin clone (one speaker, even level, little noise). Pure — returns a new array, never mutates the input.
 * It applies one gain to everything it is given, so relative levels inside it are kept exactly. It never amplifies
 * near-silence or noise-only audio: audio quieter than `quietDbfs` RMS is returned unchanged, and amplification is
 * capped at `maxGainDb`. When the target would push the peak over the ceiling, the ceiling wins (so the gain only goes
 * as high as the loudest sample allows). Used once per merged clone file (normaliseWavLoudness), never per chunk.
 */
export function normaliseLoudness(samples: Float32Array, opts: LoudnessOptions = {}): Float32Array {
  const targetDbfs = opts.targetDbfs ?? -20;
  const peakDbfs = opts.peakDbfs ?? -3;
  const quietDbfs = opts.quietDbfs ?? -45;
  const maxGainDb = opts.maxGainDb ?? 30;
  const n = samples.length;
  if (n === 0) return new Float32Array(0);

  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    sumSquares += v * v;
    const abs = v < 0 ? -v : v;
    if (abs > peak) peak = abs;
  }
  const rms = Math.sqrt(sumSquares / n);
  const rmsDbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  // Near-silence or noise-only: leave it exactly as it is.
  if (rmsDbfs < quietDbfs) return samples.slice();

  const toTarget = 10 ** ((targetDbfs - rmsDbfs) / 20);
  const peakCeiling = peak > 0 ? 10 ** (peakDbfs / 20) / peak : Infinity;
  const maxGain = 10 ** (maxGainDb / 20);
  // Respect the peak ceiling first, then cap amplification (attenuation is never capped).
  let gain = Math.min(toTarget, peakCeiling);
  if (gain > maxGain) gain = maxGain;
  if (gain === 1) return samples.slice();

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = samples[i] * gain;
    out[i] = v < -1 ? -1 : v > 1 ? 1 : v;
  }
  return out;
}

/** Centred moving average of `width` samples (shrinks at the edges). */
function boxFilter(samples: Float32Array, width: number): Float32Array {
  const n = samples.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + samples[i];
  const before = Math.floor((width - 1) / 2);
  const after = width - 1 - before;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - before);
    const hi = Math.min(n, i + after + 1);
    out[i] = (prefix[hi] - prefix[lo]) / (hi - lo);
  }
  return out;
}

/**
 * Linear-interpolation resampler (returns a copy when the rates match). When downsampling by ≥2× a box
 * pre-filter of width round(fromRate/toRate) limits aliasing. Output length = round(length × toRate / fromRate).
 */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!(fromRate > 0 && toRate > 0 && Number.isFinite(fromRate) && Number.isFinite(toRate))) {
    throw new Error(`resampleLinear: invalid rates ${fromRate} → ${toRate}`);
  }
  if (fromRate === toRate) return samples.slice();
  const ratio = fromRate / toRate;
  const source = ratio >= 2 ? boxFilter(samples, Math.round(ratio)) : samples;
  const out = new Float32Array(Math.round((samples.length * toRate) / fromRate));
  const last = source.length - 1;
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.min(Math.floor(pos), last);
    const i1 = Math.min(i0 + 1, last);
    out[i] = source[i0] + (source[i1] - source[i0]) * (pos - Math.floor(pos));
  }
  return out;
}

/**
 * normaliseLoudness() over a whole 16-bit PCM WAV: decoded (to mono), levelled with one gain and re-encoded at its own
 * rate. The AI Voice Twin levels each merged clone file once this way, so the clone hears the customer's speech at one
 * consistent level, as it was recorded relative to itself. Audio left unchanged (near-silence) comes back sample-exact.
 */
export function normaliseWavLoudness(bytes: Uint8Array, opts: LoudnessOptions = {}): Uint8Array {
  const { sampleRate, samples } = decodeWav(bytes);
  const levelled = normaliseLoudness(pcm16ToFloat32(samples), opts);
  const out = new Int16Array(levelled.length);
  // ×32768 inverts pcm16ToFloat32 exactly, so a gain of 1 gives back the very same samples.
  for (let i = 0; i < levelled.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(levelled[i] * 32768)));
  return encodeWav(out, sampleRate);
}
