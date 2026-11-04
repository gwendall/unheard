// Blind traces: the falling tones of aircraft found in the sound alone, with no flight data. A
// ridge follower runs over the evidence stack (dynamic programming over frames on a
// log-frequency grid, with harmonic support and a bounded slope and bend) and keeps the ridges
// that stand out from the same search on scrambled copies of the recording. What it returns is
// what anyone holding the recording could see in it: locate (where was the phone?) fits these
// traces to the flight tracks, and a privacy check (does my video give away where I am?) can
// say from them alone whether a recording holds a locating tone.

import type { Stack } from "./spectrogram";

export type TraceOptions = {
  /** Lowest and highest tone followed, Hz. Propellers and rotors sit below 400 Hz. */
  fMin?: number;
  fMax?: number;
  /** Relative step of the log-frequency grid: 0.25 % is about the evidence map's tolerance. */
  step?: number;
  /** Relative weight of the tone and its first harmonics. */
  harmonics?: number[];
  /** Fastest fall followed, relative per second (an aircraft passing 200 m away at 80 m/s: 0.09). */
  maxFall?: number;
  /** Fastest rise followed, relative per second (turns, wind, the grid's own jitter). */
  maxRise?: number;
  /** What each frame of a trace must beat on average, in evidence units, to lengthen it. */
  bias?: number;
  /** Cost of bending the trace by one grid step per frame, in evidence units. */
  bend?: number;
  /** Shortest trace kept, seconds. */
  minSeconds?: number;
  /** Most traces returned. */
  maxTraces?: number;
  /** Largest fall along one trace: (c + v) / (c - v) is 2.2 at 130 m/s. */
  maxRatio?: number;
  /** Smallest change of pitch along a trace (highest over lowest). */
  minFall?: number;
  /** Traces below this confidence are dropped. */
  minConfidence?: number;
  /**
   * A loud ridge is cut back to its stretch above `trimShare` of its strong frames (their
   * evidence averaged over 2 s): past where its tone fades it drifts on along the noise or a
   * neighbouring tone nearly for free. Loud: that floor reaches `trim`. trimShare 0: no cut.
   */
  trim?: number;
  trimShare?: number;
  /** Scrambled copies searched for the null, and the frames each scrambled block keeps together. */
  nulls?: number;
  block?: number;
};

export type Trace = {
  /** First and last base frame of the trace, inclusive. */
  from: number;
  to: number;
  /** Per base frame (stack.base.times), the tone's frequency in Hz; NaN outside the trace. */
  freq: Float32Array;
  /** Per base frame, the harmonic evidence along the trace; NaN outside. */
  strength: Float32Array;
  /** Sum of (evidence - bias) along the trace, less its bends. */
  score: number;
  /** How far the score stands above the best traces of scrambled copies, in their spreads. */
  confidence: number;
  /** Seconds the trace lasts. */
  seconds: number;
  /** Frequency at the start over frequency at the end: about (c + v) / (c - v) for a whole pass. */
  fall: number;
};

export type Traces = {
  /** Strongest first. */
  traces: Trace[];
  /** Best scores of the scrambled copies: their median and spread. */
  null: { mid: number; spread: number };
};

/** Where to look in a real recording: up to 3.4 kHz, a jet's fan tones sit above 2 kHz while it comes in (evals/trace). */
export const REAL_RANGE: TraceOptions = { fMin: 40, fMax: 3400 };

const DEFAULTS: Required<TraceOptions> = {
  fMin: 40,
  fMax: 400,
  step: 0.0025,
  harmonics: [1, 0.6, 0.4],
  maxFall: 0.12,
  maxRise: 0.02,
  bias: 1.2,
  bend: 0.3,
  minSeconds: 10,
  maxTraces: 4,
  maxRatio: 2.2,
  minFall: 1.03,
  minConfidence: 4,
  trim: 1.4,
  trimShare: 0.6,
  nulls: 4,
  block: 8,
};

/** Confidence from which a ridge is taken out of the scrambles of the second null. */
const STAND = 4;

/** Frequency ratios masked around a found trace so the next search finds another source. */
const KIN = [1 / 3, 1 / 2, 2 / 3, 1, 3 / 2, 2, 3];

