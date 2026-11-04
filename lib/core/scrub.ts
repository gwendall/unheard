// Takes the tone of an aircraft out of a recording, along its curve and its harmonics, and
// leaves everything else. colsto's video shows why a high-pass filter is not enough: the tones sit
// where voices are, and boosting the filtered file brings the curve back. Here the tone itself is
// measured and subtracted: each harmonic is brought down to 0 Hz by following the curve's phase,
// smoothed to the band the curve may wander in, and taken away. The band is then filled with noise
// at the level of the sound beside it, or its hollow would trace the same curve. What a boost then
// finds is the recording's own noise.

/** A tone to take out: its heard fundamental, Hz, at `times` (seconds from the first sample). NaN where it is not heard. */
export type Curve = {
  times: ArrayLike<number>;
  freq: ArrayLike<number>;
  /** This curve's own `width` (ScrubOptions): a loud tone's skirts reach further. */
  width?: number;
};

export type ScrubOptions = {
  /** How many harmonics to take out, the fundamental included. */
  harmonics?: number;
  /**
   * Half the width of the band taken out around the fundamental, Hz: how far the curve may be off.
   * A curve off by 1 Hz is off by h Hz at harmonic h, so the band widens with it.
   */
  width?: number;
  /**
   * Times each harmonic is measured and taken away. The smoothing passes a tone 1.2 Hz off the
   * curve at about 87 %: one pass leaves 13 % of it, three leave 0.2 %.
   */
  passes?: number;
  /**
   * Fill each emptied band with the sound just beside it, moved onto the curve. Taking a tone out
   * takes the noise under it too, and the hole follows the curve: the evidence map compares each
   * frequency with itself over the whole file, so the rest of a hollowed band then stands out, and
   * a new line appears where the old one ran.
   */
  fill?: boolean;
  /** Called as the work goes: a step per curve, then another per curve's fill. */
  onStep?: (done: number, total: number) => void;
};

const TWO_PI = 2 * Math.PI;
const TWO_32 = 2 ** 32;

/** Harmonics taken out by default, the fundamental included. */
export const HARMONICS = 6;

const DEFAULTS: Required<ScrubOptions> = { harmonics: HARMONICS, width: 3, passes: 3, fill: true, onStep: () => {} };

/** The curve's frequency at every sample (NaN where unknown), linearly between its points. */
function perSample(curve: Curve, n: number, rate: number, out: Float64Array = new Float64Array(n)): Float64Array {
  out.fill(NaN, 0, n);
  const { times, freq } = curve;
  for (let j = 0; j + 1 < times.length; j++) {
    const f0 = freq[j];
    const f1 = freq[j + 1];
    if (!Number.isFinite(f0) || !Number.isFinite(f1)) continue;
    const a = Math.max(0, Math.ceil(times[j] * rate));
    const b = Math.min(n - 1, Math.floor(times[j + 1] * rate));
    const span = times[j + 1] - times[j];
    for (let i = a; i <= b; i++) out[i] = f0 + ((f1 - f0) * (i / rate - times[j])) / span;
  }
  return out;
}

/** Scratch of the smoothing and of each curve and harmonic, kept from one window to the next: a window at 48 kHz runs to 10 MB an array. */
const NO_DATA = new Float64Array(0);
const emptyBuffers = () => ({
  out: NO_DATA,
  tmp: NO_DATA,
  f: NO_DATA,
  cos: NO_DATA,
  sin: NO_DATA,
  cos1: NO_DATA,
  sin1: NO_DATA,
  re: NO_DATA,
  im: NO_DATA,
  weight: NO_DATA,
  accRe: NO_DATA,
  accIm: NO_DATA,
  level: NO_DATA,
  on: new Uint8Array(0),
  cleaned: new Float32Array(0),
});
let buffers = emptyBuffers();

