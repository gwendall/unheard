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
};

export type Verdict<M = unknown> = {
  kind: "strong" | "possible" | "none";
  best: Match<M> | null;
  ranked: Match<M>[];
};

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

/**
 * Weighted evidence along the curve f(t) = h * f0 * factor(t), summed over harmonics h. Each
 * point is read from the layer whose window suits the curve's slope there: about 1 / sqrt(slope)
 * seconds, so the tone stays within one bin while the window lasts.
 */
function score(stack: Stack, m: Model, f0: number, harmonics: number[]): number {
  const { layers } = stack;
  const top = layers.length - 1;
  const w0 = Math.log2(layers[0].window);
  const lift = harmonics.map((_, h) => Math.log2((h + 1) * f0));
  let num = 0;
  let den = 0;
  for (let i = 0; i < m.frames.length; i++) {
    const k = m.frames[i];
    const f = f0 * m.factor[k];
    let sum = 0;
    let norm = 0;
    for (let h = 0; h < harmonics.length; h++) {
      const li = Math.min(top, Math.max(0, Math.round(w0 + 0.5 * (m.slope[k] + lift[h]))));
      const layer = layers[li];
      const { bins, binHz, minHz } = layer.spec;
      const b = Math.round(((h + 1) * f - minHz) / binHz);
      if (b < 0 || b >= bins) continue;
      sum += harmonics[h] * layer.evidence[layer.index[k] * bins + b];
      norm += harmonics[h] * harmonics[h];
    }
    if (!norm) continue;
    const w = m.weight[k];
    num += (w * sum) / Math.sqrt(norm);
    den += w * w;
  }
  return den > 0 ? num / Math.sqrt(den) : 0;
}

/** Evidence along any curve given per base frame (NaN = not heard), every frame weighted alike. */
export function curveScore(stack: Stack, factor: ArrayLike<number>, f0: number, harmonics = DEFAULTS.harmonics): number {
  const n = stack.base.frames;
  const frames: number[] = [];
  for (let k = 0; k < n; k++) if (Number.isFinite(factor[k])) frames.push(k);
  const f = Float32Array.from(factor);
  const m: Model = { factor: f, range: new Float32Array(n), weight: new Float32Array(n).fill(1), slope: slopes(stack.base, f), frames: Int32Array.from(frames), emitted: new Float64Array(n) };
  return score(stack, m, f0, harmonics);
}

type Peak = { score: number; f0: number; clock: number };

const coarseStep = (f0: number) => Math.max(0.5, f0 * 0.003);

function matchOne<M>(stack: Stack, start: number, c: Candidate<M>, air: Air, o: Required<MatchOptions>): Match<M> | null {
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
  const peaks: Peak[] = [];
  for (let clock = -o.clockSpread; clock <= o.clockSpread + 1e-9; clock += 0.5) {
    const full = modelAt(clock);
    if (full.frames.length < o.minFrames) continue;
    const m = { ...full, frames: full.frames.filter((_, i) => i % 2 === 0) };
    let top = 0;
    for (const k of m.frames) top = Math.max(top, m.factor[k]);
    const f0Max = Math.min(o.f0Max, maxHz / top);
    for (let f0 = o.f0Min; f0 <= f0Max; f0 += coarseStep(f0)) {
      const s = score(stack, m, f0, o.harmonics);
      peaks.push({ score: s, f0, clock });
    }
  }
  if (peaks.length < 50) return null;

  // Almost every coarse try is a wrong guess: their spread is this recording's own noise for this
  // aircraft. Scores are reported in units of it, so they mean the same in a quiet field as next
  // to a road, whatever the overlap of the frames. The null is scored like the answer, on every
  // frame, at 300 tries spread evenly over the coarse grid.
  const stride = Math.max(1, Math.floor(peaks.length / 300));
  const nullScores: number[] = [];
  for (let i = 0; i < peaks.length; i += stride) nullScores.push(score(stack, modelAt(peaks[i].clock), peaks[i].f0, o.harmonics));
  const raw = Float64Array.from(nullScores).sort();
  const nullMid = raw[raw.length >> 1];
  for (let i = 0; i < raw.length; i++) raw[i] = Math.abs(raw[i] - nullMid);
  raw.sort();
  const nullSpread = 1.4826 * raw[raw.length >> 1] + 1e-9;

  peaks.sort((a, b) => b.score - a.score);
  const seeds: Peak[] = [];
  for (const p of peaks) {
    if (seeds.every((s) => Math.abs(s.f0 - p.f0) > 2 || Math.abs(s.clock - p.clock) > 1)) seeds.push(p);
    if (seeds.length === 3) break;
  }

  // Fine, on every frame: clock every 0.125 s, tone in tenths of a coarse step, around each of
  // the three best. The null above came from every other frame: rescore the seeds on all of them.
  let best: Peak = { score: -Infinity, f0: seeds[0].f0, clock: seeds[0].clock };
  for (const seed of seeds) {
    const step = coarseStep(seed.f0);
    for (let dc = -0.5; dc <= 0.5 + 1e-9; dc += 0.125) {
      const clock = seed.clock + dc;
      if (Math.abs(clock) > o.clockSpread + 0.5) continue;
      const m = modelAt(clock);
      if (m.frames.length < o.minFrames) continue;
      for (let df = -step; df <= step + 1e-9; df += step / 10) {
        const s = score(stack, m, seed.f0 + df, o.harmonics);
        if (s > best.score) best = { score: s, f0: seed.f0 + df, clock };
      }
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
  // An option passed as undefined keeps its default.
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) } as Required<MatchOptions>;
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
