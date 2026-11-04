import { heardAt, type Air } from "./doppler";
import type { Spectrogram, Stack } from "./spectrogram";
import type { Track } from "./track";

export type Candidate<M = unknown> = { id: string; track: Track; meta: M };

export type MatchOptions = {
  /** Lowest and highest fundamental tried, Hz. Propeller blade-pass tones sit around 60 to 200 Hz,
   * jet fan tones around 1 to 2 kHz. */
  f0Min?: number;
  f0Max?: number;
  /** Relative weight of the fundamental and its first harmonics. */
  harmonics?: number[];
  /** How far the phone's clock may be from the flight data's, seconds, either way. */
  clockSpread?: number;
  /** Beyond this distance an aircraft is not heard at all, metres. */
  maxRange?: number;
  /** Within this distance a frame counts fully; farther ones fade with the square of the distance. */
  nearRange?: number;
  /** Fewest audible frames for an aircraft to be scored. */
  minFrames?: number;
};

export type Match<M = unknown> = {
  id: string;
  meta: M;
  /** How far the best curve stands above this aircraft's wrong guesses, in their own spreads:
   * noise alone peaks around 3 to 4, since the best of a few thousand guesses wins. */
  score: number;
  /** Emitted fundamental, Hz. */
  f0: number;
  /** Seconds to add to the phone's clock to line it up with the flight data. */
  clock: number;
  /** Per spectrogram frame: heard frequency / emitted frequency (NaN when unknown). */
  factor: Float32Array;
  /** Per spectrogram frame: distance to the aircraft when the heard sound left it, metres. */
  range: Float32Array;
  /** The closest moment within the recording. */
  closest: { range: number; heardAt: number; delay: number } | null;
  /** The score before the lines this aircraft does not explain were taken out of the evidence
   * (lib/core/explain.ts); absent when it was not scored again. */
  borrowed?: number;
};

export type Verdict<M = unknown> = {
  kind: "strong" | "possible" | "none";
  best: Match<M> | null;
  ranked: Match<M>[];
};

/**
 * Evidence taken out when an aircraft is scored again: per base frame, frequency bands in Hz as
 * [lo, hi, lo, hi, ...] sorted by lo (empty where nothing is taken out). A curve point inside a
 * band, or within half a bin and the evidence map's reach of it, reads nothing there.
 */
export type Mask = Float32Array[];

/** The evidence map's own reach around a frequency (lib/core/spectrogram.ts, its defaults). */
const reachHz = (f: number) => Math.max(0.5, 0.0015 * f);

function masked(bands: Float32Array, f: number, pad: number): boolean {
  for (let i = 0; i < bands.length; i += 2) {
    if (bands[i] - pad > f) return false;
    if (f <= bands[i + 1] + pad) return true;
  }
  return false;
}

const DEFAULTS: Required<MatchOptions> = {
  f0Min: 40,
  f0Max: 2000,
  harmonics: [1, 0.6, 0.4],
  clockSpread: 2,
  maxRange: 15_000,
  nearRange: 1_000,
  minFrames: 20,
};

/**
 * Thresholds on the best score and on its lead over the second, from the reports of 2 Nov 2026:
 * - evals/synthetic, 132 scenarios: nothing to find, score max 8.19 (lead 3.32: a loud aircraft
 *   left out of the data, a decoy took its place), p90 6.42; wrong answer, score max 6.3 (lead 1.39);
 *   right answer, score min 3.67 / p50 8.23.
 * - evals/real-tracks, 34: no wrong answer; evals/real-audio, 18: right answers 4.52 to 12.51, the
 *   best with nothing to find 6.77 (a second helicopter really audible, now labelled).
 * Strong sits 10 % above the worst score with nothing to find. "Strong" must never be wrong.
 */
export const STRONG = { score: 9, lead: 2.5 };
export const POSSIBLE = { score: 6.5, lead: 1.5 };

type Model = {
  factor: Float32Array;
  range: Float32Array;
  weight: Float32Array;
  /** log2 of |d factor / dt| per frame: how fast the pitch moves, to pick the layer. */
  slope: Float32Array;
  frames: Int32Array;
  emitted: Float64Array;
};

function slopes(spec: Spectrogram, factor: Float32Array): Float32Array {
  const n = spec.frames;
  const out = new Float32Array(n).fill(-Infinity);
  for (let k = 0; k < n; k++) {
    const a = Number.isFinite(factor[k - 1]) ? k - 1 : k;
    const b = Number.isFinite(factor[k + 1]) ? k + 1 : k;
    if (a === b || !Number.isFinite(factor[a]) || !Number.isFinite(factor[b])) continue;
    out[k] = Math.log2(Math.abs((factor[b] - factor[a]) / (spec.times[b] - spec.times[a])) + 1e-12);
  }
  return out;
}

