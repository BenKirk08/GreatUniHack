/**
 * Voice-activity detection over ~30 ms frames and a "seconds of clean speech" counter, used to tell when enough of the
 * customer's voice has been captured for the AI Voice Twin. Pure and environment-agnostic (typed arrays and Math only)
 * — shared by the Node media bridge, the sample route and the browser recorder.
 *
 * A cloned voice must only ever be the consenting account holder's, so the counter is built to count nothing but the
 * customer's own, close-up speech, and to give up a little real speech rather than count anything else:
 *  - **level**: nothing quieter than `thresholdDbfs` (−40 dBFS) ever counts. In noise the threshold rises with the
 *    noise floor (floor + margin), tracked by minimum statistics over ~3.6 s on every frame, so any sustained level
 *    becomes the floor (a dropout or silence can pull the floor down, never the threshold). A frame more than
 *    `relativeLevelDb` (18 dB) below the customer's running speech level (a slow-decay peak tracker of counted speech)
 *    never counts either, so a TV, other people in the room or echo of the other party don't;
 *  - **voicing**: an utterance is only confirmed by a run dense in pitched frames (periodic at a 65–400 Hz voice
 *    pitch), so noise of any colour or level (fans, cars, traffic) and impulses (knocks, dishes, keyboards) never
 *    confirm, however long or loud;
 *  - **sustained sounds**: a frame whose spectrum is one or two stable lines (a held tone, ringback, a whistle, a beep,
 *    even under noise), a DTMF key tone (Goertzel), or a spectrum that has stayed the same for ~360 ms (a hum, an
 *    engine, a resonant whine: speech keeps changing) is never a pitched speech frame;
 *  - **clipping**: a frame with samples at the codec's ceiling (µ-law decodes to at most 0.9803) is never counted or
 *    kept, not even as part of a pause, and ends the utterance;
 *  - **utterances**: a pause inside an utterance (≤ `maxGapFrames`) is counted only once the speech that resumes it is
 *    itself a confirmed run, so trains of impulses can't chain; a pre-roll keeps word onsets (counted) and a hangover
 *    keeps word endings (kept, never counted). `maxGapFrames` < `hangoverFrames` + `prerollFrames`, so re-counting
 *    the kept audio (the sample route re-counts what the browser kept) never bridges two utterances.
 */
import { pcm16ToFloat32 } from "./mulaw";

export interface VadOptions {
  sampleRate: number;
  /** Frame length in milliseconds. Default 30. */
  frameMs?: number;
  /**
   * The static threshold (dBFS): nothing quieter ever counts. The adaptive threshold only ever rises above it (to the
   * noise floor + noiseMarginDb, in noise). Also the threshold isCleanSpeechFrame() uses. Default -40.
   */
  thresholdDbfs?: number;
  /**
   * @deprecated Kept for source compatibility. The adaptive threshold never drops below max(thresholdDbfs, this), so
   * this can only make the counter stricter. Default -40.
   */
  minThresholdDbfs?: number;
  /** In noise, the threshold sits this far above the tracked noise floor (dB). Default 8. */
  noiseMarginDb?: number;
  /** A frame more than this far below the customer's running speech level (dB) is never counted. Default 18. */
  relativeLevelDb?: number;
  /**
   * A run of consecutive non-silent frames confirms an utterance (or resumes one after a pause) once this many of its
   * latest 2 × minRunFrames frames are pitched speech frames (drops clicks, knocks, noise and tones). Default 3.
   */
  minRunFrames?: number;
  /** Frames kept in the output audio right after an utterance ends (word endings); never counted. Default 8. */
  hangoverFrames?: number;
  /** Frames just before a confirmed onset, kept and counted (word onsets). Default 3. */
  prerollFrames?: number;
  /**
   * A pause inside a confirmed utterance of up to this many frames is counted and kept once a confirmed run resumes
   * it. Keep it below hangoverFrames + prerollFrames. Default 10 (~300 ms).
   */
  maxGapFrames?: number;
  /**
   * A frame is pitched (voiced speech) when its normalised autocorrelation below ~1 kHz at a 65–400 Hz pitch lag
   * reaches this (and reaches 0.2 across the full band; see periodicity()). Default 0.35.
   */
  minPeriodicity?: number;
  /**
   * Optional extra tone gate on the single-sinusoid tonal flatness (see tonalFlatness()): a frame below it is never a
   * pitched frame. Default 0 (off): real 8 kHz speech is often this predictable (median ≈ 0.02), so the counter relies
   * on its spectral-line, DTMF and stationarity checks instead.
   */
  minTonalFlatness?: number;
  /** |sample| ≥ this counts as clipped. Default 0.97 (µ-law's largest decoded magnitude is 0.9803). */
  clipLevel?: number;
  /** A frame with a larger fraction of clipped samples is clipped: never counted or kept. Default 0.01. */
  maxClippedFraction?: number;
}

