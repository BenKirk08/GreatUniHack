/**
 * Deterministic synthetic audio fixtures for the AI Voice Twin VAD/audio tests. Pure (typed arrays + Math only).
 *
 * The important one is speechLike(): a formant-shaped harmonic tone with syllable-rate amplitude modulation (and, by
 * default, short gaps), rich enough across the 300–3400 Hz telephone band that the VAD reads it as speech — unlike a
 * single pure sinusoid, which the VAD must reject as a tone. (The VAD itself is calibrated against real macOS `say`
 * speech: ≥ 85 % of speaking time at −24 dBFS on the phone path; see docs and tests.) The other generators build the
 * non-speech the VAD must never count: noise, tones, DTMF, impulses, clipping.
 */

/** mulberry32: a small, deterministic PRNG so fixtures are byte-for-byte reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RMS (linear, full-scale 1.0) of the non-zero ("active") samples, used to scale a fixture to a target level. */
function activeRms(x: Float32Array): number {
  let sum = 0;
  let n = 0;
  for (const v of x) {
    if (v !== 0) {
      sum += v * v;
      n++;
    }
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

export interface SpeechLikeOptions {
  /** Fundamental frequency (Hz). Default 160. */
  f0?: number;
  /** Insert short 150 ms gaps every 0.6 s (syllable/word boundaries). Default true. */
  gaps?: boolean;
  /** PRNG seed for the light breath noise. Default 3. */
  seed?: number;
}

/**
 * A single-speaker, phone-band speech surrogate scaled so its active RMS is `dbfs` (default −20). Built from the
 * harmonics of a gliding pitch (`f0` ± 12 %, like intonation) shaped by three moving formants (≈500/1500/2600 Hz,
 * like changing vowels), modulated at 4.5 Hz (syllables), with a little broadband breath noise so it is never a pure
 * tone. The pitch and formants keep moving, as real speech does: the VAD treats a spectrum that stays the same for
 * ~360 ms as a sustained sound (a hum, an engine), not speech.
 */
export function speechLike(rate: number, seconds: number, dbfs = -20, opts: SpeechLikeOptions = {}): Float32Array {
  const { f0 = 160, gaps = true, seed = 3 } = opts;
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  const nyquist = rate / 2;
  const topHz = Math.min(nyquist, 3400);
  const formants: [number, number, number, number][] = [
    // centre (Hz), bandwidth (Hz), relative swing, swing rate (Hz)
    [500, 120, 0.25, 1.9],
    [1500, 180, 0.2, 1.3],
    [2600, 250, 0.08, 0.9],
  ];
  const maxHarmonics = Math.ceil(topHz / (0.8 * f0));
  const phases = new Float64Array(maxHarmonics + 1);
  for (let h = 1; h <= maxHarmonics; h++) phases[h] = h; // fixed, deterministic starting phases
  const random = rng(seed);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const pitch = f0 * (1 + 0.12 * Math.sin(2 * Math.PI * 0.7 * t) + 0.04 * Math.sin(2 * Math.PI * 2.3 * t + 1));
    for (let h = 1; h <= maxHarmonics; h++) phases[h] += (2 * Math.PI * h * pitch) / rate;
    if (gaps && t % 0.6 > 0.45) continue; // 150 ms gap at the end of each 0.6 s "syllable"
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4.5 * t); // syllable-rate amplitude modulation
    let v = 0;
    for (let h = 1; h <= maxHarmonics && pitch * h < topHz; h++) {
      const freq = pitch * h;
      let gain = 0.05;
      for (const [fc, bw, swing, swingHz] of formants) {
        const centre = fc * (1 + swing * Math.sin(2 * Math.PI * swingHz * t + fc));
        gain += 1 / (1 + ((freq - centre) / (bw / 2)) ** 2);
      }
      v += gain * Math.sin(phases[h]);
    }
    out[i] = (v + 0.15 * (2 * random() - 1)) * env;
  }
  const cur = activeRms(out);
  if (cur > 0) {
    const gain = 10 ** (dbfs / 20) / cur;
    for (let i = 0; i < n; i++) {
      const v = out[i] * gain;
      out[i] = v < -1 ? -1 : v > 1 ? 1 : v;
    }
  }
  return out;
}

/** speechLike() as PCM16, for the phone (µ-law) and 16-bit WAV paths. */
export function speechLikePcm16(rate: number, seconds: number, dbfs = -20, opts: SpeechLikeOptions = {}): Int16Array {
  const f = speechLike(rate, seconds, dbfs, opts);
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = f[i];
    out[i] = Math.round((v < -1 ? -1 : v > 1 ? 1 : v) * 32767);
  }
  return out;
}

/* ---------- non-speech the VAD must never count (8 kHz phone-band unless a rate is given) ---------- */