function model(spec: Spectrogram, start: number, clock: number, track: Track, air: Air, o: Required<MatchOptions>): Model {
  const n = spec.frames;
  const factor = new Float32Array(n).fill(NaN);
  const range = new Float32Array(n).fill(NaN);
  const weight = new Float32Array(n);
  const emitted = new Float64Array(n).fill(NaN);
  const active: number[] = [];
  for (let k = 0; k < n; k++) {
    const heard = heardAt(track, start + spec.times[k] + clock, air);
    if (!heard) continue;
    factor[k] = heard.factor;
    range[k] = heard.range;
    emitted[k] = heard.emitted;
    if (heard.range < o.maxRange) {
      weight[k] = Math.min(1, (o.nearRange / heard.range) ** 2);
      active.push(k);
    }
  }
  return { factor, range, weight, slope: slopes(spec, factor), frames: Int32Array.from(active), emitted };
}

/** Tones tried together, with what `score` needs of each worked out once. */
type Tones = { f0: Float64Array; count: number; lift: Float64Array };

function tonesOf(f0: Float64Array, count: number, harmonics: number[]): Tones {
  const H = harmonics.length;
  const lift = new Float64Array(count * H);
  for (let j = 0; j < count; j++) for (let h = 0; h < H; h++) lift[j * H + h] = Math.log2((h + 1) * f0[j]);
  return { f0, count, lift };
}

/**
 * Weighted evidence along the curves f(t) = h * f0 * factor(t), summed over harmonics h, for every
 * tone of `tones` at once, into `out`. Each point is read from the layer whose window suits the
 * curve's slope there: about 1 / sqrt(slope) seconds, so the tone stays within one bin while the
 * window lasts. Frame by frame, not tone by tone: a frame's tones read one row of each layer, in
 * order, where a tone at a time reads a new row at every frame and misses the cache each time.
 */
function score(stack: Stack, m: Model, frames: Int32Array, tones: Tones, harmonics: number[], out: Float64Array, mask?: Mask): void {
  const { layers } = stack;
  const top = layers.length - 1;
  const w0 = Math.log2(layers[0].window);
  const H = harmonics.length;
  const { f0, count, lift } = tones;
  const evidence = layers.map((l) => l.evidence);
  const index = layers.map((l) => l.index);
  const bins = Int32Array.from(layers, (l) => l.spec.bins);
  const binHz = Float64Array.from(layers, (l) => l.spec.binHz);
  const minHz = Float64Array.from(layers, (l) => l.spec.minHz);
  const rows = new Int32Array(layers.length);
  const num = new Float64Array(count);
  const den = new Float64Array(count);
  const { factor, slope, weight } = m;
  for (let i = 0; i < frames.length; i++) {
    const k = frames[i];
    const fac = factor[k];
    const sl = slope[k];
    const w = weight[k];
    const bands = mask?.[k];
    const hasBands = bands !== undefined && bands.length > 0;
    for (let l = 0; l <= top; l++) rows[l] = index[l][k] * bins[l];
    for (let j = 0; j < count; j++) {
      const f = f0[j] * fac;
      let sum = 0;
      let norm = 0;
      for (let h = 0; h < H; h++) {
        const raw = Math.round(w0 + 0.5 * (sl + lift[j * H + h]));
        const li = raw > top ? top : raw > 0 ? raw : 0;
        const b = Math.round(((h + 1) * f - minHz[li]) / binHz[li]);
        if (b < 0 || b >= bins[li]) continue;
        const weightH = harmonics[h];
        norm += weightH * weightH;
        // Taken out: reads as the noise around it, zero on average.
        if (hasBands && masked(bands, (h + 1) * f, 0.5 * binHz[li] + reachHz((h + 1) * f))) continue;
        sum += weightH * evidence[li][rows[li] + b];
      }
      if (!norm) continue;
      num[j] += (w * sum) / Math.sqrt(norm);
      den[j] += w * w;
    }
  }
  for (let j = 0; j < count; j++) out[j] = den[j] > 0 ? num[j] / Math.sqrt(den[j]) : 0;
}

/** Evidence along any curve given per base frame (NaN = not heard), every frame weighted alike
 * unless `weight` says otherwise (as the matcher does: near frames count fully). */