/** Defaults for every option except sampleRate. */
export const DEFAULT_VAD: Required<Omit<VadOptions, "sampleRate">> = Object.freeze({
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

/** Where the tracked noise floor starts (dBFS). It can't rise above this until a whole floor window has been seen. */
const INIT_NOISE_FLOOR_DBFS = -48;
/** Minimum statistics: the floor is the lowest frame power over the last ~3.6 s (in 300 ms sub-windows). */
const FLOOR_WINDOW_MS = 3_600;
const FLOOR_SUBWINDOW_MS = 300;
/** Frames quieter than this (digital silence, dropouts, DTX) count as this level in the floor estimate. */
const SILENT_FRAME_DBFS = -70;
const FLOOR_MIN_DBFS = -75;
const FLOOR_MAX_DBFS = -10;
/** The customer's speech level follows louder counted speech frames this fast (per frame)… */
const SPEECH_REF_ATTACK = 0.2;
/** …and decays this slowly (dB per second). */
const SPEECH_REF_DECAY_DB_PER_S = 0.5;
/** A run of non-silent frames that hasn't confirmed by this length starts sliding into the pre-roll. */
const MAX_PENDING_MS = 1_000;
/** A tone is recognised within this many frames of its start: when it is, the frames leading into it lose their speech mark. */
const TONE_ONSET_FRAMES = 3;
/** While a run is still going, its newest frames don't count towards confirming it yet (a tone may still show itself). */
const CONFIRM_LAG_FRAMES = 2;
/** Analysis runs at about 8 kHz: higher rates are box-averaged down by round(rate / 8000). */
const ANALYSIS_RATE = 8_000;
const F0_MIN_HZ = 65;
const F0_MAX_HZ = 400;
/** Periodicity is measured below ~1 kHz, where voiced speech's pitch harmonics are (4th-order Butterworth low-pass)… */
const PITCH_BAND_HZ = 1_000;
/** …and the full band must reach at least this too (noise scores ≈ 0.1–0.25 there, speech ≈ 0.7)… */
const FULL_BAND_MIN_PERIODICITY = 0.2;
/** …both after pre-emphasis, which flattens rumble and low-pass noise. */
const PRE_EMPHASIS = 0.97;
/** Spectral lines: two lines holding this share of a 60 ms window's power, stable to LINE_MATCH_HZ, are a tone. */
const LINE_PEAKINESS = 0.9;
const LINE_MIN_SHARE = 0.15;
const LINE_MATCH_HZ = 3;
const DTMF_ROWS = [697, 770, 852, 941];
const DTMF_COLS = [1209, 1336, 1477, 1633];
/** A frame is a DTMF key tone when its strongest row and column tones hold this share of its power… */
const DTMF_MIN_SHARE = 0.7;
/** …each holding at least this share. */
const DTMF_MIN_EACH = 0.1;
/**
 * Spectral stationarity: a frame whose band spectrum (STATIONARY_BANDS overlapping triangular bands, 250–3750 Hz)
 * matches each of the voiced frames STATIONARY_LAGS_MS of voiced audio earlier to a cosine similarity of
 * STATIONARY_SIMILARITY is part of a sustained sound. Speech keeps changing within ~100–300 ms, so few of its pitched
 * frames match all four; hums, engines, resonant whines and tones nearly always do (calibrated: 0.96 starts letting
 * narrow whines through, 0.92 keeps a margin).
 */
const STATIONARY_BANDS = 16;
const STATIONARY_LOW_HZ = 250;
const STATIONARY_HIGH_HZ = 3_750;
const STATIONARY_LAGS_MS = [90, 180, 270, 360];
const STATIONARY_SIMILARITY = 0.92;

export interface FrameStats {
  rms: number;
  /** 20·log10(rms); -Infinity for digital silence (and for an empty frame). */
  dbfs: number;
  peak: number;
  clippedFraction: number;
}

/** Level statistics of one frame of float samples in [-1, 1]. Silence (rms 0) → dbfs = -Infinity. */
export function frameStats(frame: Float32Array, clipLevel: number = DEFAULT_VAD.clipLevel): FrameStats {
  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i];
    const abs = Math.abs(v);
    sumSquares += v * v;
    if (abs > peak) peak = abs;
    if (abs >= clipLevel) clipped++;
  }
  const n = frame.length;
  const rms = n > 0 ? Math.sqrt(sumSquares / n) : 0;
  return { rms, dbfs: rms > 0 ? 20 * Math.log10(rms) : -Infinity, peak, clippedFraction: n > 0 ? clipped / n : 0 };
}

/** Loud enough and clean: level ≥ thresholdDbfs and clippedFraction ≤ maxClippedFraction. */
export function isCleanSpeechFrame(stats: FrameStats, opts?: Partial<VadOptions>): boolean {
  const threshold = opts?.thresholdDbfs ?? DEFAULT_VAD.thresholdDbfs;
  const maxClipped = opts?.maxClippedFraction ?? DEFAULT_VAD.maxClippedFraction;
  return stats.dbfs >= threshold && stats.clippedFraction <= maxClipped;
}

/**
 * Tonal flatness of a frame in [0, 1]: how much of the frame is NOT explained by a single sinusoid. A pure tone
 * x[n] = A·sin(ωn+φ) satisfies x[n] + x[n-2L] = (2cos Lω)·x[n-L] exactly for any lag L, so the best single coefficient
 * leaves no residual → 0. Broadband noise leaves a large residual → near 1. (= 1 − squared correlation of x[n-L] with
 * x[n] + x[n-2L].) An empty or near-zero-energy frame is undefined → 1 (not a tone). Low-pitched or band-limited
 * speech can score low too, so the counter only uses it when minTonalFlatness is set.
 *
 * `lag` is the predictor spacing in samples: round(rate / 8000) evaluates each acoustic frequency at its 8 kHz-
 * equivalent resolution, so the measure behaves the same from 8 kHz up to 48 kHz.
 */
