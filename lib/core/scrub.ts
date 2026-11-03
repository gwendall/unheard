// Takes the tone of an aircraft out of a recording, along its curve and its harmonics, and
// leaves everything else. colsto's video shows why a high-pass filter is not enough: the tones sit
// where voices are, and boosting the filtered file brings the curve back. Here the tone itself is
// measured and subtracted: each harmonic is brought down to 0 Hz by following the curve's phase,
// smoothed to the band the curve may wander in, and taken away. What a boost then finds is the
// recording's own noise.

/** A tone to take out: its heard fundamental, Hz, at `times` (seconds from the first sample). NaN where it is not heard. */
export type Curve = { times: ArrayLike<number>; freq: ArrayLike<number> };

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
};

const DEFAULTS: Required<ScrubOptions> = { harmonics: 6, width: 3, passes: 3 };

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
    // The fundamental's phase, carried across the gaps so each heard stretch stays in step.
    const phase = new Float64Array(n);
    let p = 0;
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(f[i])) p += (2 * Math.PI * f[i]) / sampleRate;
      phase[i] = p;
    }
    for (let h = 1; h <= o.harmonics; h++) for (let pass = 0; pass < o.passes; pass++) {
      // A triangle of total length 2L passes about 1 / L Hz either side: L = rate / (2 width h).
      const len = Math.max(3, Math.round(sampleRate / (2 * o.width * h)));
      // Down to 0 Hz, only where the curve is known (and below Nyquist).
      for (let i = 0; i < n; i++) {
        const on = Number.isFinite(f[i]) && h * (f[i] + o.width) < sampleRate / 2 ? 1 : 0;
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
  return Float32Array.from(out);
}