export function curveScore(stack: Stack, factor: ArrayLike<number>, f0: number, harmonics = DEFAULTS.harmonics, weight?: ArrayLike<number>): number {
  const n = stack.base.frames;
  const frames: number[] = [];
  for (let k = 0; k < n; k++) if (Number.isFinite(factor[k]) && (!weight || weight[k] > 0)) frames.push(k);
  const f = Float32Array.from(factor);
  const w = weight ? Float32Array.from(weight) : new Float32Array(n).fill(1);
  const m: Model = { factor: f, range: new Float32Array(n), weight: w, slope: slopes(stack.base, f), frames: Int32Array.from(frames), emitted: new Float64Array(n) };
  const out = new Float64Array(1);
  score(stack, m, m.frames, tonesOf(Float64Array.of(f0), 1, harmonics), harmonics, out);
  return out[0];
}

type Peak = { score: number; f0: number; clock: number };

const coarseStep = (f0: number) => Math.max(0.5, f0 * 0.003);

/** The coarse grid of tones, the same for every clock and every aircraft of a search. */
function coarseTones(o: Required<MatchOptions>): Float64Array {
  const f0: number[] = [];
  for (let f = o.f0Min; f <= o.f0Max; f += coarseStep(f)) f0.push(f);
  return Float64Array.from(f0);
}

/** The best coarse try at least 2 Hz or 1 s away from every seed already taken (the earliest of equals). */
function nextSeed(scores: Float64Array, f0: Float64Array, clock: Float64Array, n: number, seeds: Peak[]): Peak | null {
  let at = -1;
  let top = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!(scores[i] > top)) continue;
    let far = true;
    for (let s = 0; s < seeds.length && far; s++) far = Math.abs(seeds[s].f0 - f0[i]) > 2 || Math.abs(seeds[s].clock - clock[i]) > 1;
    if (!far) continue;
    top = scores[i];
    at = i;
  }
  return at < 0 ? null : { score: top, f0: f0[at], clock: clock[at] };
}

function matchOne<M>(stack: Stack, start: number, c: Candidate<M>, air: Air, o: Required<MatchOptions>, mask?: Mask): Match<M> | null {
  const spec = stack.base;
  const maxHz = spec.minHz + (spec.bins - 1) * spec.binHz;
  const models = new Map<number, Model>();
  const modelAt = (clock: number) => {
    const key = Math.round(clock * 1000);
    let m = models.get(key);
    if (!m) {
      m = model(spec, start, clock, c.track, air, o);
      models.set(key, m);
    }
    return m;
  };

  // Coarse: clock every 0.5 s; tone every 0.5 Hz up to 167 Hz, then every 0.3 % (the model's own
  // accuracy, a fraction of a m/s of radial speed, is relative too); every other frame.
  const grid = coarseTones(o);
  const coarse = tonesOf(grid, grid.length, o.harmonics);
  const clocks = Math.floor((2 * o.clockSpread + 1e-9) / 0.5) + 1;
  const peakScore = new Float64Array(clocks * grid.length);
  const peakF0 = new Float64Array(clocks * grid.length);
  const peakClock = new Float64Array(clocks * grid.length);
  const scores = new Float64Array(grid.length);
  let peaks = 0;
  for (let clock = -o.clockSpread; clock <= o.clockSpread + 1e-9; clock += 0.5) {
    const full = modelAt(clock);
    if (full.frames.length < o.minFrames) continue;
    const every = new Int32Array(Math.ceil(full.frames.length / 2));
    let top = 0;
    for (let i = 0; i < every.length; i++) {
      every[i] = full.frames[2 * i];
      top = Math.max(top, full.factor[every[i]]);
    }
    const f0Max = Math.min(o.f0Max, maxHz / top);
    let count = 0;
    while (count < grid.length && grid[count] <= f0Max) count++;
    score(stack, full, every, { f0: grid, count, lift: coarse.lift }, o.harmonics, scores, mask);
    for (let j = 0; j < count; j++) {
      peakScore[peaks] = scores[j];
      peakF0[peaks] = grid[j];
      peakClock[peaks] = clock;
      peaks++;
    }
  }
  if (peaks < 50) return null;

  // Almost every coarse try is a wrong guess: their spread is this recording's own noise for this
  // aircraft. Scores are reported in units of it, so they mean the same in a quiet field as next
  // to a road, whatever the overlap of the frames. The null is scored like the answer, on every
  // frame, at 300 tries spread evenly over the coarse grid.
  const stride = Math.max(1, Math.floor(peaks / 300));
  const raw = new Float64Array(Math.ceil(peaks / stride));
  const tried = new Float64Array(raw.length);
  let filled = 0;
  for (let i = 0; i < peaks; ) {
    // The tries of one clock go together.
    const clock = peakClock[i];
    let n = 0;
    for (let at = i; at < peaks && peakClock[at] === clock; at += stride) tried[n++] = peakF0[at];
    const m = modelAt(clock);
    const out = raw.subarray(filled, filled + n);
    score(stack, m, m.frames, tonesOf(tried, n, o.harmonics), o.harmonics, out, mask);
    filled += n;
    i += n * stride;
  }
  raw.sort();
  const nullMid = raw[raw.length >> 1];
  for (let i = 0; i < raw.length; i++) raw[i] = Math.abs(raw[i] - nullMid);
  raw.sort();
  const nullSpread = 1.4826 * raw[raw.length >> 1] + 1e-9;

  const seeds: Peak[] = [];
  while (seeds.length < 3) {
    const seed = nextSeed(peakScore, peakF0, peakClock, peaks, seeds);
    if (!seed) break;
    seeds.push(seed);
  }

  // Fine, on every frame: clock every 0.125 s, tone in tenths of a coarse step, around each of
  // the three best. The null above came from every other frame: rescore the seeds on all of them.
  let best: Peak = { score: -Infinity, f0: seeds[0].f0, clock: seeds[0].clock };
  const near = new Float64Array(32);
  const scored = new Float64Array(32);
  for (const seed of seeds) {
    const step = coarseStep(seed.f0);
    let count = 0;
    for (let df = -step; df <= step + 1e-9; df += step / 10) near[count++] = seed.f0 + df;
    const fine = tonesOf(near, count, o.harmonics);
    for (let dc = -0.5; dc <= 0.5 + 1e-9; dc += 0.125) {
      const clock = seed.clock + dc;
      if (Math.abs(clock) > o.clockSpread + 0.5) continue;
      const m = modelAt(clock);
      if (m.frames.length < o.minFrames) continue;
      score(stack, m, m.frames, fine, o.harmonics, scored, mask);
      for (let j = 0; j < count; j++) if (scored[j] > best.score) best = { score: scored[j], f0: near[j], clock };
    }
  }

  const m = modelAt(best.clock);
  let closest: Match["closest"] = null;
  for (let k = 0; k < spec.frames; k++) {
    const r = m.range[k];
    if (Number.isFinite(r) && (!closest || r < closest.range)) {
      const heard = start + spec.times[k] + best.clock;
      closest = { range: r, heardAt: spec.times[k], delay: heard - m.emitted[k] };
    }
  }
  return { id: c.id, meta: c.meta, score: (best.score - nullMid) / nullSpread, f0: best.f0, clock: best.clock, factor: m.factor, range: m.range, closest };
}