function room(n: number) {
  if (buffers.out.length >= n) return;
  const doubles = () => new Float64Array(n);
  buffers = {
    out: doubles(),
    tmp: doubles(),
    f: doubles(),
    cos: doubles(),
    sin: doubles(),
    cos1: doubles(),
    sin1: doubles(),
    re: doubles(),
    im: doubles(),
    weight: doubles(),
    accRe: doubles(),
    accIm: doubles(),
    level: doubles(),
    on: new Uint8Array(n),
    cleaned: new Float32Array(n),
  };
}

/** Gives the scratch back, once a whole file is done. */
export function freeScrub() {
  buffers = emptyBuffers();
}

/**
 * One moving average over [i - half, i + half] of `from` into `to`, for i in [lo, hi): shrinking at
 * the edges of the `n` samples. `from` counts as zero outside [lo, hi).
 */
function runningMean(from: Float64Array, to: Float64Array, half: number, n: number, lo: number, hi: number) {
  // The window of the sample before lo.
  const a = Math.max(0, lo - 1 - half);
  const b = Math.min(n, lo + half);
  let count = b - a;
  let sum = 0;
  for (let i = lo; i < Math.min(b, hi); i++) sum += from[i];
  // In the middle the whole window is inside [lo, hi): nothing to check, the same count throughout.
  const midFrom = lo + half + 1;
  const midTo = hi - half;
  let i = lo;
  for (const end = Math.min(midFrom, hi); i < end; i++) {
    const add = i + half;
    if (add < n) {
      if (add < hi) sum += from[add];
      count++;
    }
    const drop = i - half - 1;
    if (drop >= 0) {
      if (drop >= lo) sum -= from[drop];
      count--;
    }
    to[i] = sum / count;
  }
  if (midFrom < midTo) {
    const share = 1 / (2 * half + 1);
    const ahead = half;
    const behind = half + 1;
    for (; i < midTo; i++) {
      sum += from[i + ahead];
      sum -= from[i - behind];
      to[i] = sum * share;
    }
    count = 2 * half + 1;
  }
  for (; i < hi; i++) {
    const add = i + half;
    if (add < n) {
      if (add < hi) sum += from[add];
      count++;
    }
    const drop = i - half - 1;
    if (drop >= 0) {
      if (drop >= lo) sum -= from[drop];
      count--;
    }
    to[i] = sum / count;
  }
}

/**
 * A centred moving average of `len` samples, in place, twice (a triangle: lower side lobes), over
 * the samples [lo, hi) of an array of `n`: outside them it holds zeros, or what nobody reads.
 */
function smooth(x: Float64Array, len: number, n: number, lo: number, hi: number) {
  const half = Math.max(1, Math.floor(len / 2));
  runningMean(x, buffers.tmp, half, n, lo, hi);
  runningMean(buffers.tmp, x, half, n, lo, hi);
}

/** How far a smoothing reaches, either way: both of its passes. */
const reachOf = (len: number) => 2 * (Math.max(1, Math.floor(len / 2)) + 1);

/** Where a curve is known among the first `n` samples, as the first and one past the last: [0, 0) when never. */
function supportOf(f: Float64Array, n: number): [number, number] {
  let a = 0;
  while (a < n && !Number.isFinite(f[a])) a++;
  if (a === n) return [0, 0];
  let b = n;
  while (!Number.isFinite(f[b - 1])) b--;
  return [a, b];
}

/** The rotation of harmonic h + 1 from harmonic h's (`cos`, `sin`) and the first harmonic's, over [first, last). */
function nextHarmonic(cos: Float64Array, sin: Float64Array, cos1: Float64Array, sin1: Float64Array, first: number, last: number) {
  for (let i = first; i < last; i++) {
    const c = cos[i];
    const s = sin[i];
    cos[i] = c * cos1[i] - s * sin1[i];
    sin[i] = s * cos1[i] + c * sin1[i];
  }
}