/** Deterministic uniform white noise at `dbfs` RMS. */
export function whiteNoise(rate: number, seconds: number, dbfs: number, seed = 1): Float32Array {
  const random = rng(seed);
  const amp = Math.sqrt(3) * 10 ** (dbfs / 20);
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * (2 * random() - 1);
  return out;
}

/** Scale to an RMS of `dbfs` (in place) and return the same array. */
function toLevel(x: Float32Array, dbfs: number): Float32Array {
  let sum = 0;
  for (const v of x) sum += v * v;
  const gain = sum > 0 ? 10 ** (dbfs / 20) / Math.sqrt(sum / x.length) : 0;
  for (let i = 0; i < x.length; i++) x[i] *= gain;
  return x;
}

/** One-pole low-pass noise at `dbfs` RMS: pole 0.9 ≈ a fan, 0.99 ≈ car or traffic rumble. */
export function lowPassNoise(rate: number, seconds: number, dbfs: number, pole: number, seed = 2): Float32Array {
  const x = whiteNoise(rate, seconds, 0, seed);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y = pole * y + x[i];
    x[i] = y;
  }
  return toLevel(x, dbfs);
}

/** Resonant (two-pole band-pass) noise at `dbfs` RMS around `hz`: a whine; r 0.99 ≈ 25 Hz wide at 8 kHz. */
export function bandPassNoise(rate: number, seconds: number, dbfs: number, hz: number, r: number, seed = 3): Float32Array {
  const x = whiteNoise(rate, seconds, 0, seed);
  const c = 2 * r * Math.cos((2 * Math.PI * hz) / rate);
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = x[i] + c * y1 - r * r * y2;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
  return toLevel(x, dbfs);
}

/** A mains or engine hum: harmonics of `f0` (1/h amplitudes, slight jitter) at `dbfs` RMS. Periodic, like voiced speech. */
export function hum(rate: number, seconds: number, dbfs: number, f0: number, seed = 4): Float32Array {
  const random = rng(seed);
  const out = new Float32Array(Math.round(rate * seconds));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    phase += (2 * Math.PI * f0 * (1 + 0.01 * (random() - 0.5))) / rate;
    let v = 0;
    for (let h = 1; h * f0 < Math.min(3400, rate / 2); h++) v += Math.sin(h * phase + h) / h;
    out[i] = v;
  }
  return toLevel(out, dbfs);
}

/** A sum of pure tones, each at `dbfs` RMS (a DTMF key, ringback, a beep). */
export function tones(rate: number, seconds: number, dbfs: number, ...hz: number[]): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  const amp = Math.SQRT2 * 10 ** (dbfs / 20);
  for (const f of hz) for (let i = 0; i < out.length; i++) out[i] += amp * Math.sin((2 * Math.PI * f * i) / rate);
  return out;
}

/** The 16 DTMF keys' (row, column) frequencies. */
export const DTMF_KEYS: readonly (readonly [number, number])[] = [697, 770, 852, 941].flatMap((row) =>
  [1209, 1336, 1477, 1633].map((col) => [row, col] as const),
);

/**
 * A train of noise bursts (knocks, dishes, footsteps, a keyboard): `width`-second bursts at `dbfs`, one every
 * `minGap`…`maxGap` seconds, optionally decaying with time constant `decay` seconds (an impact).
 */
export interface BurstOptions {
  width: number;
  minGap: number;
  maxGap: number;
  dbfs: number;
  decay?: number;
  seed?: number;
}

export function bursts(rate: number, seconds: number, opts: BurstOptions): Float32Array {
  const { width, minGap, maxGap, dbfs, decay = 0, seed = 5 } = opts;
  const random = rng(seed);
  const out = new Float32Array(Math.round(rate * seconds));
  for (let t = 0.2; t + width < seconds; t += minGap + (maxGap - minGap) * random()) {
    const burst = whiteNoise(rate, width, dbfs, Math.floor(random() * 1e6));
    if (decay > 0) for (let i = 0; i < burst.length; i++) burst[i] *= Math.exp(-i / (decay * rate));
    out.set(burst, Math.round(t * rate));
  }
  return out;
}

/** Sample-by-sample sum (the length of the longest input). */
export function mix(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(Math.max(0, ...parts.map((p) => p.length)));
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
  return out;
}

/** Concatenation. */
export function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** `count` repetitions of `on` seconds of make(on) then `off` seconds of silence (cadenced tones, a hum switching on and off). */
export function cadence(rate: number, on: number, off: number, count: number, make: (seconds: number) => Float32Array): Float32Array {
  const parts: Float32Array[] = [];
  for (let i = 0; i < count; i++) parts.push(make(on), new Float32Array(Math.round(rate * off)));
  return join(...parts);
}