export function tonalFlatness(frame: Float32Array, lag = 1): number {
  const l = lag >= 1 ? Math.round(lag) : 1;
  let nLL = 0;
  let nLy = 0;
  let yy = 0;
  for (let i = 2 * l; i < frame.length; i++) {
    const xmL = frame[i - l];
    const y = frame[i] + frame[i - 2 * l];
    nLL += xmL * xmL;
    nLy += xmL * y;
    yy += y * y;
  }
  if (!(nLL > 0) || !(yy > 0)) return 1;
  const flatness = 1 - (nLy * nLy) / (nLL * yy);
  return flatness < 0 ? 0 : flatness > 1 ? 1 : flatness;
}

/** Low-pass `x` in place: 4th-order Butterworth (two RBJ biquads) at `cutoffHz`; a no-op when that is near Nyquist. */
function lowPass(x: Float64Array, sampleRate: number, cutoffHz: number): void {
  if (!(cutoffHz < 0.45 * sampleRate)) return;
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  for (const q of [0.5412, 1.3066]) {
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    const b0 = (1 - cos) / 2 / a0;
    const b1 = (1 - cos) / a0;
    const a1 = (-2 * cos) / a0;
    const a2 = (1 - alpha) / a0;
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const out = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = v;
      y2 = y1;
      y1 = out;
      x[i] = out;
    }
  }
}

/** Highest local peak of the normalised autocorrelation of `x` (pre-emphasised in place) at a 65–400 Hz pitch lag. */
function pitchPeak(x: Float64Array, sampleRate: number): number {
  const n = x.length;
  for (let i = n - 1; i >= 1; i--) x[i] -= PRE_EMPHASIS * x[i - 1];
  x[0] = 0;
  const energy = new Float64Array(n + 1); // energy[k] = Σ x[0..k)²
  for (let i = 0; i < n; i++) energy[i + 1] = energy[i] + x[i] * x[i];
  const minLag = Math.max(2, Math.floor(sampleRate / F0_MAX_HZ));
  const maxLag = Math.min(Math.floor(n / 2), Math.ceil(sampleRate / F0_MIN_HZ));
  if (maxLag <= minLag) return 0;
  const rho = (lag: number): number => {
    let xy = 0;
    for (let i = 0; i + lag < n; i++) xy += x[i] * x[i + lag];
    const xx = energy[n - lag];
    const yy = energy[n] - energy[lag];
    return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
  };
  let best = 0;
  let before = rho(minLag - 1);
  let at = rho(minLag);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const after = rho(lag + 1);
    if (at >= before && at >= after && at > best) best = at;
    before = at;
    at = after;
  }
  return best;
}

/**
 * Periodicity of a window in [0, 1]: the highest local peak of the normalised autocorrelation at a 65–400 Hz pitch
 * lag, after pre-emphasis (which flattens rumble and low-pass noise). Voiced speech scores high (median ≈ 0.7 on phone
 * speech); white, coloured and impulsive noise score ≈ 0.1–0.3. Pure tones and hums score high too, which is why the
 * counter checks for them separately. Use a window of ≥ 40 ms (the counter uses 60 ms).
 *
 * With `lowBand`, it is measured below ~1 kHz instead, where voiced speech's pitch harmonics are and the ringing of a
 * struck plate or glass isn't. The counter needs a frame pitched below 1 kHz (≥ minPeriodicity) and at least a little
 * across the full band (≥ 0.2), which low-passed noise (a single frame can look pitched below 1 kHz) rarely is.
 */
export function periodicity(samples: ArrayLike<number>, sampleRate: number, lowBand = false): number {
  if (samples.length < 4 || !(sampleRate > 0)) return 0;
  const x = Float64Array.from(samples);
  if (lowBand) lowPass(x, sampleRate, PITCH_BAND_HZ);
  return pitchPeak(x, sampleRate);
}

/** Share of a frame's power at frequency `hz` (Goertzel; 1 for a pure tone at exactly `hz`). */
function toneShare(samples: ArrayLike<number>, sampleRate: number, hz: number, power: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const magnitude = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (2 * magnitude) / (samples.length * power);
}

/**
 * DTMF score of a frame in [0, ~1]: the share of its power in its strongest DTMF row tone plus its strongest column
 * tone (0 unless both hold ≥ 10 %). A key tone scores ≈ 1, even under noise; speech stays well below 0.7.
 */
export function dtmfScore(samples: ArrayLike<number>, sampleRate: number): number {
  let power = 0;
  for (let i = 0; i < samples.length; i++) power += samples[i] * samples[i];
  if (!(power > 0) || !(sampleRate > 0)) return 0;
  const row = Math.max(...DTMF_ROWS.map((hz) => toneShare(samples, sampleRate, hz, power)));
  const col = Math.max(...DTMF_COLS.map((hz) => toneShare(samples, sampleRate, hz, power)));
  return Math.min(row, col) >= DTMF_MIN_EACH ? row + col : 0;
}