type Grid = {
  /** Frames, grid bins, slope states. */
  K: number;
  B: number;
  S: number;
  /** Slope of state s, in grid bins per frame: s + lowest. */
  lowest: number;
  freqs: Float64Array;
  /** Harmonic evidence per frame, layer and bin: G[(k * layers + l) * B + b]. */
  G: Float32Array;
  layers: number;
  /** Layer read by slope state s at bin b: L[s * B + b]. */
  L: Uint8Array;
  /** Per slope state, stretches of bins read from one layer: [from, to, layer, ...]. */
  runs: Int32Array[];
  /** Per layer, the bins some state reads from it: [from, to). A row of the search holds no others. */
  span: Int32Array;
};

function gridOf(stack: Stack, o: Required<TraceOptions>): Grid {
  const { base, layers } = stack;
  const K = base.frames;
  const hop = K > 1 ? base.times[1] - base.times[0] : 0.25;
  const lnStep = Math.log1p(o.step);
  const B = Math.max(1, Math.floor(Math.log(o.fMax / o.fMin) / lnStep) + 1);
  const freqs = new Float64Array(B);
  for (let b = 0; b < B; b++) freqs[b] = o.fMin * Math.exp(b * lnStep);
  const fall = Math.ceil((o.maxFall * hop) / o.step);
  const rise = Math.ceil((o.maxRise * hop) / o.step);
  const S = fall + rise + 1;
  const lowest = -fall;
  const nl = layers.length;
  const top = nl - 1;
  const w0 = Math.log2(layers[0].window);
  // The layer whose window suits the slope: about 1 / sqrt(slope in Hz/s), as the matcher reads it.
  const L = new Uint8Array(S * B);
  for (let s = 0; s < S; s++) {
    for (let b = 0; b < B; b++) {
      const hzPerS = (Math.abs(s + lowest) * o.step * freqs[b]) / hop;
      const li = hzPerS > 0 ? Math.round(w0 + 0.5 * Math.log2(hzPerS)) : 0;
      L[s * B + b] = Math.min(top, Math.max(0, li));
    }
  }
  const runs: Int32Array[] = [];
  const span = new Int32Array(2 * nl);
  for (let l = 0; l < nl; l++) span[2 * l] = B;
  for (let s = 0; s < S; s++) {
    const run: number[] = [];
    for (let b = 0; b < B; ) {
      const l = L[s * B + b];
      let e = b + 1;
      while (e < B && L[s * B + e] === l) e++;
      run.push(b, e, l);
      span[2 * l] = Math.min(span[2 * l], b);
      span[2 * l + 1] = Math.max(span[2 * l + 1], e);
      b = e;
    }
    runs.push(Int32Array.from(run));
  }
  // Harmonic h of a tone read at layer l moves h times faster: its own layer is about
  // 0.5 * log2(h) further down the stack. Which bin each grid bin reads there is worked out once.
  const norm = Math.sqrt(o.harmonics.reduce((a, w) => a + w * w, 0));
  const G = new Float32Array(K * nl * B);
  const H = o.harmonics.length;
  const atOf = new Map<number, { at: Int32Array; first: number; last: number }>();
  const readsOf = (li: number, h: number) => {
    const key = li * H + h;
    let r = atOf.get(key);
    if (r) return r;
    const { bins, binHz, minHz } = layers[li].spec;
    const at = new Int32Array(B);
    let first = B;
    let last = 0;
    for (let b = 0; b < B; b++) {
      at[b] = Math.round(((h + 1) * freqs[b] - minHz) / binHz);
      if (at[b] >= 0 && at[b] < bins) {
        first = Math.min(first, b);
        last = b + 1;
      }
    }
    r = { at, first, last };
    atOf.set(key, r);
    return r;
  };
  const sources = Array.from({ length: nl }, (_, l) =>
    o.harmonics.map((weight, h) => {
      const li = Math.min(top, l + Math.round(0.5 * Math.log2(h + 1)));
      return { weight, layer: layers[li], ...readsOf(li, h) };
    }),
  );
  const sums = new Float64Array(B);
  for (let k = 0; k < K; k++) {
    for (let l = 0; l < nl; l++) {
      const o2 = (k * nl + l) * B;
      sums.fill(0);
      for (const { weight, layer, at, first, last } of sources[l]) {
        const e = layer.evidence;
        const row = layer.index[k] * layer.spec.bins;
        for (let b = first; b < last; b++) sums[b] += weight * e[row + at[b]];
      }
      for (let b = 0; b < B; b++) G[o2 + b] = sums[b] / norm;
    }
  }
  return { K, B, S, lowest, freqs, G, layers: nl, L, runs, span };
}

type Path = { score: number; from: number; to: number; bins: Int32Array; gains: Float32Array };

/** The margin each side of the search's rows: more grid bins than any state's slope moves per frame. */
const padOf = (g: Grid) => g.S + 1;

