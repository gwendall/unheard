// In-place iterative FFT. Sizes are powers of two; tables are built once per size. Two radix-2
// stages at a time (a radix-4 butterfly over bit-reversed data): a quarter fewer multiplications
// and half the passes over memory.

type Plan = { cos: Float64Array; sin: Float64Array; rev: Uint32Array };
const plans = new Map<number, Plan>();

function plan(n: number): Plan {
  const cached = plans.get(n);
  if (cached) return cached;
  if (n < 1 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${n}`);
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  // Three quarters of the circle: the radix-4 butterfly reads angles up to 3/4 of a turn.
  const size = Math.ceil((3 * n) / 4) + 1;
  const cos = new Float64Array(size);
  const sin = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const made = { cos, sin, rev };
  plans.set(n, made);
  return made;
}

/** Forward transform of (re, im), in place. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n === 1) return;
  const { cos, sin, rev } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  // An odd number of stages: one plain stage first.
  let size = 1;
  if (Math.log2(n) % 2 === 1) {
    for (let a = 0; a < n; a += 2) {
      const b = a + 1;
      const xr = re[b];
      const xi = im[b];
      re[b] = re[a] - xr;
      im[b] = im[a] - xi;
      re[a] += xr;
      im[a] += xi;
    }
    size = 2;
  }
  // Stages of sizes 2 size and 4 size merged.
  for (; size < n; size *= 4) {
    const quarter = size;
    const step = n / (4 * size);
    for (let start = 0; start < n; start += 4 * size) {
      for (let k = 0; k < quarter; k++) {
        const i0 = start + k;
        const i1 = i0 + quarter;
        const i2 = i1 + quarter;
        const i3 = i2 + quarter;
        const t1 = 2 * k * step;
        const t2 = k * step;
        const t3 = 3 * k * step;
        const r1 = re[i1] * cos[t1] - im[i1] * sin[t1];
        const m1 = re[i1] * sin[t1] + im[i1] * cos[t1];
        const r2 = re[i2] * cos[t2] - im[i2] * sin[t2];
        const m2 = re[i2] * sin[t2] + im[i2] * cos[t2];
        const r3 = re[i3] * cos[t3] - im[i3] * sin[t3];
        const m3 = re[i3] * sin[t3] + im[i3] * cos[t3];
        const a0r = re[i0] + r1;
        const a0i = im[i0] + m1;
        const a1r = re[i0] - r1;
        const a1i = im[i0] - m1;
        const a2r = r2 + r3;
        const a2i = m2 + m3;
        const a3r = r2 - r3;
        const a3i = m2 - m3;
        re[i0] = a0r + a2r;
        im[i0] = a0i + a2i;
        re[i2] = a0r - a2r;
        im[i2] = a0i - a2i;
        // Times -i for the second half of the outer stage.
        re[i1] = a1r + a3i;
        im[i1] = a1i - a3r;
        re[i3] = a1r - a3i;
        im[i3] = a1i + a3r;
      }
    }
  }
}

type RealPlan = { cos: Float64Array; sin: Float64Array; zr: Float64Array; zi: Float64Array };
const realPlans = new Map<number, RealPlan>();

function realPlan(n: number): RealPlan {
  let p = realPlans.get(n);
  if (p) return p;
  const half = n >> 1;
  const cos = new Float64Array(half + 1);
  const sin = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = -Math.sin((2 * Math.PI * k) / n);
  }
  p = { cos, sin, zr: new Float64Array(half), zi: new Float64Array(half) };
  realPlans.set(n, p);
  return p;
}

/**
 * The transform of `x` (real, length n, a power of two): bins 0 to n / 2 into (re, im), which hold
 * n / 2 + 1 values. Half the work of the complex transform: even samples as the real part, odd ones
 * as the imaginary part, then each half's spectrum told apart.
 */
export function realFft(x: Float64Array, re: Float64Array, im: Float64Array): void {
  const n = x.length;
  const half = n >> 1;
  const { cos, sin, zr, zi } = realPlan(n);
  for (let i = 0; i < half; i++) {
    zr[i] = x[2 * i];
    zi[i] = x[2 * i + 1];
  }
  fft(zr, zi);
  re[0] = zr[0] + zi[0];
  im[0] = 0;
  re[half] = zr[0] - zi[0];
  im[half] = 0;
  for (let k = 1; k < half; k++) {
    const j = half - k;
    const er = 0.5 * (zr[k] + zr[j]);
    const ei = 0.5 * (zi[k] - zi[j]);
    const or = 0.5 * (zi[k] + zi[j]);
    const oi = 0.5 * (zr[j] - zr[k]);
    re[k] = er + or * cos[k] - oi * sin[k];
    im[k] = ei + or * sin[k] + oi * cos[k];
  }
}
