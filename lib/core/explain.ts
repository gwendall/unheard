// Lines and who explains them. A loud line in the recording from an aircraft that is not in the
// flight data (no transponder, a military jet, an ultralight, outside the polled radius) lends
// part of itself to aircraft of the data: their curves cross it, or run along it for a while,
// and the evidence there is huge. The matcher alone cannot tell; the line's whole span can.
//
// The lines are the blind traces (lib/core/trace.ts): the tones found in the sound alone. An
// aircraft borrows a line when its curve follows one stretch of it and a plane absent from the
// data would follow it further: a straight, steady flyby that follows the same stretch also
// follows a good part of the rest of the line, where the aircraft's curve goes elsewhere. A
// trace that hops from one tone to another (a propeller and its engine, two aircraft crossing)
// is not held against anyone: no single flyby follows it past the hop either. An aircraft that
// borrows a line is scored again with that line taken out of the evidence, so it keeps only what
// it hears of its own. Where an aircraft's track is unknown its curve explains nothing: a strong
// answer needs the curve along the line's span. A line no aircraft of the data explains is
// reported: a plane we hear that the flight data does not have.

import { pathSpeed, type Air } from "./doppler";
import { bestOf, framesOf, shapeOf } from "./flyby";
import { matchMasked, STRONG, type Candidate, type Mask, type Match, type MatchOptions } from "./match";
import type { Stack } from "./spectrogram";
import { findTraces, type Trace, type TraceOptions } from "./trace";

/** Blind traces over the matcher's own range of tones (40 Hz to 2 kHz), each over its whole span:
 * the faint stretch past a loud one is where a borrowed curve goes its own way (no trim). */
export const LINE_OPTIONS: TraceOptions = { fMin: 40, fMax: 2000, trimShare: 0 };

export function linesOf(stack: Stack, options: TraceOptions = LINE_OPTIONS): Trace[] {
  return findTraces(stack, options).traces;
}

/** Frequency ratios a curve and a line may stand in: the line is the curve's tone, one of its
 * harmonics, or the curve's tone sits on a harmonic of the line. */
export const FAMILY = [1 / 3, 1 / 2, 2 / 3, 1, 4 / 3, 3 / 2, 5 / 3, 2, 5 / 2, 3, 4, 5, 6];

export type ExplainOptions = {
  /** How far a curve may stray from a line and still follow it: relative, and in Hz at the
   * line's tone (a trace is only as sharp as the evidence map, about 1 Hz at 50 Hz). */
  tolerance?: number;
  toleranceHz?: number;
  /** Fewest frames of a line a curve must follow to be riding on it. */
  ride?: number;
  /** An aircraft borrows a line when a flyby following the same stretch follows this many more
   * frames of it, and this share of the line. */
  beyondFrames?: number;
  beyondShare?: number;
  /** A curve that follows this long of a line (seconds), and half of it or more, is its source
   * whatever the line does past that: a track's own error (a turn between fixes, a microphone
   * placed a little off) bends a true curve off its line at one end, and another aircraft's
   * curve seldom runs along a line that long. */
  long?: number;
  /** Borrowers are scored again while the best could be strong (STRONG.score). */
  strong?: number;
  /** Aircraft scored under this decide nothing (a lead counts from the second's score). */
  floor?: number;
  /** A line no aircraft explains is reported when a flyby follows this share of it or more. */
  aircraft?: number;
};

const DEFAULTS: Required<ExplainOptions> = {
  tolerance: 0.02,
  toleranceHz: 1,
  ride: 8,
  beyondFrames: 20,
  beyondShare: 0.2,
  long: 30,
  strong: STRONG.score,
  floor: 4,
  aircraft: 0.8,
};

/** Log tolerance of a line: the relative one, or toleranceHz at its median tone if wider. */
export function toleranceOf(line: Trace, o: Required<ExplainOptions> = DEFAULTS): number {
  const f: number[] = [];
  for (let k = line.from; k <= line.to; k++) if (Number.isFinite(line.freq[k])) f.push(line.freq[k]);
  f.sort((a, b) => a - b);
  const mid = f[f.length >> 1] ?? 100;
  return Math.log1p(Math.max(o.tolerance, o.toleranceHz / mid));
}

/**
 * The offset (log of a tone ratio) that puts the most of the first n residuals within ±tol of
 * it: a window 2 tol wide slid over them, sorted.
 */