/** The search's buffers, kept from one search to the next: a recording takes up to 19 of them. */
type Work = { V: Float32Array; W: Float32Array; rows: Float32Array; back: Int8Array | null };

const workOf = (g: Grid): Work => {
  const size = (g.S + 2) * (g.B + 2 * padOf(g));
  return { V: new Float32Array(size), W: new Float32Array(size), rows: new Float32Array(g.layers * g.B), back: null };
};

/** One frame's gain (evidence - bias) per layer and bin, scrambled and masked once. */
function rowsOf(g: Grid, o: Required<TraceOptions>, rows: Float32Array, k: number, mask: Uint8Array | null, rot: number) {
  const { B, G, layers, span } = g;
  const bias = o.bias;
  const base = k * layers * B;
  const row = k * B;
  for (let l = 0; l < layers; l++) {
    const off = l * B;
    const src = base + off;
    const from = span[2 * l];
    const to = span[2 * l + 1];
    if (!mask && !rot) {
      for (let b = from; b < to; b++) rows[off + b] = G[src + b] - bias;
      continue;
    }
    for (let b = from; b < to; b++) {
      let read = b + rot;
      if (read >= B) read -= B;
      rows[off + b] = mask && mask[row + read] === 1 ? -2 * bias : G[src + read] - bias;
    }
  }
}

/**
 * The best score alone, as `bestPath` finds it, for the scrambled copies: no way back to keep. `V`
 * and `W` hold a slope state per row with margins that never fill, so a path cannot step off the
 * grid and no cell has to check.
 */
function bestScore(g: Grid, o: Required<TraceOptions>, work: Work, mask: Uint8Array | null, shift: Int32Array | null): number {
  const { K, B, S, lowest, runs } = g;
  const { rows } = work;
  let { V, W } = work;
  const pad = padOf(g);
  const stride = B + 2 * pad;
  V.fill(-Infinity);
  W.fill(-Infinity);
  const bend = o.bend;
  let best = 0;
  for (let k = 0; k < K; k++) {
    rowsOf(g, o, rows, k, mask, shift ? shift[k] : 0);
    for (let s = 0; s < S; s++) {
      const slope = s + lowest;
      const at = (s + 1) * stride + pad;
      const run = runs[s];
      for (let r = 0; r < run.length; r += 3) {
        const to = run[r + 1];
        const off = run[r + 2] * B;
        for (let b = run[r]; b < to; b++) {
          const pb = at + b - slope;
          let prev = 0;
          const same = V[pb];
          if (same > prev) prev = same;
          const down = V[pb - stride] - bend;
          if (down > prev) prev = down;
          const up = V[pb + stride] - bend;
          if (up > prev) prev = up;
          const v = prev + rows[off + b];
          W[at + b] = v;
          if (v > best) best = v;
        }
      }
    }
    const t = V;
    V = W;
    W = t;
  }
  return best;
}

/**
 * The best-scoring ridge, local-alignment style: a trace may start and end at any frame, its
 * score is the sum of (evidence - bias) along it less the bends, and it never goes below zero.
 * `mask` blanks cells already taken by a trace.
 */
function bestPath(g: Grid, o: Required<TraceOptions>, work: Work, mask: Uint8Array | null): Path | null {
  const { K, B, S, lowest, G, L, layers, runs } = g;
  const NS = B * S;
  const { rows } = work;
  let { V, W } = work;
  const pad = padOf(g);
  const stride = B + 2 * pad;
  V.fill(-Infinity);
  W.fill(-Infinity);
  // Per frame and state: which slope state the trace came from, or -1 where it started.
  const back = (work.back ??= new Int8Array(K * NS));
  let best = 0;
  let bestK = -1;
  let bestState = -1;
  const bend = o.bend;
  for (let k = 0; k < K; k++) {
    rowsOf(g, o, rows, k, mask, 0);
    const back0 = k * NS;
    for (let s = 0; s < S; s++) {
      const slope = s + lowest;
      const at = (s + 1) * stride + pad;
      const sB = s * B;
      const run = runs[s];
      for (let r = 0; r < run.length; r += 3) {
        const to = run[r + 1];
        const off = run[r + 2] * B;
        for (let b = run[r]; b < to; b++) {
          const pb = at + b - slope;
          let prev = 0;
          let from = -1;
          const same = V[pb];
          if (same > prev) {
            prev = same;
            from = s;
          }
          const down = V[pb - stride] - bend;
          if (down > prev) {
            prev = down;
            from = s - 1;
          }
          const up = V[pb + stride] - bend;
          if (up > prev) {
            prev = up;
            from = s + 1;
          }
          const v = prev + rows[off + b];
          W[at + b] = v;
          back[back0 + sB + b] = from;
          if (v > best) {
            best = v;
            bestK = k;
            bestState = sB + b;
          }
        }
      }
    }
    const t = V;
    V = W;
    W = t;
  }
  if (bestK < 0) return null;
  // Walk back from the best end to where the trace started.
  const bins: number[] = [];
  const gains: number[] = [];
  let k = bestK;
  let state = bestState;
  for (;;) {
    const s = Math.floor(state / B);
    const b = state - s * B;
    bins.push(b);
    gains.push(mask?.[k * B + b] ? NaN : G[(k * layers + L[state]) * B + b]);
    const from = back[k * NS + state];
    if (from < 0 || k === 0) break;
    state = from * B + (b - (s + lowest));
    k--;
  }
  bins.reverse();
  gains.reverse();
  return { score: best, from: k, to: bestK, bins: Int32Array.from(bins), gains: Float32Array.from(gains) };
}

