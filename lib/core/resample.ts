// Resampling without the browser: the evals, the tests and the check page's worker (where no
// OfflineAudioContext exists) read every recording down to ANALYSIS_RATE through this one kernel.

/** The kernel's reach, in input samples either side. */
const HALF = 32;

/**
 * `count` samples at rate `to`, the first at position `at` of `input` (in input samples, may be
 * fractional), by a windowed sinc (Blackman, 32 input samples each side), anti-aliased below
 * 0.45 x the lower rate. Outside `input` counts as silence.
 */
export function resampleAt(input: Float32Array, from: number, to: number, at: number, count: number): Float32Array {
  const ratio = to / from;
  const cutoff = Math.min(1, ratio) * 0.9; // of the input Nyquist
  const out = new Float32Array(Math.max(0, count));
  for (let i = 0; i < out.length; i++) {
    const x = at + i / ratio;
    const k0 = Math.floor(x);
    let sum = 0;
    for (let k = k0 - HALF + 1; k <= k0 + HALF; k++) {
      if (k < 0 || k >= input.length) continue;
      const t = x - k;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / HALF) + 0.08 * Math.cos((2 * Math.PI * t) / HALF);
      const arg = Math.PI * cutoff * t;
      sum += input[k] * cutoff * (arg === 0 ? 1 : Math.sin(arg) / arg) * w;
    }
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