/** The recording with the curves' tones taken out. The input is left as it is. */
export function scrub(samples: Float32Array, sampleRate: number, curves: Curve[], options: ScrubOptions = {}): Float32Array {
  const o = { ...DEFAULTS, ...options };
  const n = samples.length;
  room(n);
  const { out, re, im, weight, on, cos, sin, cos1, sin1 } = buffers;
  out.set(samples);
  const steps = curves.length * (o.fill ? 2 : 1);
  for (const [index, curve] of curves.entries()) {
    o.onStep(index, steps);
    const f = perSample(curve, n, sampleRate, buffers.f);
    const [first, last] = supportOf(f, n);
    if (first === last) continue;
    const width = curve.width ?? o.width;
    rotation(f, sampleRate, first, last);
    for (let h = 1; h <= o.harmonics; h++) {
      if (h > 1) nextHarmonic(cos, sin, cos1, sin1, first, last);
      const len = lengthOf(sampleRate, width, h);
      // The samples this harmonic reads, worked out once for all its passes.
      let any = false;
      for (let i = first; i < last; i++) {
        const here = within(f[i], h, width, 0, sampleRate);
        on[i] = here ? 1 : 0;
        if (here) any = true;
      }
      // Above Nyquist all along: nothing to take out.
      if (!any) continue;
      const reach = reachOf(len);
      const lo = Math.max(0, first - reach);
      const hi = Math.min(n, last + reach);
      weight.fill(0, lo, hi);
      for (let i = first; i < last; i++) weight[i] = on[i];
      smooth(weight, len, n, lo, hi);
      // Dividing by the share of known samples in the window keeps the edges of a stretch from being under-taken.
      const gain = weight;
      for (let i = first; i < last; i++) gain[i] = Number.isFinite(f[i]) && weight[i] >= 0.25 ? 2 / weight[i] : 0;
      for (let pass = 0; pass < o.passes; pass++) {
        // Down to 0 Hz, only where the curve is known (and below Nyquist).
        re.fill(0, lo, hi);
        im.fill(0, lo, hi);
        for (let i = first; i < last; i++) {
          if (!on[i]) continue;
          const x = out[i];
          re[i] = x * cos[i];
          im[i] = -x * sin[i];
        }
        smooth(re, len, n, lo, hi);
        smooth(im, len, n, lo, hi);
        // The tone's amplitude there, back up to its frequency, taken away.
        for (let i = first; i < last; i++) out[i] -= gain[i] * (re[i] * cos[i] - im[i] * sin[i]);
      }
    }
  }
  if (o.fill) fill(out, n, sampleRate, curves, o);
  return new Float32Array(out.subarray(0, n));
}

/** A triangle of total length 2L passes about 1 / L Hz either side: L = rate / (2 width h). */
function lengthOf(rate: number, width: number, h: number) {
  return Math.max(3, Math.round(rate / (2 * width * h)));
}

/** Whether harmonic h of `f`, moved by `by` Hz, keeps its band between 0 Hz and Nyquist. */
function within(f: number, h: number, width: number, by: number, rate: number) {
  return Number.isFinite(f) && h * (f - width) + by > 0 && h * (f + width) + by < rate / 2;
}

/**
 * The fundamental's rotation over [first, last) from its frequency `f`, its phase carried across
 * the gaps so each heard stretch stays in step: every other harmonic's follows from it, with no
 * more sines (`nextHarmonic`).
 */
function rotation(f: Float64Array, rate: number, first: number, last: number) {
  const { cos, sin, cos1, sin1 } = buffers;
  let p = 0;
  for (let i = first; i < last; i++) {
    const fi = f[i];
    if (fi === fi) p += (2 * Math.PI * fi) / rate;
    const c = Math.cos(p);
    const s = Math.sin(p);
    cos1[i] = c;
    sin1[i] = s;
    cos[i] = c;
    sin[i] = s;
  }
}

/** Samples a steady rotation is carried from the last before it is worked out again: the error stays far under what the sound keeps. */
const RESYNC = 1024;