function bestOffset(res: Float64Array, n: number, tol: number): number {
  const sorted = res.slice(0, n).sort();
  let best = -1;
  let at = 0;
  let j = 0;
  for (let i = 0; i < n; i++) {
    while (sorted[i] - sorted[j] > 2 * tol) j++;
    if (i - j + 1 > best) {
      best = i - j + 1;
      at = (sorted[i] + sorted[j]) / 2;
    }
  }
  return at;
}

/**
 * Log of heard / emitted for a straight, level, steady flyby at reception times `t` (increasing),
 * into `out`: beta is the speed over the speed of sound, T the closest distance over the speed
 * (seconds), t0 the moment the sound of the closest point left the aircraft.
 */
export function flybyLogs(t: ArrayLike<number>, beta: number, T: number, t0: number, out: Float64Array): Float64Array {
  // Reception time t = tau + beta * T * sqrt(1 + u^2), u = (tau - t0) / T: increasing and convex
  // in tau, so Newton converges from anywhere; each frame starts from the last one's answer.
  let tau = t.length ? t[0] - beta * T : 0;
  for (let i = 0; i < t.length; i++) {
    for (let n = 0; n < 20; n++) {
      const u = (tau - t0) / T;
      const q = Math.sqrt(1 + u * u);
      const step = (tau + beta * T * q - t[i]) / (1 + (beta * u) / q);
      tau -= step;
      if (Math.abs(step) < 1e-5) break;
    }
    const u = (tau - t0) / T;
    out[i] = -Math.log1p((beta * u) / Math.sqrt(1 + u * u));
  }
  return out;
}

export type Flyby = {
  beta: number;
  T: number;
  t0: number;
  /** Log of its tone, Hz. */
  logF0: number;
  /** Share of the line's frames it follows within the line's tolerance. */
  share: number;
  /** Per frame of the line (index from line.from): followed or not. */
  on: Uint8Array;
};

/** Weight of a focus frame in flybyFit: one is worth more than the rest of most lines. */
const FOCUS = 10;

/**
 * The plane absent from the data: the straight, level, steady flyby that follows the most of a
 * line, searched over its speed, closest distance and moment, its tone in closed form. With
 * `focus` (per line frame), the frames marked come first: the flyby that follows the same
 * stretch as an aircraft, and as much of the rest as it can.
 */
export function flybyFit(line: Trace, times: ArrayLike<number>, tol: number, focus?: Uint8Array): Flyby {
  const n = line.to - line.from + 1;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(line.freq[line.from + i])) idx.push(i);
  const none: Flyby = { beta: 0, T: 0, t0: 0, logF0: 0, share: 0, on: new Uint8Array(n) };
  if (idx.length < 4) return none;
  const set = (every: number) => {
    const at = idx.filter((_, j) => j % every === 0);
    return {
      i: Int32Array.from(at),
      t: Float64Array.from(at, (i) => times[line.from + i]),
      y: Float64Array.from(at, (i) => Math.log(line.freq[line.from + i])),
      w: Float64Array.from(at, (i) => (focus?.[i] ? FOCUS : 1)),
    };
  };
  const all = set(1);
  const few = set(Math.max(1, Math.floor(idx.length / 40)));
  const model = new Float64Array(idx.length);
  const res = new Float64Array(idx.length);
  // Soft count on a few frames for the search (the median as the tone); the exact one at the end.
  const soft = (beta: number, T: number, t0: number) => {
    const m = few.t.length;
    flybyLogs(few.t, beta, T, t0, model);
    for (let i = 0; i < m; i++) res[i] = few.y[i] - model[i];
    const mid = res.slice(0, m).sort()[m >> 1];
    let s = 0;
    for (let i = 0; i < m; i++) {
      const z = (res[i] - mid) / tol;
      s += few.w[i] * Math.exp(-0.5 * z * z);
    }
    return s;
  };
  const exact = (beta: number, T: number, t0: number) => {
    const m = all.t.length;
    flybyLogs(all.t, beta, T, t0, model);
    for (let i = 0; i < m; i++) res[i] = all.y[i] - model[i];
    const off = bestOffset(res, m, tol);
    const on = new Uint8Array(n);
    let count = 0;
    for (let i = 0; i < m; i++) {
      if (Math.abs(res[i] - off) > tol) continue;
      on[all.i[i]] = 1;
      count++;
    }
    return { logF0: off, share: count / n, on };
  };
  const first = all.t[0];
  const last = all.t[all.t.length - 1];
  const span = last - first;
  type P = { beta: number; T: number; t0: number; s: number };
  const tops: P[] = [];
  const keep = 3;
  for (let i = 0; i < 10; i++) {
    const beta = 0.03 * (0.8 / 0.03) ** (i / 9);
    for (let j = 0; j < 14; j++) {
      const T = 0.5 * (600 / 0.5) ** (j / 13);
      const reach = Math.min(Math.max(T, span), 4 * span + 10);
      const step = Math.max(0.25, (2 * reach + span) / 40);
      for (let t0 = first - reach; t0 <= last + reach; t0 += step) {
        const s = soft(beta, T, t0);
        if (tops.length < keep || s > tops[tops.length - 1].s) {
          tops.push({ beta, T, t0, s });
          tops.sort((a, b) => b.s - a.s);
          if (tops.length > keep) tops.pop();
        }
      }
    }
  }
  // Refine each of the best by a pattern search: speed and distance in ratios, the moment in seconds.
  const moves = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  let best = none;
  let bestScore = -1;
  for (const p of tops) {
    let { beta, T, t0, s } = p;
    let scale = 0.25;
    while (scale > 0.004) {
      let moved = false;
      for (const [db, dT, dt] of moves) {
        const nb = Math.min(0.9, beta * Math.exp(db * scale));
        const nT = T * Math.exp(dT * scale);
        const nt = t0 + dt * scale * Math.max(1, Math.min(T, span));
        const ns = soft(nb, nT, nt);
        if (ns > s) {
          [beta, T, t0, s] = [nb, nT, nt, ns];
          moved = true;
        }
      }
      if (!moved) scale /= 2;
    }
    const e = exact(beta, T, t0);
    let score = 0;
    for (let i = 0; i < n; i++) if (e.on[i]) score += focus?.[i] ? FOCUS : 1;
    if (score > bestScore) {
      best = { beta, T, t0, ...e };
      bestScore = score;
    }
  }
  return best;
}