interface SpectralLine {
  hz: number;
  share: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place iterative radix-2 FFT (re/im length a power of two). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len >> 1;
    for (let start = 0; start < n; start += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** Spectral features of the current 60 ms window. */
interface SpectralFeatures {
  /** Share of the window's power in its two strongest spectral lines. */
  peakiness: number;
  lines: SpectralLine[];
  /** Band magnitudes (STATIONARY_BANDS bands), for the stationarity check. */
  bands: Float64Array;
}

/**
 * Per-frame feature extraction at ~8 kHz: each frame is box-averaged down by round(rate / 8000), and the previous and
 * current frame form a 60 ms analysis window (periodicity, spectrum). Scratch buffers are allocated once.
 */
class FrameAnalyser {
  readonly rate: number;
  private readonly factor: number;
  private readonly size: number;
  /** Previous frame then current frame, decimated. */
  private readonly window: Float64Array;
  private readonly hann: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly power: Float64Array;
  private readonly lineHalfWidth: number;
  /**
   * FFT bin → the lower of the two overlapping triangular stationarity bands it falls in (-1 outside 250–3750 Hz) and
   * its weight there (the rest goes to the next band up): a narrow whine near a band edge can't flip between bands.
   */
  private readonly bandOf: Int16Array;
  private readonly bandWeight: Float64Array;

  constructor(sampleRate: number, frameSamples: number) {
    this.factor = Math.max(1, Math.round(sampleRate / ANALYSIS_RATE));
    this.rate = sampleRate / this.factor;
    this.size = Math.max(1, Math.floor(frameSamples / this.factor));
    const span = 2 * this.size;
    this.window = new Float64Array(span);
    this.hann = new Float64Array(span);
    for (let i = 0; i < span; i++) this.hann[i] = span > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (span - 1)) : 1;
    const n = nextPowerOfTwo(Math.max(span, 4));
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.power = new Float64Array(n / 2 + 1);
    // A Hann window's main lobe is ±2 bins of the unpadded window.
    this.lineHalfWidth = Math.max(1, Math.round((2 * n) / span));
    const high = Math.min(STATIONARY_HIGH_HZ, 0.47 * this.rate);
    const bandHz = (high - STATIONARY_LOW_HZ) / STATIONARY_BANDS;
    this.bandOf = new Int16Array(n / 2 + 1).fill(-1);
    this.bandWeight = new Float64Array(n / 2 + 1);
    for (let k = 1; k <= n / 2; k++) {
      const hz = (k * this.rate) / n;
      if (hz < STATIONARY_LOW_HZ || hz >= high) continue;
      // Band centres sit at the middle of each band; between two centres a bin is shared linearly.
      const position = clamp((hz - STATIONARY_LOW_HZ) / bandHz - 0.5, 0, STATIONARY_BANDS - 1);
      const lower = Math.min(STATIONARY_BANDS - 2, Math.floor(position));
      this.bandOf[k] = lower;
      this.bandWeight[k] = 1 - (position - lower);
    }
  }

  /** Shift the window by one frame (always, so the 60 ms window stays contiguous). */
  push(frame: Float32Array): void {
    const { window, size, factor } = this;
    window.copyWithin(0, size, 2 * size);
    for (let i = 0; i < size; i++) {
      let sum = 0;
      for (let j = 0; j < factor; j++) sum += frame[i * factor + j];
      window[size + i] = sum / factor;
    }
  }

  reset(): void {
    this.window.fill(0);
  }

  /**
   * Periodicity of the window below ~1 kHz (where a voice's pitch is clearest; a plate's or glass's ringing isn't
   * there), or 0 unless the full band is at least a little periodic too (low-passed noise can look pitched for a frame).
   */
  periodicity(): number {
    return periodicity(this.window, this.rate) >= FULL_BAND_MIN_PERIODICITY ? periodicity(this.window, this.rate, true) : 0;
  }

  /** DTMF score of the current frame, or of either half of it (a short key tone may only fill part of a frame). */
  dtmf(): number {
    const { window, size, rate } = this;
    const half = size >> 1;
    const whole = dtmfScore(window.subarray(size), rate);
    if (half < 64) return whole;
    return Math.max(whole, dtmfScore(window.subarray(size, size + half), rate), dtmfScore(window.subarray(2 * size - half), rate));
  }

  /** The window's spectrum (Hann, zero-padded FFT): its two strongest lines (log-parabolic interpolation) and bands. */
  spectrum(): SpectralFeatures {
    const { re, im, power, window, hann, lineHalfWidth, bandOf, bandWeight } = this;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < window.length; i++) re[i] = window[i] * hann[i];
    fft(re, im);
    const n = re.length;
    const top = n / 2;
    const bands = new Float64Array(STATIONARY_BANDS);
    let total = 0;
    for (let k = 0; k <= top; k++) {
      power[k] = re[k] * re[k] + im[k] * im[k];
      if (k >= 1) total += power[k];
      if (bandOf[k] >= 0) {
        bands[bandOf[k]] += bandWeight[k] * power[k];
        bands[bandOf[k] + 1] += (1 - bandWeight[k]) * power[k];
      }
    }
    for (let b = 0; b < STATIONARY_BANDS; b++) bands[b] = Math.sqrt(bands[b]);
    if (!(total > 0)) return { peakiness: 0, lines: [], bands };
    const lines: SpectralLine[] = [];
    let captured = 0;
    for (let line = 0; line < 2; line++) {
      let peak = -1;
      for (let k = 1; k < top; k++) if (power[k] > 0 && (peak < 0 || power[k] > power[peak])) peak = k;
      if (peak < 0) break;
      const a = Math.log(power[peak - 1] + 1e-30);
      const b = Math.log(power[peak] + 1e-30);
      const c = Math.log(power[peak + 1] + 1e-30);
      const curvature = a - 2 * b + c;
      const offset = curvature < 0 ? (0.5 * (a - c)) / curvature : 0;
      let share = 0;
      for (let k = Math.max(1, peak - lineHalfWidth); k <= Math.min(top, peak + lineHalfWidth); k++) {
        share += power[k];
        power[k] = 0; // taken: the next line is looked for elsewhere
      }
      share /= total;
      captured += share;
      lines.push({ hz: ((peak + offset) * this.rate) / n, share });
    }
    return { peakiness: captured, lines, bands };
  }
}

