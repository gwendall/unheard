// Resampling without the browser: the evals, the tests and the check page's worker (where no
// OfflineAudioContext exists) read every recording down to ANALYSIS_RATE through this one kernel.

/** The kernel's reach, in input samples either side. */
const HALF = 32;
const TAPS = 2 * HALF;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** The kernel at one fractional position: `TAPS` weights from input sample k0 - HALF + 1, into `out` at `at`. */
function kernelAt(frac: number, cutoff: number, out: Float64Array, at: number) {
  for (let j = 0; j < TAPS; j++) {
    const t = frac + HALF - 1 - j;
    const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / HALF) + 0.08 * Math.cos((2 * Math.PI * t) / HALF);
    const arg = Math.PI * cutoff * t;
    out[at + j] = cutoff * (arg === 0 ? 1 : Math.sin(arg) / arg) * w;
  }
}

/**
 * `count` samples at rate `to`, the first at position `at` of `input` (in input samples, may be
 * fractional), by a windowed sinc (Blackman, 32 input samples each side), anti-aliased below
 * 0.45 x the lower rate. Outside `input` counts as silence.
 *
 * Two whole rates repeat the same fractional positions: from 48 kHz to 8 kHz one single kernel,
 * worked out once for the whole read instead of for each sample.
 */
export function resampleAt(input: Float32Array, from: number, to: number, at: number, count: number): Float32Array {
  const ratio = to / from;
  const cutoff = Math.min(1, ratio) * 0.9; // of the input Nyquist
  const out = new Float32Array(Math.max(0, count));
  const whole = Number.isInteger(from) && Number.isInteger(to) && from > 0 && to > 0;
  const g = whole ? gcd(from, to) : 1;
  // Positions repeat every `period` output samples, `stride` input samples further on.
  const period = whole && to / g <= 4096 ? to / g : 0;
  const stride = whole ? from / g : 0;
  const n = input.length;
  if (period) {
    const kernels = new Float64Array(period * TAPS);
    const first = new Float64Array(period);
    for (let p = 0; p < period; p++) {
      const x = at + (p * from) / to;
      const k0 = Math.floor(x);
      first[p] = k0;
      kernelAt(x - k0, cutoff, kernels, p * TAPS);
    }
    for (let i = 0; i < out.length; i++) {
      const p = i % period;
      const lo = first[p] + ((i - p) / period) * stride - HALF + 1;
      const base = p * TAPS - lo;
      const a = Math.max(lo, 0);
      const b = Math.min(lo + TAPS, n);
      let sum = 0;
      for (let k = a; k < b; k++) sum += input[k] * kernels[base + k];
      out[i] = sum;
    }
    return out;
  }
  const kernel = new Float64Array(TAPS);
  for (let i = 0; i < out.length; i++) {
    const x = at + i / ratio;
    const k0 = Math.floor(x);
    kernelAt(x - k0, cutoff, kernel, 0);
    const lo = k0 - HALF + 1;
    const a = Math.max(lo, 0);
    const b = Math.min(lo + TAPS, n);
    let sum = 0;
    for (let k = a; k < b; k++) sum += input[k] * kernel[k - lo];
    out[i] = sum;
  }
  return out;
}

/** The whole of `input` at rate `to`. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  return resampleAt(input, from, to, 0, Math.floor(input.length * (to / from)));
}

/** Input samples a read at `at` needs on either side of its own span. */
export const RESAMPLE_REACH = HALF;