/**
 * The stretch of a loud ridge worth keeping, as [first, last] indices into its per-frame evidence:
 * the stretch that most exceeds a floor at `share` of its strong frames (the 90th percentile of its
 * evidence averaged over `half` frames either side), by the same local alignment as the search.
 * A loud tone that fades (a jet's fan once it has passed) leaves the follower drifting on along
 * weaker cells nearly for free. A ridge whose floor stays under `least` is not loud: kept whole.
 */
export function strongestStretch(gains: ArrayLike<number>, least: number, share: number, half: number): [number, number] {
  const n = gains.length;
  const g = Float64Array.from(gains, (x) => (Number.isFinite(x) ? x : 0));
  if (share <= 0 || n === 0) return [0, n - 1];
  const sums = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sums[i + 1] = sums[i] + g[i];
  const means = Array.from({ length: n }, (_, i) => {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    return (sums[b] - sums[a]) / (b - a);
  }).sort((x, y) => x - y);
  const floor = share * means[Math.floor(0.9 * (n - 1))];
  if (floor < least) return [0, n - 1];
  let best = 0;
  let run = 0;
  let start = 0;
  let first = 0;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (run <= 0) [run, start] = [0, i];
    run += g[i] - floor;
    if (run > best) [best, first, last] = [run, start, i];
  }
  return [first, last];
}

function trimmed(path: Path, least: number, share: number, half: number): Path {
  const [a, b] = strongestStretch(path.gains, least, share, half);
  if (a === 0 && b === path.bins.length - 1) return path;
  return { ...path, from: path.from + a, to: path.from + b, bins: path.bins.slice(a, b + 1), gains: path.gains.slice(a, b + 1) };
}

/** A small deterministic generator for the scrambles: the same recording gives the same null. */
function scrambles(K: number, B: number, n: number, block: number): Int32Array[] {
  let a = 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: n }, () => {
    const shift = new Int32Array(K);
    let r = 0;
    for (let k = 0; k < K; k++) {
      if (k % block === 0) r = Math.floor(next() * B);
      shift[k] = r;
    }
    return shift;
  });
}

function spreadOf(scores: number[]): { mid: number; spread: number } {
  const sorted = [...scores].sort((x, y) => x - y);
  const mid = sorted[sorted.length >> 1] ?? 0;
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
  const sd = Math.sqrt(sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, sorted.length - 1));
  // A handful of scrambles gives a rough spread: never trust it below a tenth of the median.
  return { mid, spread: Math.max(sd, 0.1 * mid, 1e-6) };
}

/**
 * Finds the tones in a recording, strongest first. Needs no flight data: what it returns is what
 * anyone holding the recording could see in it.
 */