/** Every strong line of `now` has a line in `before` within LINE_MATCH_HZ: the spectrum is the same stable tone(s). */
function sameLines(now: SpectralLine[], before: SpectralLine[]): boolean {
  const strong = now.filter((l) => l.share >= LINE_MIN_SHARE);
  return strong.length > 0 && strong.every((l) => before.some((b) => Math.abs(b.hz - l.hz) <= LINE_MATCH_HZ));
}

export interface PushResult {
  /** Frames completed by this push. */
  frames: number;
  /** Frames newly counted as clean speech by this push (can include earlier buffered frames of a run/gap counted now). */
  speechFrames: number;
  /** Seconds newly counted by this push (= speechFrames × frameSamples / sampleRate). */
  speechSeconds: number;
  /** Audio to keep (counted speech + pre-roll + intra-utterance gaps + hangover), in order, ready to append to a WAV. */
  kept: Float32Array;
}

function concatFrames(frames: Float32Array[], frameSamples: number): Float32Array {
  const out = new Float32Array(frames.length * frameSamples);
  frames.forEach((frame, i) => out.set(frame, i * frameSamples));
  return out;
}

/** A frame held while the counter waits to see whether it counts. */
interface HeldFrame {
  samples: Float32Array;
  /** A pitched speech frame (evidence of the customer's voice); a tone found later can still take this back. */
  speech: boolean;
  dbfs: number;
}

/**
 * Streaming counter of clean-speech seconds. Audio is cut into consecutive, non-overlapping frames of `frameSamples`.
 * A frame is "voiced" when it is at or above the adaptive threshold, not too far below the customer's speech level and
 * not clipped; a voiced frame is a "speech" frame when it is also pitched and not part of a tone or sustained sound.
 * A run of voiced frames confirms an utterance once it is dense in speech frames (counting the run and its pre-roll).
 * While an utterance is active, speech frames are counted as they come; anything else is held, and counted only once
 * speech carries straight on from it or a confirmed run resumes it within maxGapFrames. When the utterance ends, up to
 * hangoverFrames of what was held are kept but never counted. Counting can trail the audio by a few frames (a run is
 * judged once it is clearly speech, or as a whole when it ends; flush() judges the last one). Seconds are frames ×
 * frameSamples / sampleRate, i.e. based on the real (rounded) frame length. Decisions depend only on the frame
 * sequence, so the result is identical however the audio is split across push() calls.
 */
export class SpeechCounter {
  readonly options: Required<VadOptions>;
  /** round(sampleRate × frameMs / 1000). */
  readonly frameSamples: number;
  /** Exact duration of one frame: frameSamples / sampleRate. */
  readonly frameSeconds: number;

  /** Tonal-flatness predictor lag (minTonalFlatness only): round(sampleRate / 8000). */
  private readonly tonalLag: number;
  private readonly analyser: FrameAnalyser;
  private readonly floorSubwindowFrames: number;
  private readonly maxPendingFrames: number;
  private readonly speechRefDecayPerFrame: number;
  /** STATIONARY_LAGS_MS in frames. */
  private readonly stationaryLags: number[];
  private carry = new Float32Array(0);

  /** Minimum statistics: the lowest frame power in each of the last few sub-windows, and in the current one. */
  private floorWindow: Float64Array;
  private floorSlot = 0;
  private floorCurrentMin = Infinity;
  private floorCurrentFrames = 0;
  /** The customer's running speech level (dBFS); -Infinity until speech is first counted. */
  private speechRefDbfs = -Infinity;
  /** Spectral lines of the previous frame, when it was peaky. */
  private previousLines: SpectralLine[] | null = null;
  /** Band spectra of the latest voiced frames, newest last (stationarity check; silence between them is skipped). */
  private recentBands: Float64Array[] = [];

  /** Frames just seen and not kept, contiguous with the current position (pre-roll for the next onset), ≤ prerollFrames. */
  private preroll: Float32Array[] = [];
  /** While idle: the current run of voiced frames, not yet confirmed. */
  private pending: HeldFrame[] = [];
  /** Inside a confirmed utterance. */
  private active = false;
  /** While active: every frame since the last counted one. */
  private hold: HeldFrame[] = [];
  /** The hold contains a silent (unvoiced) frame: speech resuming it must be a confirmed run. */
  private holdHasGap = false;
  /** Start (in hold) of the trailing run of voiced frames, or -1. */
  private runStart = -1;

  private countedFrames = 0;
  private totalFrames = 0;