export function verdictOf<M>(ranked: Match<M>[]): Verdict<M> {
  const best = ranked[0] ?? null;
  const second = ranked[1]?.score ?? 0;
  if (!best) return { kind: "none", best: null, ranked };
  if (best.score >= STRONG.score && best.score - second >= STRONG.lead) return { kind: "strong", best, ranked };
  if (best.score >= POSSIBLE.score && best.score - second >= POSSIBLE.lead) return { kind: "possible", best, ranked };
  return { kind: "none", best, ranked };
}

/** Options with their defaults; an option passed as undefined keeps its default. */
export function matchOptions(options: MatchOptions = {}): Required<MatchOptions> {
  return { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) } as Required<MatchOptions>;
}

/** One aircraft scored again with part of the evidence taken out (see Mask). */
export function matchMasked<M>(stack: Stack, start: number, c: Candidate<M>, air: Air, mask: Mask, options: MatchOptions = {}): Match<M> | null {
  return matchOne(stack, start, c, air, matchOptions(options), mask);
}

/**
 * Scores every candidate against the recording and ranks them. `start` is the phone's UTC time
 * of the first sample. Yields to the event loop between aircraft so a page stays responsive.
 */
export async function matchAll<M>(
  stack: Stack,
  start: number,
  candidates: Candidate<M>[],
  air: Air,
  options: MatchOptions = {},
  onProgress?: (done: number, total: number, id: string) => void,
): Promise<Verdict<M>> {
  const o = matchOptions(options);
  const ranked: Match<M>[] = [];
  for (let i = 0; i < candidates.length; i++) {
    onProgress?.(i, candidates.length, candidates[i].id);
    await new Promise((r) => setTimeout(r, 0));
    const m = matchOne(stack, start, candidates[i], air, o);
    if (m) ranked.push(m);
  }
  onProgress?.(candidates.length, candidates.length, "");
  ranked.sort((a, b) => b.score - a.score);
  return verdictOf(ranked);
}