export function findTraces(stack: Stack, options: TraceOptions = {}, onProgress?: (share: number) => void): Traces {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) } as Required<TraceOptions>;
  const g = gridOf(stack, o);
  const { K, B, freqs } = g;
  const hop = K > 1 ? stack.base.times[1] - stack.base.times[0] : 0.25;
  const minFrames = Math.ceil(o.minSeconds / hop);
  const lnStep = Math.log1p(o.step);
  const reach = Math.ceil(0.006 / o.step);
  const kin = KIN.map((ratio) => Math.round(Math.log(ratio) / lnStep));
  const addTo = (mask: Uint8Array, path: Path) => {
    // The ridge, its harmonics and subharmonics, a few grid steps either side.
    for (let i = 0; i < path.bins.length; i++) {
      const row = (path.from + i) * B;
      for (const d of kin) {
        const c = path.bins[i] + d;
        const last = Math.min(B - 1, c + reach);
        for (let b = Math.max(0, c - reach); b <= last; b++) mask[row + b] = 1;
      }
    }
  };
  const work = workOf(g);

  // The null: the best ridge of scrambled copies (each block of frames turned by its own random
  // step along the frequency axis), so tones no longer line up across blocks but the noise keeps
  // its texture.
  const shifts = scrambles(K, B, o.nulls, o.block);
  // Each pass over the grid costs about the same: the null twice, and a few ridges.
  const passes = 2 * o.nulls + 3;
  let passed = 0;
  const onePass = () => onProgress?.(Math.min(1, ++passed / passes));
  const nullWith = (mask: Uint8Array | null) =>
    spreadOf(
      shifts.map((shift) => {
        const score = bestScore(g, o, work, mask, shift);
        onePass();
        return score;
      }),
    );
  let nul = nullWith(null);

  // Ridges, best first: each one found is masked before looking for the next, until they no
  // longer stand out (half the bar: the second null below may lift them).
  const found: Path[] = [];
  let taken: Uint8Array | null = null;
  for (let attempt = 0; attempt < o.maxTraces + 2; attempt++) {
    const path = bestPath(g, o, work, taken);
    onePass();
    if (!path || (path.score - nul.mid) / nul.spread < o.minConfidence / 2) break;
    found.push(path);
    addTo((taken ??= new Uint8Array(K * B)), path);
  }
  // A loud tone lends its blocks to the scrambles and lifts the null: search them again with the
  // ridges that stood out masked.
  const standing = found.filter((p) => (p.score - nul.mid) / nul.spread >= STAND);
  if (standing.length) {
    const mask = new Uint8Array(K * B);
    for (const p of standing) addTo(mask, p);
    nul = nullWith(mask);
  }

  const half = Math.round(1 / hop);
  const traces: Trace[] = [];
  for (const ridge of found) {
    const confidence = (ridge.score - nul.mid) / nul.spread;
    if (confidence < o.minConfidence) continue;
    const path = trimmed(ridge, o.trim, o.trimShare, half);
    if (path.bins.length < minFrames) continue;
    let top = 0;
    let low = Infinity;
    for (const b of path.bins) {
      top = Math.max(top, freqs[b]);
      low = Math.min(low, freqs[b]);
    }
    // One aircraft's tone falls at most by (c + v) / (c - v): more is a ridge hopping between tones.
    if (top / low > o.maxRatio) continue;
    // A tone that barely moves says nothing of where it was heard from, and the noise makes those.
    if (top / low < o.minFall) continue;
    // And a pass ends lower than it began: of 184 right traces in the evals of 2026-11-03, none
    // ended within 3 % of its start or above it; of 391 others, 92 did.
    const fall = freqs[path.bins[0]] / freqs[path.bins[path.bins.length - 1]];
    if (fall < o.minFall) continue;
    const freq = new Float32Array(K).fill(NaN);
    const strength = new Float32Array(K).fill(NaN);
    for (let i = 0; i < path.bins.length; i++) {
      freq[path.from + i] = freqs[path.bins[i]];
      strength[path.from + i] = path.gains[i];
    }
    traces.push({ from: path.from, to: path.to, freq, strength, score: path.score, confidence, seconds: (path.to - path.from + 1) * hop, fall });
    if (traces.length === o.maxTraces) break;
  }
  onProgress?.(1);
  return { traces, null: nul };
}

/**
 * How well a trace follows a modelled curve (heard / emitted factor per base frame, NaN where
 * unknown): the emitted tone in closed form (the median of the log residuals) and the median
 * distance to it, relative. Frames the curve does not cover are left out and counted.
 */
export function traceFit(trace: Trace, factor: ArrayLike<number>): { f0: number; misfit: number; covered: number } {
  const r: number[] = [];
  for (let k = trace.from; k <= trace.to; k++) if (Number.isFinite(factor[k]) && factor[k] > 0) r.push(Math.log(trace.freq[k] / factor[k]));
  if (!r.length) return { f0: NaN, misfit: Infinity, covered: 0 };
  r.sort((a, b) => a - b);
  const m = r[r.length >> 1];
  const d = r.map((x) => Math.abs(x - m)).sort((a, b) => a - b);
  return { f0: Math.exp(m), misfit: d[d.length >> 1], covered: r.length / (trace.to - trace.from + 1) };
}