  constructor(opts: VadOptions) {
    const { sampleRate } = opts;
    const frameMs = opts.frameMs ?? DEFAULT_VAD.frameMs;
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error(`VAD: invalid sample rate ${sampleRate}`);
    const frameSamples = Math.round((sampleRate * frameMs) / 1000);
    if (!(frameSamples >= 1)) throw new Error(`VAD: frameMs ${frameMs} gives no samples at ${sampleRate} Hz`);
    this.options = {
      sampleRate,
      frameMs,
      thresholdDbfs: opts.thresholdDbfs ?? DEFAULT_VAD.thresholdDbfs,
      minThresholdDbfs: opts.minThresholdDbfs ?? DEFAULT_VAD.minThresholdDbfs,
      noiseMarginDb: opts.noiseMarginDb ?? DEFAULT_VAD.noiseMarginDb,
      relativeLevelDb: opts.relativeLevelDb ?? DEFAULT_VAD.relativeLevelDb,
      minRunFrames: Math.max(1, Math.round(opts.minRunFrames ?? DEFAULT_VAD.minRunFrames)),
      hangoverFrames: Math.max(0, Math.round(opts.hangoverFrames ?? DEFAULT_VAD.hangoverFrames)),
      prerollFrames: Math.max(0, Math.round(opts.prerollFrames ?? DEFAULT_VAD.prerollFrames)),
      maxGapFrames: Math.max(0, Math.round(opts.maxGapFrames ?? DEFAULT_VAD.maxGapFrames)),
      minPeriodicity: opts.minPeriodicity ?? DEFAULT_VAD.minPeriodicity,
      minTonalFlatness: opts.minTonalFlatness ?? DEFAULT_VAD.minTonalFlatness,
      clipLevel: opts.clipLevel ?? DEFAULT_VAD.clipLevel,
      maxClippedFraction: opts.maxClippedFraction ?? DEFAULT_VAD.maxClippedFraction,
    };
    this.frameSamples = frameSamples;
    this.frameSeconds = frameSamples / sampleRate;
    this.tonalLag = Math.max(1, Math.round(sampleRate / ANALYSIS_RATE));
    this.analyser = new FrameAnalyser(sampleRate, frameSamples);
    const realFrameMs = this.frameSeconds * 1000;
    this.floorSubwindowFrames = Math.max(1, Math.round(FLOOR_SUBWINDOW_MS / realFrameMs));
    this.floorWindow = new Float64Array(Math.max(1, Math.round(FLOOR_WINDOW_MS / FLOOR_SUBWINDOW_MS)));
    this.maxPendingFrames = Math.max(2 * this.options.minRunFrames, Math.round(MAX_PENDING_MS / realFrameMs));
    this.speechRefDecayPerFrame = SPEECH_REF_DECAY_DB_PER_S * this.frameSeconds;
    this.stationaryLags = STATIONARY_LAGS_MS.map((ms) => Math.max(1, Math.round(ms / realFrameMs)));
    this.resetFloor();
  }

  /** Feed audio (Int16 is converted ÷32768). Samples short of a whole frame are carried to the next push. */
  push(samples: Float32Array | Int16Array): PushResult {
    const input = samples instanceof Int16Array ? pcm16ToFloat32(samples) : samples;
    const buffer = new Float32Array(this.carry.length + input.length);
    buffer.set(this.carry, 0);
    buffer.set(input, this.carry.length);

    const kept: Float32Array[] = [];
    let frames = 0;
    let speechFrames = 0;
    let offset = 0;
    for (; offset + this.frameSamples <= buffer.length; offset += this.frameSamples) {
      speechFrames += this.processFrame(buffer.subarray(offset, offset + this.frameSamples), kept);
      frames++;
    }
    this.carry = buffer.slice(offset);
    this.totalFrames += frames;
    this.countedFrames += speechFrames;
    return {
      frames,
      speechFrames,
      speechSeconds: speechFrames * this.frameSeconds,
      kept: concatFrames(kept, this.frameSamples),
    };
  }

  /**
   * End of stream. A run still being judged is judged whole: if it confirms, it is counted and its audio returned
   * (append `kept` like a push's). A run that doesn't, and whatever was held inside an utterance without speech resuming
   * it, are dropped (never counted). The partial frame is discarded; the noise floor and speech level are reset.
   */
  flush(): PushResult {
    const kept: Float32Array[] = [];
    let speechFrames = 0;
    if (this.active) {
      if (this.resumes(0)) speechFrames = this.commitHold(kept);
    } else if (this.pending.length > 0 && this.confirms(this.pending, 0, 0)) {
      speechFrames = this.confirmPending(kept);
    }
    this.countedFrames += speechFrames;
    this.carry = new Float32Array(0);
    this.preroll = [];
    this.pending = [];
    this.active = false;
    this.clearHold();
    this.resetFloor();
    this.speechRefDbfs = -Infinity;
    this.previousLines = null;
    this.recentBands = [];
    this.analyser.reset();
    return { frames: 0, speechFrames, speechSeconds: speechFrames * this.frameSeconds, kept: concatFrames(kept, this.frameSamples) };
  }

  /** Total clean speech counted so far. */
  get speechSeconds(): number {
    return this.countedFrames * this.frameSeconds;
  }

  /** Total audio seen (completed frames only). */
  get totalSeconds(): number {
    return this.totalFrames * this.frameSeconds;
  }

  /** The tracked noise floor (dBFS). */
  get noiseFloorDbfs(): number {
    let lowest = this.floorCurrentMin;
    for (const p of this.floorWindow) if (p < lowest) lowest = p;
    return clamp(10 * Math.log10(lowest), FLOOR_MIN_DBFS, FLOOR_MAX_DBFS);
  }

  /**
   * The adaptive threshold (dBFS) as it stands now: noise floor + noiseMarginDb, never below thresholdDbfs (nor
   * minThresholdDbfs). Frames must also be within relativeLevelDb of the customer's speech level.
   */
  get thresholdDbfs(): number {
    const { thresholdDbfs, minThresholdDbfs, noiseMarginDb } = this.options;
    return Math.max(thresholdDbfs, minThresholdDbfs, this.noiseFloorDbfs + noiseMarginDb);
  }