/**
 * The share of a line that a curve (per frame, heard over emitted; NaN where unknown) follows at
 * whichever tone suits it best: any tone, not just the matcher's and its family (a propeller's
 * blade-pass and its engine's firing tone are one aircraft at no simple ratio).
 */
export function sameCurve(line: Trace, factor: ArrayLike<number>, tol: number): number {
  const n = line.to - line.from + 1;
  const res = new Float64Array(n);
  let m = 0;
  for (let k = line.from; k <= line.to; k++) {
    const f = factor[k];
    if (!Number.isFinite(f) || !(f > 0) || !Number.isFinite(line.freq[k])) continue;
    res[m++] = Math.log(line.freq[k] / f);
  }
  if (!m) return 0;
  const off = bestOffset(res, m, tol);
  let count = 0;
  for (let i = 0; i < m; i++) if (Math.abs(res[i] - off) <= tol) count++;
  return count / n;
}

export type Follow = {
  /** Line tone over the curve's tone at the ratio that fits best (one of FAMILY). */
  ratio: number;
  /** Per frame of the line (index from line.from): the curve follows it. */
  on: Uint8Array;
  /** Frames followed. */
  count: number;
};

/**
 * Which frames of a line a curve follows: the curve's own tone (a few % either way: the clock
 * and the tone trade off a little) at the ratio of FAMILY that follows the most, within the
 * line's tolerance (log units). NaN in `factor` where the curve is unknown.
 */
export function follow(line: Trace, f0: number, factor: ArrayLike<number>, tol: number): Follow {
  const n = line.to - line.from + 1;
  const res = new Float64Array(n);
  const at = new Int32Array(n);
  let best: Follow = { ratio: 1, on: new Uint8Array(n), count: 0 };
  for (const ratio of FAMILY) {
    const lr = Math.log(ratio);
    let m = 0;
    for (let i = 0; i < n; i++) {
      const k = line.from + i;
      const f = factor[k];
      if (!Number.isFinite(f) || !(f > 0) || !Number.isFinite(line.freq[k])) continue;
      const r = Math.log(line.freq[k] / (f0 * f)) - lr;
      if (Math.abs(r) > 0.05) continue;
      res[m] = r;
      at[m] = i;
      m++;
    }
    if (m <= best.count) continue;
    // The tone from where the curve is closest to the line.
    const off = bestOffset(res, m, tol);
    const on = new Uint8Array(n);
    let count = 0;
    for (let j = 0; j < m; j++) {
      if (Math.abs(res[j] - off) > tol) continue;
      on[at[j]] = 1;
      count++;
    }
    if (count > best.count) best = { ratio, on, count };
  }
  return best;
}

