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
};

/** Harmonics taken out by default, the fundamental included. */
export const HARMONICS = 6;

const DEFAULTS: Required<ScrubOptions> = { harmonics: HARMONICS, width: 3, passes: 3, fill: true };

/** The curve's frequency at every sample (NaN where unknown), linearly between its points. */
function perSample(curve: Curve, n: number, rate: number): Float64Array {
  const out = new Float64Array(n).fill(NaN);
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

/** A centred moving average of `len` samples, in place, twice (a triangle: lower side lobes). */
function smooth(x: Float64Array, len: number) {
  const half = Math.max(1, Math.floor(len / 2));
  const tmp = new Float64Array(x.length);
  for (let pass = 0; pass < 2; pass++) {
    let sum = 0;
    let count = 0;
    // Running sum over [i - half, i + half], shrinking at the edges.
    for (let i = 0; i < Math.min(half, x.length); i++) {
      sum += x[i];
      count++;
    }
    for (let i = 0; i < x.length; i++) {
      const add = i + half;
      if (add < x.length) {
        sum += x[add];
        count++;
      }
      const drop = i - half - 1;
      if (drop >= 0) {
        sum -= x[drop];
        count--;
      }
      tmp[i] = sum / count;
    }
    x.set(tmp);
  }
}

/** The recording with the curves' tones taken out. The input is left as it is. */
export function scrub(samples: Float32Array, sampleRate: number, curves: Curve[], options: ScrubOptions = {}): Float32Array {
  const o = { ...DEFAULTS, ...options };
  const n = samples.length;
  const out = Float64Array.from(samples);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const weight = new Float64Array(n);
  for (const curve of curves) {
    const f = perSample(curve, n, sampleRate);
    const phase = phaseOf(f, sampleRate);
    const width = curve.width ?? o.width;
    for (let h = 1; h <= o.harmonics; h++) for (let pass = 0; pass < o.passes; pass++) {
      const len = lengthOf(sampleRate, width, h);
      // Down to 0 Hz, only where the curve is known (and below Nyquist).
      for (let i = 0; i < n; i++) {
        const on = within(f[i], h, width, 0, sampleRate) ? 1 : 0;
        const a = h * phase[i];
        re[i] = on * out[i] * Math.cos(a);
        im[i] = -on * out[i] * Math.sin(a);
        weight[i] = on;
      }
      smooth(re, len);
      smooth(im, len);
      smooth(weight, len);
      // The tone's amplitude there, back up to its frequency, taken away. Dividing by the share of
      // known samples in the window keeps the edges of a stretch from being under-taken.
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(f[i]) || weight[i] < 0.25) continue;
        const a = h * phase[i];
        out[i] -= (2 * (re[i] * Math.cos(a) - im[i] * Math.sin(a))) / weight[i];
      }
    }
  }
  if (o.fill) fill(out, sampleRate, curves, o, re, im, weight);
  return Float32Array.from(out);
}

/** A triangle of total length 2L passes about 1 / L Hz either side: L = rate / (2 width h). */
function lengthOf(rate: number, width: number, h: number) {
  return Math.max(3, Math.round(rate / (2 * width * h)));
}

/** Whether harmonic h of `f`, moved by `by` Hz, keeps its band between 0 Hz and Nyquist. */
function within(f: number, h: number, width: number, by: number, rate: number) {
  return Number.isFinite(f) && h * (f - width) + by > 0 && h * (f + width) + by < rate / 2;
}

/** The fundamental's phase, carried across the gaps so each heard stretch stays in step. */
function phaseOf(f: Float64Array, rate: number): Float64Array {
  const phase = new Float64Array(f.length);
  let p = 0;
  for (let i = 0; i < f.length; i++) {
    if (Number.isFinite(f[i])) p += (2 * Math.PI * f[i]) / rate;
    phase[i] = p;
  }
  return phase;
}

/**
 * Each emptied band filled with noise of its own, at the level of the bands three widths beside
 * it, through the passes' own response (1 - (1 - H)^3, H one smoothing) 1.3 times wider: what is
 * left plus what is added keeps the band's power within about 1.3 dB across its whole width,
 * shoulders included. New noise rather than a copy of what is beside: a band scrubbed again along
 * nearly the same curve adds its powers instead of doubling the same sound. The level is read once
 * every tone is out, so no tone taken out comes back from beside; a band an earlier curve's
 * harmonic already fills (two curves a hertz apart, a harmonic of a subharmonic) is filled once.
 */