  /** Forget everything, including the totals. */
  reset(): void {
    this.flush();
    this.countedFrames = 0;
    this.totalFrames = 0;
  }

  private resetFloor(): void {
    this.floorWindow.fill(10 ** (INIT_NOISE_FLOOR_DBFS / 10));
    this.floorSlot = 0;
    this.floorCurrentMin = Infinity;
    this.floorCurrentFrames = 0;
  }

  /**
   * Minimum statistics on every unclipped frame (energetic or not), so a sustained level becomes the floor. A dropout
   * or digital silence pulls the floor down, which is harmless: the threshold never goes below thresholdDbfs.
   */
  private trackFloor(stats: FrameStats): void {
    const power = Math.max(stats.rms * stats.rms, 10 ** (SILENT_FRAME_DBFS / 10));
    if (power < this.floorCurrentMin) this.floorCurrentMin = power;
    if (++this.floorCurrentFrames >= this.floorSubwindowFrames) {
      this.floorWindow[this.floorSlot] = this.floorCurrentMin;
      this.floorSlot = (this.floorSlot + 1) % this.floorWindow.length;
      this.floorCurrentMin = Infinity;
      this.floorCurrentFrames = 0;
    }
  }

  /** The band spectrum matches each of the voiced frames STATIONARY_LAGS_MS of voiced audio earlier: a sustained sound. */
  private stationary(bands: Float64Array): boolean {
    const recent = this.recentBands;
    return this.stationaryLags.every((lag) => lag <= recent.length && cosineSimilarity(bands, recent[recent.length - lag]) >= STATIONARY_SIMILARITY);
  }

  /**
   * Run the state machine on one frame (a view into a scratch buffer: frames are copied before being retained).
   * Returns the number of frames newly counted.
   */
  private processFrame(frame: Float32Array, kept: Float32Array[]): number {
    const { clipLevel, maxClippedFraction, relativeLevelDb, minPeriodicity, minTonalFlatness } = this.options;
    const stats = frameStats(frame, clipLevel);
    const clipped = stats.clippedFraction > maxClippedFraction;
    this.analyser.push(frame);
    const spectrum = this.analyser.spectrum();
    const peaky = spectrum.peakiness >= LINE_PEAKINESS;
    const tone = peaky && this.previousLines !== null && sameLines(spectrum.lines, this.previousLines);
    this.previousLines = peaky ? spectrum.lines : null;
    if (!clipped) this.trackFloor(stats);
    if (Number.isFinite(this.speechRefDbfs)) this.speechRefDbfs -= this.speechRefDecayPerFrame;

    if (clipped) return this.breakAtClip(kept);
    if (tone) this.unmarkToneOnset();

    const voiced = stats.dbfs >= this.thresholdDbfs && stats.dbfs >= this.speechRefDbfs - relativeLevelDb;
    // Compared with the voiced frames before it, so a hum or whine that stops and starts is recognised at once.
    const stationary = voiced && this.stationary(spectrum.bands);
    if (voiced) {
      this.recentBands.push(spectrum.bands);
      if (this.recentBands.length > this.stationaryLags[this.stationaryLags.length - 1]) this.recentBands.shift();
    }
    const speech =
      voiced &&
      !tone &&
      !stationary &&
      this.analyser.periodicity() >= minPeriodicity &&
      this.analyser.dtmf() < DTMF_MIN_SHARE &&
      (minTonalFlatness <= 0 || tonalFlatness(frame, this.tonalLag) >= minTonalFlatness);

    const held: HeldFrame = { samples: frame.slice(), speech, dbfs: stats.dbfs };
    return this.active ? this.activeFrame(held, voiced, kept) : this.idleFrame(held, voiced, kept);
  }

  private pushPreroll(samples: Float32Array): void {
    if (this.options.prerollFrames <= 0) return;
    this.preroll.push(samples);
    if (this.preroll.length > this.options.prerollFrames) this.preroll.shift();
  }

  private noteSpeechLevel(frames: HeldFrame[]): void {
    for (const f of frames) {
      if (!f.speech) continue;
      if (!Number.isFinite(this.speechRefDbfs)) this.speechRefDbfs = f.dbfs;
      else if (f.dbfs > this.speechRefDbfs) this.speechRefDbfs += SPEECH_REF_ATTACK * (f.dbfs - this.speechRefDbfs);
    }
  }

  private clearHold(): void {
    this.hold = [];
    this.holdHasGap = false;
    this.runStart = -1;
  }

  /**
   * A run (frames[from..]) is confirmed once it has at least minRunFrames frames and its latest 2 × minRunFrames frames
   * hold `need` speech frames (minRunFrames to start an utterance; one fewer to resume one after a pause): the speech
   * has to be dense, so stray pitched frames in a long tone or noise never add up to a confirmation. While the run goes
   * on, its newest `lag` frames are left out (a tone may still show itself and unmark them).
   */
  private confirms(frames: HeldFrame[], from: number, lag: number, need = this.options.minRunFrames): boolean {
    const { minRunFrames } = this.options;
    const end = frames.length - lag;
    if (end - from < minRunFrames) return false;
    let speech = 0;
    for (let i = Math.max(from, end - 2 * minRunFrames); i < end; i++) if (frames[i].speech) speech++;
    return speech >= need;
  }

  /** A run resuming an utterance after a pause: minRunFrames frames, one fewer of them speech than an onset needs. */
  private resumes(lag: number): boolean {
    return this.runStart >= 0 && this.confirms(this.hold, this.runStart, lag, Math.max(1, this.options.minRunFrames - 1));
  }