/** One aircraft against one line: it explains the line, borrows it, rides on a part of it
 * without borrowing (the rest is another tone), or stays apart from it. */
export type Verdict = "explains" | "borrows" | "rides" | "apart";

/**
 * One aircraft against one line. It rides on the line when its curve follows `ride` frames of it
 * or more; it borrows it when a flyby that follows the same frames follows a good part of the
 * rest too (the line goes on, the aircraft's curve does not); it explains it when it rides on it
 * without borrowing and follows half of it or more, or follows half of it and `long` seconds.
 */
export function judge(line: Trace, times: ArrayLike<number>, f: Follow, free: Flyby, tol: number, options: ExplainOptions = {}): { verdict: Verdict; beyond: number } {
  const o = { ...DEFAULTS, ...options };
  const n = line.to - line.from + 1;
  if (f.count < o.ride) return { verdict: "apart", beyond: 0 };
  const hop = times.length > 1 ? times[1] - times[0] : 0;
  if (f.count >= 0.5 * n && f.count * hop >= o.long) return { verdict: "explains", beyond: 0 };
  // The flyby that follows the whole line is the first try; when it misses the aircraft's
  // stretch, the one that follows that stretch first.
  let shared = 0;
  for (let i = 0; i < n; i++) if (f.on[i] && free.on[i]) shared++;
  const fly = shared >= 0.9 * f.count ? free : flybyFit(line, times, tol, f.on);
  let beyond = 0;
  let kept = 0;
  for (let i = 0; i < n; i++) {
    if (f.on[i] && fly.on[i]) kept++;
    if (!f.on[i] && fly.on[i]) beyond++;
  }
  // A flyby that cannot follow the aircraft's stretch says nothing about the rest.
  if (kept < 0.9 * f.count) beyond = 0;
  if (beyond >= Math.max(o.beyondFrames, o.beyondShare * n)) return { verdict: "borrows", beyond };
  return { verdict: f.count >= 0.5 * n ? "explains" : "rides", beyond };
}

/**
 * The evidence of lines and their families, as a Mask for the matcher: at each frame, the band
 * the line covers over the frames around it (a 2 s window reads that much of a falling tone),
 * widened by the trace's own error (1 % and 0.75 Hz at the tone, scaled with the harmonic).
 */
export function maskOf(lines: Trace[], frames: number, smear = 4): Mask {
  const bands: number[][][] = Array.from({ length: frames }, () => []);
  for (const line of lines) {
    for (let k = Math.max(0, line.from - smear); k <= Math.min(frames - 1, line.to + smear); k++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = Math.max(line.from, k - smear); j <= Math.min(line.to, k + smear); j++) {
        const f = line.freq[j];
        if (!Number.isFinite(f)) continue;
        lo = Math.min(lo, f);
        hi = Math.max(hi, f);
      }
      if (!Number.isFinite(lo)) continue;
      for (const q of FAMILY) bands[k].push([q * (lo * 0.99 - 0.75), q * (hi * 1.01 + 0.75)]);
    }
  }
  return bands.map((list) => {
    list.sort((a, b) => a[0] - b[0]);
    // Merged, so the matcher's scan can stop at the first band above a frequency.
    const merged: number[] = [];
    for (const [lo, hi] of list) {
      if (merged.length && lo <= merged[merged.length - 1]) merged[merged.length - 1] = Math.max(merged[merged.length - 1], hi);
      else merged.push(lo, hi);
    }
    return Float32Array.from(merged);
  });
}

/**
 * Share of the frames of `line` a curve follows (`on`, from line.from) where the line runs on one
 * of `others` or on a harmonic of it (the bands of maskOf, unsmeared).
 */
export function onLines(line: Trace, on: Uint8Array, others: Trace[], frames: number): number {
  if (!others.length) return 0;
  const mask = maskOf(others, frames, 0);
  let n = 0;
  let inside = 0;
  for (let i = 0; i < on.length; i++) {
    if (!on[i]) continue;
    n++;
    const f = line.freq[line.from + i];
    const bands = mask[line.from + i];
    for (let b = 0; b < bands.length; b += 2) {
      if (bands[b] > f) break;
      if (f <= bands[b + 1]) {
        inside++;
        break;
      }
    }
  }
  return n ? inside / n : 0;
}