function fill(out: Float64Array, rate: number, curves: Curve[], o: Required<ScrubOptions>, re: Float64Array, im: Float64Array, weight: Float64Array) {
  const n = out.length;
  const cleaned = Float32Array.from(out);
  const accRe = new Float64Array(n);
  const accIm = new Float64Array(n);
  const level = new Float64Array(n);
  const own = new Float64Array(n);
  // The noise's seed comes from the sound: the same file gives the same result, another round other noise.
  let seed = 0x9e3779b9;
  for (let i = 0; i < n; i += 97) seed = Math.imul(seed ^ Math.round(cleaned[i] * 1e7), 0x85ebca6b) >>> 0;
  const gauss = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const u = (seed + 0.5) / 2 ** 32;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos((2 * Math.PI * seed) / 2 ** 32);
  };
  // Over half a second the level follows the sound beside, a gust or the plane's own roar.
  const span = Math.max(3, Math.round(rate / 4));
  // Earlier curves' frequencies every BLOCK samples: enough to tell whose band it is.
  const BLOCK = 64;
  const blocks = Math.ceil(n / BLOCK);
  const earlier: Float32Array[] = [];
  for (const curve of curves) {
    const f = perSample(curve, n, rate);
    const phase = phaseOf(f, rate);
    const coarse = Float32Array.from({ length: blocks }, (_, j) => f[Math.min(n - 1, j * BLOCK + (BLOCK >> 1))]);
    const width = curve.width ?? o.width;
    for (let h = 1; h <= o.harmonics; h++) {
      const len = Math.max(3, Math.round(lengthOf(rate, width, h) / 1.3));
      const away = 3 * width * h;
      const taken = Uint8Array.from({ length: blocks }, (_, j) => {
        const mine = h * coarse[j];
        const near = earlier.some((other) => {
          const k = Math.min(o.harmonics, Math.max(1, Math.round(mine / other[j])));
          return Math.abs(mine - k * other[j]) < width * Math.max(h, k);
        });
        return near ? 1 : 0;
      });
      // At 0 Hz: what is beside, on both sides when it can (independent noise adds its powers).
      for (let i = 0; i < n; i++) {
        re[i] = 0;
        im[i] = 0;
        weight[i] = 0;
        if (taken[(i / BLOCK) | 0] || !within(f[i], h, width, 0, rate)) continue;
        const below = within(f[i], h, width, -away, rate);
        const above = within(f[i], h, width, away, rate);
        if (!below && !above) continue;
        const share = 1 / Math.sqrt(Number(below) + Number(above));
        const a = h * phase[i];
        const shift = (2 * Math.PI * away * i) / rate;
        let x = 0;
        let y = 0;
        if (below) {
          x += Math.cos(a - shift);
          y -= Math.sin(a - shift);
        }
        if (above) {
          x += Math.cos(a + shift);
          y -= Math.sin(a + shift);
        }
        re[i] = share * cleaned[i] * x;
        im[i] = share * cleaned[i] * y;
        weight[i] = 1;
      }
      const on = Uint8Array.from(weight);
      smooth(weight, len);
      // The power a copy of what is beside would bring, then noise of the same shape brought to it.
      shape(re, im, accRe, accIm, weight, on, len);
      for (let i = 0; i < n; i++) level[i] = accRe[i] ** 2 + accIm[i] ** 2;
      for (let i = 0; i < n; i++) {
        re[i] = on[i] ? gauss() : 0;
        im[i] = on[i] ? gauss() : 0;
      }
      shape(re, im, accRe, accIm, weight, on, len);
      for (let i = 0; i < n; i++) own[i] = accRe[i] ** 2 + accIm[i] ** 2;
      smooth(level, span);
      smooth(own, span);
      for (let i = 0; i < n; i++) {
        // Running sums can leave a hair below zero where the sound is silent: no noise there.
        if (!on[i] || own[i] < 1e-12 || level[i] <= 0) continue;
        const a = h * phase[i];
        const gain = Math.sqrt(level[i] / own[i]);
        out[i] += 2 * gain * (accRe[i] * Math.cos(a) - accIm[i] * Math.sin(a));
      }
    }
    earlier.push(coarse);
  }
}

/**
 * (re, im) through 3 H - 3 H^2 + H^3 into (outRe, outIm), each smoothing divided by the share of
 * known samples (`weight`, already smoothed), as the passes do. (re, im) are used up.
 */
function shape(re: Float64Array, im: Float64Array, outRe: Float64Array, outIm: Float64Array, weight: Float64Array, on: Uint8Array, len: number) {
  const n = re.length;
  outRe.fill(0);
  outIm.fill(0);
  for (const [k, c] of [[1, 3], [2, -3], [3, 1]]) {
    smooth(re, len);
    smooth(im, len);
    for (let i = 0; i < n; i++) {
      const w = weight[i] >= 0.25 ? 1 / weight[i] : 0;
      re[i] *= w;
      im[i] *= w;
      outRe[i] += c * re[i];
      outIm[i] += c * im[i];
      if (k < 3 && !on[i]) re[i] = im[i] = 0;
    }
  }
}
