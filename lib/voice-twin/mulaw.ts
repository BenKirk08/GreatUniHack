/**
 * ITU-T G.711 μ-law codec and PCM sample-format helpers for the AI Voice Twin.
 * Twilio Media Streams carry audio/x-mulaw, 8000 Hz, mono: one byte per sample.
 * Pure and environment-agnostic (typed arrays only) — shared by the Node media bridge and browser components.
 */

const BIAS = 0x84;
const CLIP = 32635;

/** μ-law byte → linear PCM16, built once at module load. */
const DECODE_TABLE: Int16Array = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
    table[i] = u & 0x80 ? -magnitude : magnitude;
  }
  return table;
})();

/** Decode G.711 μ-law bytes to linear PCM16 (one sample per byte). 0xFF/0x7F → 0, 0x80 → 32124, 0x00 → -32124. */
export function decodeMulaw(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = DECODE_TABLE[bytes[i]];
  return out;
}

function encodeSample(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  let s = Math.min(sign ? -sample : sample, CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  s = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | s) & 0xff;
}

/** Encode linear PCM16 to G.711 μ-law (bias 0x84, clip 32635). Used by tests and call simulations. */
export function encodeMulaw(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = encodeSample(samples[i]);
  return out;
}

/** PCM16 → float in [-1, 1) (÷32768). */
export function pcm16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768;
  return out;
}

/** Float → PCM16: clamp to [-1, 1], ×32767, round. NaN becomes 0. */
export function float32ToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    out[i] = Number.isNaN(v) ? 0 : Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  }
  return out;
}