/** A line heard in the recording, the flyby that follows it best, and who of the data explains it. */
export type Line = {
  trace: Trace;
  flyby: Flyby;
  /** Aircraft of the data that explain it; empty when none does. */
  by: string[];
  /** Aircraft that borrowed it, and were scored again without it. */
  borrowed: string[];
  /** The most of it any aircraft of the data follows at a tone of its own (0 before they are checked). */
  shape: number;
};

export type Explained<M> = {
  ranked: Match<M>[];
  lines: Line[];
  /** Lines no aircraft of the data explains, that a flyby follows: a plane we hear that the
   * flight data does not have. */
  unexplained: Trace[];
};

/**
 * What an unexplained line must show to be told to a visitor (evals/ghost.eval.ts, where each number
 * comes from): a straight flyby follows this share of it, it stands this far above scrambled copies
 * of the recording, no aircraft of the data follows this share of it at any tone, and read as a
 * straight pass it is this far away, in metres. Street sound makes confident falling lines too
 * (a machine winding down, a car, a voice), nearly all of them read as passing within 300 m.
 */
export const GHOST = { share: 0.8, confidence: 20, shape: 0.5, distance: 300 };

/** A line we can tell a visitor about: a sound passing that the flight data does not have. */
export type Ghost = {
  /** Seconds from the start of the recording. */
  from: number;
  to: number;
  /** The tone heard at either end, Hz. */
  hzFrom: number;
  hzTo: number;
  /** Read as a straight pass (lib/core/flyby.ts): its speed in m/s and closest distance in m, an order of magnitude. */
  speed: number;
  distance: number;
  /** Per base frame, the flyby's tone in Hz (NaN outside the line). */
  curve: Float32Array;
};

/** Whether two lines are one sound: heard at once, and the flyby of the first follows the second at a tone of its own. */
function sameSound(a: Line, b: Line, times: ArrayLike<number>): boolean {
  const from = Math.max(a.trace.from, b.trace.from);
  const to = Math.min(a.trace.to, b.trace.to);
  if (to - from < 0.5 * Math.min(a.trace.to - a.trace.from, b.trace.to - b.trace.from)) return false;
  const at = Float64Array.from({ length: b.trace.to - b.trace.from + 1 }, (_, i) => times[b.trace.from + i]);
  const factor = new Float32Array(times.length).fill(NaN);
  flybyLogs(at, a.flyby.beta, a.flyby.T, a.flyby.t0, new Float64Array(at.length)).forEach((log, i) => {
    factor[b.trace.from + i] = Math.exp(log);
  });
  return sameCurve(b.trace, factor, toleranceOf(b.trace)) >= 0.5;
}

/** A line read as a straight pass: the grid of lib/core/flyby.ts, sturdier than the free flyby's own numbers when the line is only part of a pass. */
export function readLine(trace: Trace, times: ArrayLike<number>, air: Air): { speed: number; distance: number } {
  const { t, y } = framesOf(trace, Float64Array.from(times), 0);
  return bestOf(shapeOf(t, y, pathSpeed(air, 300)));
}

/** The lines to tell a visitor about, strongest first, each sound once (a tone and its neighbour, a ridge read twice). */
export function ghostLines(lines: Line[], times: ArrayLike<number>, air: Air): { line: Line; speed: number; distance: number }[] {
  const out: { line: Line; speed: number; distance: number }[] = [];
  for (const line of lines) {
    if (line.by.length || line.flyby.share < GHOST.share || line.trace.confidence < GHOST.confidence || line.shape >= GHOST.shape) continue;
    const read = readLine(line.trace, times, air);
    if (read.distance < GHOST.distance || out.some((g) => sameSound(g.line, line, times))) continue;
    out.push({ line, ...read });
  }
  return out;
}

/** What the page tells of them. Never touches the verdict. */
export function ghostsOf(lines: Line[], times: ArrayLike<number>, air: Air): Ghost[] {
  return ghostLines(lines, times, air).map(({ line: { trace, flyby }, speed, distance }) => {
    const curve = new Float32Array(times.length).fill(NaN);
    const at = Float64Array.from({ length: trace.to - trace.from + 1 }, (_, i) => times[trace.from + i]);
    flybyLogs(at, flyby.beta, flyby.T, flyby.t0, new Float64Array(at.length)).forEach((log, i) => {
      curve[trace.from + i] = Math.exp(log + flyby.logF0);
    });
    return { from: times[trace.from], to: times[trace.to], hzFrom: curve[trace.from], hzTo: curve[trace.to], speed, distance, curve };
  });
}