  /** A tone was just recognised: the frames leading into it (its onset) were the tone too, not speech. */
  private unmarkToneOnset(): void {
    const frames = this.active ? this.hold : this.pending;
    for (let i = Math.max(0, frames.length - TONE_ONSET_FRAMES); i < frames.length; i++) frames[i].speech = false;
  }

  /** Not in an utterance: collect a run of voiced frames until it confirms. */
  private idleFrame(held: HeldFrame, voiced: boolean, kept: Float32Array[]): number {
    if (!voiced) {
      // The run is over, so it is judged whole: it may confirm now, and this frame then starts a pause.
      if (this.pending.length > 0 && this.confirms(this.pending, 0, 0)) return this.confirmPending(kept) + this.activeFrame(held, false, kept);
      // A run that never confirmed becomes pre-roll, in order (onsets stay contiguous), then this frame.
      for (const p of this.pending) this.pushPreroll(p.samples);
      this.pending = [];
      this.pushPreroll(held.samples);
      return 0;
    }
    this.pending.push(held);
    if (this.confirms(this.pending, 0, CONFIRM_LAG_FRAMES)) return this.confirmPending(kept);
    this.trimPending();
    return 0;
  }

  /**
   * Confirmed: count the run from its first speech frame, with the pre-roll just before it (word onset); the
   * utterance is active. Whatever led into the run before its first speech frame (noise loud enough to be voiced,
   * say) only ever counts as part of that pre-roll.
   */
  private confirmPending(kept: Float32Array[]): number {
    const first = Math.max(0, this.pending.findIndex((p) => p.speech));
    for (let i = 0; i < first; i++) this.pushPreroll(this.pending[i].samples);
    const run = this.pending.slice(first);
    const counted = this.preroll.length + run.length;
    for (const p of this.preroll) kept.push(p);
    for (const p of run) kept.push(p.samples);
    this.noteSpeechLevel(run);
    this.preroll = [];
    this.pending = [];
    this.active = true;
    this.clearHold();
    return counted;
  }

  /** A run that has gone on too long without confirming slides into the pre-roll. */
  private trimPending(): void {
    while (this.pending.length > this.maxPendingFrames) this.pushPreroll((this.pending.shift() as HeldFrame).samples);
  }

  /** In an utterance: count speech, hold everything else until speech resumes it or the pause is too long. */
  private activeFrame(held: HeldFrame, voiced: boolean, kept: Float32Array[]): number {
    const { minRunFrames, maxGapFrames } = this.options;
    if (held.speech && this.hold.length === 0) {
      kept.push(held.samples);
      this.noteSpeechLevel([held]);
      return 1;
    }
    if (!voiced && this.resumes(0)) {
      // The run resuming the pause is over, so it is judged whole: it confirms, and this frame starts a new pause.
      return this.commitHold(kept) + this.activeFrame(held, false, kept);
    }
    this.hold.push(held);
    if (voiced) {
      if (this.runStart < 0) this.runStart = this.hold.length - 1;
      // Speech carrying straight on after a stray non-speech frame or two resumes at once; after a pause (or a longer
      // stretch of non-speech) it takes a confirmed run.
      const straightOn = held.speech && !this.holdHasGap && this.hold.length <= minRunFrames;
      if (straightOn || this.resumes(CONFIRM_LAG_FRAMES)) return this.commitHold(kept);
    } else {
      this.holdHasGap = true;
      this.runStart = -1;
    }
    // How long the pause has lasted before the speech that might resume it (nothing in it was speech).
    let lead = this.hold.length;
    if (this.runStart >= 0) {
      for (let i = this.runStart; i < this.hold.length; i++) {
        if (this.hold[i].speech) {
          lead = i;
          break;
        }
      }
    }
    if (lead > maxGapFrames || this.hold.length > maxGapFrames + this.maxPendingFrames) this.endUtterance(kept);
    return 0;
  }

  private commitHold(kept: Float32Array[]): number {
    const counted = this.hold.length;
    for (const h of this.hold) kept.push(h.samples);
    this.noteSpeechLevel(this.hold);
    this.clearHold();
    return counted;
  }

  /**
   * The pause was too long: the utterance ends. The first hangoverFrames held frames are kept (never counted), the
   * rest seed the pre-roll, and a run of voiced frames in progress carries on as a new candidate run.
   */
  private endUtterance(kept: Float32Array[]): void {
    const tail = this.runStart >= 0 ? this.hold.slice(this.runStart) : [];
    const before = this.runStart >= 0 ? this.hold.slice(0, this.runStart) : this.hold;
    const keep = Math.min(this.options.hangoverFrames, before.length);
    for (let i = 0; i < keep; i++) kept.push(before[i].samples);
    this.preroll = [];
    for (let i = keep; i < before.length; i++) this.pushPreroll(before[i].samples);
    this.active = false;
    this.clearHold();
    this.pending = tail;
    this.trimPending();
  }

  /** A clipped frame: never kept or counted, and it breaks the audio (no pre-roll or pause spans it). */
  private breakAtClip(kept: Float32Array[]): number {
    if (this.active) {
      const keep = Math.min(this.options.hangoverFrames, this.hold.length);
      for (let i = 0; i < keep; i++) kept.push(this.hold[i].samples);
      this.active = false;
      this.clearHold();
    }
    this.pending = [];
    this.preroll = [];
    return 0;
  }
}