/**
 * Each emptied band filled with noise of its own, at the level of the bands three widths beside
 * it, through the passes' own response (1 - (1 - H)^3, H one smoothing) 1.3 times wider: what is
 * left plus what is added keeps the band's power within about 1.3 dB across its whole width,
 * shoulders included. New noise rather than a copy of what is beside: a band scrubbed again along
 * nearly the same curve adds its powers instead of doubling the same sound. The level is read once
 * every tone is out, so no tone taken out comes back from beside; a band an earlier curve's
 * harmonic already fills (two curves a hertz apart, a harmonic of a subharmonic) is filled once.
 */
function fill(out: Float64Array, n: number, rate: number, curves: Curve[], o: Required<ScrubOptions>) {
  const { re, im, weight, accRe, accIm, level, on, cos, sin, cos1, sin1, cleaned } = buffers;
  // Each is free again at the point it serves here: the share becomes one over it, and the noise's input its output's power.
  const gain = weight;
  const own = re;
  cleaned.set(out.subarray(0, n));
  // The noise's seed comes from the sound: the same file gives the same result, another round other
  // noise. Rounded well above what a float's last bits can move, so they do not make another draw.
  let seed = 0x9e3779b9;
  for (let i = 0; i < n; i += 97) seed = Math.imul(seed ^ Math.round(cleaned[i] * 1e5), 0x85ebca6b) >>> 0;
  // Over half a second the level follows the sound beside, a gust or the plane's own roar.
  const span = Math.max(3, Math.round(rate / 4));
  // Earlier curves' frequencies every BLOCK samples: enough to tell whose band it is.
  const BLOCK = 64;
  const blocks = Math.ceil(n / BLOCK);
  const earlier: Float32Array[] = [];
  const taken = new Uint8Array(blocks);
  for (const [index, curve] of curves.entries()) {
    o.onStep(curves.length + index, 2 * curves.length);
    const f = perSample(curve, n, rate, buffers.f);
    const coarse = new Float32Array(blocks);
    for (let j = 0; j < blocks; j++) coarse[j] = f[Math.min(n - 1, j * BLOCK + (BLOCK >> 1))];
    const [first, last] = supportOf(f, n);
    if (first === last) {
      earlier.push(coarse);
      continue;
    }
    const width = curve.width ?? o.width;
    rotation(f, rate, first, last);
    for (let h = 1; h <= o.harmonics; h++) {
      if (h > 1) nextHarmonic(cos, sin, cos1, sin1, first, last);
      const len = Math.max(3, Math.round(lengthOf(rate, width, h) / 1.3));
      const away = 3 * width * h;
      for (let j = 0; j < blocks; j++) {
        const mine = h * coarse[j];
        let near = 0;
        for (const other of earlier) {
          const k = Math.min(o.harmonics, Math.max(1, Math.round(mine / other[j])));
          if (Math.abs(mine - k * other[j]) < width * Math.max(h, k)) {
            near = 1;
            break;
          }
        }
        taken[j] = near;
      }
      // Everything below reads only near where this harmonic is on: shape's smoothing, then the level's.
      const reach = reachOf(len) + reachOf(span);
      const lo = Math.max(0, first - reach);
      const hi = Math.min(n, last + reach);
      re.fill(0, lo, hi);
      im.fill(0, lo, hi);
      weight.fill(0, lo, hi);
      on.fill(0, lo, hi);
      // At 0 Hz: what is beside, on both sides when it can (independent noise adds its powers).
      let any = false;
      // The band beside turns steadily: from one sample to the next by the same step.
      const turn = (2 * Math.PI * away) / rate;
      const stepCos = Math.cos(turn);
      const stepSin = Math.sin(turn);
      let cs = 0;
      let ss = 0;
      for (let i = first; i < last; i++) {
        if ((i - first) % RESYNC === 0) {
          cs = Math.cos(turn * i);
          ss = Math.sin(turn * i);
        } else {
          const next = cs * stepCos - ss * stepSin;
          ss = ss * stepCos + cs * stepSin;
          cs = next;
        }
        if (taken[(i / BLOCK) | 0] || !within(f[i], h, width, 0, rate)) continue;
        const below = within(f[i], h, width, -away, rate);
        const above = within(f[i], h, width, away, rate);
        if (!below && !above) continue;
        const ca = cos[i];
        const sa = sin[i];
        let x: number;
        let y: number;
        if (below && above) {
          // cos(a - s) + cos(a + s) and sin(a - s) + sin(a + s), with one cosine to work out.
          x = Math.SQRT2 * ca * cs;
          y = -(Math.SQRT2 * sa * cs);
        } else {
          // On one side alone: a - s below, a + s above.
          const sign = below ? 1 : -1;
          x = ca * cs + sign * sa * ss;
          y = -(sa * cs - sign * ca * ss);
        }
        re[i] = cleaned[i] * x;
        im[i] = cleaned[i] * y;
        weight[i] = 1;
        on[i] = 1;
        any = true;
      }
      if (!any) continue;
      smooth(weight, len, n, lo, hi);
      for (let i = lo; i < hi; i++) gain[i] = weight[i] >= 0.25 ? 1 / weight[i] : 0;
      // The power a copy of what is beside would bring, then noise of the same shape brought to it.
      shape(re, im, accRe, accIm, gain, on, len, n, lo, hi);
      for (let i = lo; i < hi; i++) level[i] = accRe[i] * accRe[i] + accIm[i] * accIm[i];
      for (let i = lo; i < hi; i++) {
        if (!on[i]) {
          re[i] = 0;
          im[i] = 0;
          continue;
        }
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const u1 = (seed + 0.5) / TWO_32;
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        re[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos((TWO_PI * seed) / TWO_32);
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const u2 = (seed + 0.5) / TWO_32;
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        im[i] = Math.sqrt(-2 * Math.log(u2)) * Math.cos((TWO_PI * seed) / TWO_32);
      }
      shape(re, im, accRe, accIm, gain, on, len, n, lo, hi);
      for (let i = lo; i < hi; i++) own[i] = accRe[i] * accRe[i] + accIm[i] * accIm[i];
      smooth(level, span, n, lo, hi);
      smooth(own, span, n, lo, hi);
      for (let i = first; i < last; i++) {
        // Running sums can leave a hair below zero where the sound is silent: no noise there.
        if (!on[i] || own[i] < 1e-12 || level[i] <= 0) continue;
        const scale = Math.sqrt(level[i] / own[i]);
        out[i] += 2 * scale * (accRe[i] * cos[i] - accIm[i] * sin[i]);
      }
    }
    earlier.push(coarse);
  }
}

/**
 * (re, im) through 3 H - 3 H^2 + H^3 into (outRe, outIm), each smoothing divided by the share of
 * known samples (`gain`, one over the smoothed share, zero where too little is known), as the
 * passes do. (re, im) are used up.
 */
function shape(re: Float64Array, im: Float64Array, outRe: Float64Array, outIm: Float64Array, gain: Float64Array, on: Uint8Array, len: number, n: number, lo: number, hi: number) {
  smooth(re, len, n, lo, hi);
  smooth(im, len, n, lo, hi);
  for (let i = lo; i < hi; i++) {
    const a = re[i] * gain[i];
    const b = im[i] * gain[i];
    outRe[i] = 3 * a;
    outIm[i] = 3 * b;
    re[i] = on[i] ? a : 0;
    im[i] = on[i] ? b : 0;
  }
  smooth(re, len, n, lo, hi);
  smooth(im, len, n, lo, hi);
  for (let i = lo; i < hi; i++) {
    const a = re[i] * gain[i];
    const b = im[i] * gain[i];
    outRe[i] -= 3 * a;
    outIm[i] -= 3 * b;
    re[i] = on[i] ? a : 0;
    im[i] = on[i] ? b : 0;
  }
  smooth(re, len, n, lo, hi);
  smooth(im, len, n, lo, hi);
  for (let i = lo; i < hi; i++) {
    outRe[i] += re[i] * gain[i];
    outIm[i] += im[i] * gain[i];
  }
}