/**
 * Checks every aircraft that matters against the lines heard. An aircraft that borrows a line is
 * scored again with it taken out of the evidence, as long as it is the best or the runner-up the
 * best's lead is counted from, and the best could be strong; the ranking comes back re-sorted.
 */
export async function explainLines<M>(stack: Stack, start: number, candidates: Candidate<M>[], air: Air, ranked: Match<M>[], traces: Trace[], options: ExplainOptions = {}, match: MatchOptions = {}): Promise<Explained<M>> {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) } as Required<ExplainOptions>;
  const times = stack.base.times;
  const hop = times.length > 1 ? times[1] - times[0] : 0;
  const tols = traces.map((t) => toleranceOf(t, o));
  const lines: Line[] = traces.map((trace, i) => ({ trace, flyby: flybyFit(trace, times, tols[i]), by: [], borrowed: [], shape: 0 }));
  if (!lines.length) return { ranked, lines, unexplained: [] };
  const byId = new Map(candidates.map((c) => [c.id, c]));
  /** The lines a match borrows (and, the first time, the lines it explains, for the report). */
  const borrows = (m: Match<M>, record: boolean): number[] => {
    const follows = lines.map((line, i) => follow(line.trace, m.f0, m.factor, tols[i]));
    const verdicts = lines.map((line, i) => judge(line.trace, times, follows[i], line.flyby, tols[i], o).verdict);
    // A trace that runs on a line the aircraft follows for long (its own, see `long`), then hops
    // to another tone, is that line's tone where the aircraft follows it: not borrowed.
    const mine = lines.filter((_, i) => verdicts[i] === "explains" && follows[i].count * hop >= o.long).map((l) => l.trace);
    const out: number[] = [];
    lines.forEach((line, i) => {
      let verdict = verdicts[i];
      if (verdict === "borrows" && onLines(line.trace, follows[i].on, mine, times.length) >= 0.5) verdict = "explains";
      if (verdict === "borrows") out.push(i);
      if (record && verdict === "explains") line.by.push(m.id);
    });
    return out;
  };
  type Entry = { m: Match<M>; c: Candidate<M> | undefined; taken: number[]; pending: number[] };
  const entries: Entry[] = ranked.map((m) => {
    const c = byId.get(m.id);
    return { m, c, taken: [], pending: c && m.score >= o.floor ? borrows(m, true) : [] };
  });
  // The verdict reads the best and the second: score borrowers again from the top down until
  // the first two borrow nothing more, or the best is no longer strong (a possible already says
  // it is not sure). Taking evidence out never makes an aircraft more likely.
  for (;;) {
    entries.sort((a, b) => b.m.score - a.m.score);
    if (!entries.length || entries[0].m.score < o.strong) break;
    const next = entries.slice(0, 2).find((e) => e.pending.length && e.c);
    if (!next) break;
    for (const i of next.pending) lines[i].borrowed.push(next.m.id);
    next.taken = [...next.taken, ...next.pending];
    next.pending = [];
    await new Promise((r) => setTimeout(r, 0));
    const again = matchMasked(stack, start, next.c!, air, maskOf(next.taken.map((i) => lines[i].trace), times.length), match);
    const before = next.m.borrowed ?? next.m.score;
    if (!again) {
      next.m = { ...next.m, score: -Infinity, borrowed: before };
      continue;
    }
    next.m = { ...(again.score <= next.m.score ? again : next.m), borrowed: before };
    // Its curve may have moved onto another line it does not explain.
    if (next.m.score >= o.floor) next.pending = borrows(next.m, false).filter((i) => !next.taken.includes(i));
  }
  const out = entries.map((e) => e.m).filter((m) => Number.isFinite(m.score));
  out.sort((a, b) => b.score - a.score);
  lines.forEach((l, i) => {
    for (const m of out) l.shape = Math.max(l.shape, sameCurve(l.trace, m.factor, tols[i]));
  });
  const unexplained = lines.filter((l) => !l.by.length && l.flyby.share >= o.aircraft).map((l) => l.trace);
  return { ranked: out, lines, unexplained };
}
