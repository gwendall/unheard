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
  // Harmonic h of a tone read at layer l moves h times faster: its own layer is about
  // 0.5 * log2(h) further down the stack.
  const norm = Math.sqrt(o.harmonics.reduce((a, w) => a + w * w, 0));
  const G = new Float32Array(K * nl * B);
  for (let k = 0; k < K; k++) {
    for (let l = 0; l < nl; l++) {
      const o2 = (k * nl + l) * B;
      for (let b = 0; b < B; b++) {
        let sum = 0;
        for (let h = 0; h < o.harmonics.length; h++) {
          const layer = layers[Math.min(top, l + Math.round(0.5 * Math.log2(h + 1)))];
          const { bins, binHz, minHz } = layer.spec;
          const j = Math.round(((h + 1) * freqs[b] - minHz) / binHz);
          if (j >= 0 && j < bins) sum += o.harmonics[h] * layer.evidence[layer.index[k] * bins + j];
        }
        G[o2 + b] = sum / norm;
      }
    }
  }
  return { K, B, S, lowest, freqs, G, layers: nl, L };
}

type Path = { score: number; from: number; to: number; bins: Int32Array; gains: Float32Array };

/**
 * The best-scoring ridge, local-alignment style: a trace may start and end at any frame, its
 * score is the sum of (evidence - bias) along it less the bends, and it never goes below zero.
 * `shift` scrambles the grid (bin b of frame k reads bin b + shift[k]) for the null; `mask`
 * blanks cells already taken by a trace.
 */
function bestPath(g: Grid, o: Required<TraceOptions>, mask: Uint8Array, shift: Int32Array | null): Path | null {
  const { K, B, S, lowest, G, L, layers } = g;
  const NS = B * S;
  let V = new Float32Array(NS).fill(-Infinity);
  let W = new Float32Array(NS);
  // Per frame and state: which slope state the trace came from, or -1 where it started.
  const back = new Int8Array(K * NS);
  let best = 0;
  let bestK = -1;
  let bestState = -1;
  // This frame's gain (evidence - bias) per layer and bin, scrambled and masked once.
  const rows = new Float32Array(layers * B);
  const bend = o.bend;
  for (let k = 0; k < K; k++) {
    const rot = shift ? shift[k] : 0;
    const base = k * layers * B;
    for (let b = 0; b < B; b++) {
      let read = b + rot;
      if (read >= B) read -= B;
      const masked = mask[k * B + read] === 1;
      for (let l = 0; l < layers; l++) rows[l * B + b] = masked ? -2 * o.bias : G[base + l * B + read] - o.bias;
    }
    const back0 = k * NS;
    for (let s = 0; s < S; s++) {
      const slope = s + lowest;
      // From the previous frame: bin b - slope, slope state s - 1, s or s + 1.
      const lo = k > 0 ? Math.max(0, slope) : B;
      const hi = Math.min(B, B + slope);
      const sB = s * B;
      const down = s > 0;
      const up = s < S - 1;
      for (let b = 0; b < B; b++) {
        const state = sB + b;
        let prev = 0;
        let from = -1;
        if (b >= lo && b < hi) {
          const pb = sB + b - slope;
          if (V[pb] > prev) [prev, from] = [V[pb], s];
          if (down && V[pb - B] - bend > prev) [prev, from] = [V[pb - B] - bend, s - 1];
          if (up && V[pb + B] - bend > prev) [prev, from] = [V[pb + B] - bend, s + 1];
        }
        const v = prev + rows[L[state] * B + b];
        W[state] = v;
        back[back0 + state] = from;
        if (v > best) {
          best = v;
          bestK = k;
          bestState = state;
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
    let read = b + (shift ? shift[k] : 0);
    if (read >= B) read -= B;
    gains.push(mask[k * B + read] ? NaN : G[(k * layers + L[state]) * B + read]);
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
export function findTraces(stack: Stack, options: TraceOptions = {}): Traces {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) } as Required<TraceOptions>;
  const g = gridOf(stack, o);
  const { K, B, freqs } = g;
  const hop = K > 1 ? stack.base.times[1] - stack.base.times[0] : 0.25;
  const minFrames = Math.ceil(o.minSeconds / hop);
  const lnStep = Math.log1p(o.step);
  const reach = Math.ceil(0.006 / o.step);
  const maskOf = (paths: Path[]) => {
    const mask = new Uint8Array(K * B);
    // The ridge, its harmonics and subharmonics, a few grid steps either side.
    for (const path of paths) {
      for (let i = 0; i < path.bins.length; i++) {
        const k = path.from + i;
        for (const ratio of KIN) {
          const c = path.bins[i] + Math.round(Math.log(ratio) / lnStep);
          for (let b = Math.max(0, c - reach); b <= Math.min(B - 1, c + reach); b++) mask[k * B + b] = 1;
        }
      }
    }
    return mask;
  };

  // The null: the best ridge of scrambled copies (each block of frames turned by its own random
  // step along the frequency axis), so tones no longer line up across blocks but the noise keeps
  // its texture.
  const shifts = scrambles(K, B, o.nulls, o.block);
  const nullWith = (mask: Uint8Array) => spreadOf(shifts.map((shift) => bestPath(g, o, mask, shift)?.score ?? 0));
  let nul = nullWith(new Uint8Array(K * B));

  // Ridges, best first: each one found is masked before looking for the next, until they no
  // longer stand out (half the bar: the second null below may lift them).
  const found: Path[] = [];
  for (let attempt = 0; attempt < o.maxTraces + 2; attempt++) {
    const path = bestPath(g, o, maskOf(found), null);
    if (!path || (path.score - nul.mid) / nul.spread < o.minConfidence / 2) break;
    found.push(path);
  }
  // A loud tone lends its blocks to the scrambles and lifts the null: search them again with the
  // ridges that stood out masked.
  const standing = found.filter((p) => (p.score - nul.mid) / nul.spread >= STAND);
  if (standing.length) nul = nullWith(maskOf(standing));

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
