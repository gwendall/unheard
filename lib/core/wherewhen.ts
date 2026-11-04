// Where and when: the spot and the start time of a recording that carries no clue, from the
// falling tones of the aircraft in its sound (blind traces, lib/core/trace.ts) and a day of
// flight history (lib/history.ts). The idea is colsto's ("I discovered a sound that leaks your
// exact location", 2026); DOPPLERGEIST and dopplerprint (both MIT) search the same way from the
// command line with a start time known or bounded. Taken from dopplerprint's README: fit each tone
// with a constant-velocity Doppler curve first (rest frequency, speed, closest distance and time),
// keep jets but flag them, make every flyover share one clock, and count loud aircraft that should
// have been heard against a spot. DOPPLERGEIST searches a grid coarse to fine (200 m to 25 m);
// locate()'s fine search plays that part here. Here only a time window is known (a day, from the
// file's date or the user) and a region (100 km and more).
//
// 1. Tones. One tone per flyover heard (overlapping traces are one), the most confident.
// 2. Fits (lib/core/tracks.ts). For each tone and each flight in the window, the spots and starts
//    where that flight's real curve (its turns, speed and height) follows the tone, and how often a
//    fit that good happens anywhere: what a fit is worth, in nats of surprise.
// 3. Together. Every flyover heard must agree on one spot and one start: each tone's best fits add
//    the worth of the other tones' fits next to them.
// 4. The best distinct spots and times are read exactly with every trace, and lose ground for every
//    aircraft that passed close during the recording but is heard nowhere (silence rules spots out)
//    and when they lie out on the water (lib/core/sea.ts: down, never out).
// 5. Fine. locate() searches around the best few, with the flight data of that time.
//
// The answer's worth is the sum of its flights' surprises: how it compares with the number of
// spots and starts searched says whether it can be chance (a flyover alone over a day never can).

import type { Poll, PolledAircraft } from "../adsb";
import { isProp, KIND, type Flight } from "../history";
import { pathSpeed, type Air } from "./doppler";
import { flybyOf, framesOf, shapeOf, type Flyby, type Segment, type Shape } from "./flyby";
import { inParallel } from "./parallel";
import { fromLocal, toLocal, type Listener } from "./geo";
import { firstAfter, MISS, RANGE, readFast, smoothFlight, SWEEP, within } from "./guess";
import { locate, type Area } from "./locate";
import { AT_SEA, keepBest, seaOf } from "./sea";
import { gridOfGround, joinFits, pathsOf, scanPart, scanTracksWith, toneOf, worthOf, type ScanRunner } from "./tracks";

export { findSegments, flybys, type Flyby, type Segment, type SegmentWatch } from "./flyby";
export { readAt } from "./guess";

export type WhereStage = "shape" | "smooth" | "candidates" | "coarse" | "joint" | "fine";

/** The search's best guess while it still runs. */
export type BestSoFar = {
  /** How it has been read: the tones' fits joined, every tone read exactly, or refined by locate(). */
  stage: "coarse" | "joint" | "fine";
  lat: number;
  lon: number;
  start: number;
  /** The aircraft that leads it. */
  hex: string;
  /** What it is worth so far: only comparable within a stage. */
  worth: number;
};

/** Where the search's separable work runs: workers, or here. */
export type WherePieces = ScanRunner & { shape: (t: Float64Array, y: Float64Array, c: number) => Promise<Shape> };

/** One at a time, here: the evals and a device with no workers to spare. */
export const hereOnly: WherePieces = {
  size: 1,
  shape: async (t, y, c) => shapeOf(t, y, c),
  part: (tones, paths, jets, options, longest, onShare) => scanPart(tones, paths, jets, { ...options, onProgress: (done, total) => onShare(done / total) }, longest),
};

export type WhereWhenOptions = {
  /** UTC seconds: the earliest and the latest the recording may have started. */
  window: [number, number];
  /** The square to search. */
  area: Area;
  /** Ground height at a point, metres above sea level (default 0). */
  ground?: (lat: number, lon: number) => number;
  air?: Air;
  /** Where the search's separable work runs (default: here, one at a time). The result is the same. */
  pieces?: WherePieces;
  /** Spots and times refined by locate() at the end. */
  refine?: number;
  /** Answers returned. */
  answers?: number;
  /** Beyond this distance an aircraft is not heard, metres. */
  maxRange?: number;
  /** Stretches of the file searched for traces (file seconds): silence counts there. Default:
   * the segments themselves. */
  searched?: [number, number][];
  /** @deprecated Ignored: the search reads real tracks, its cost follows the flights in the window. */
  budget?: number;
  /** Called as the search goes: the stage and how far into it ("shape": each trace read on its
   * own, "smooth": the flights, "candidates": the tracks scanned, "coarse": the join, "joint":
   * every trace read, "fine": locate()). */
  onProgress?: (stage: WhereStage, done: number, total: number) => void;
  /**
   * The best guess so far, each time it changes, from the first rough one on: the search may still
   * drop it, so it says what it is ("coarse", "joint", "fine") and says nothing of confidence. The
   * answer is what whereWhen returns.
   */
  onBest?: (best: BestSoFar) => void;
  /** The evals' truth: report how the candidates near it ranked (never used to search). */
  probe?: { lat: number; lon: number; start: number };
};

const DEFAULTS = { refine: 12, answers: 5, maxRange: RANGE };

/** The aircraft that explains a trace at an answer. */
export type Explained = { trace: number; hex: string; registration: string; type: string; f0: number };

export type Answer = {
  lat: number;
  lon: number;
  /** UTC seconds of the recording's first sample. */
  start: number;
  /** locate()'s evidence score for the trace it followed (higher is better). */
  score: number;
  /** Aircraft that explain a trace well here, each counted once (higher is better). */
  evidence: number;
  /** What the flyovers heard here are worth together, in nats: minus the log of how often fits
   * that good happen at a random spot and second. Compare with `WhereWhen.searched`. */
  worth: number;
  /** Flyovers heard very well, by distinct aircraft at times apart: two or more can be trusted. */
  wellHeard: number;
  /** Aircraft that passed close during the recording and are heard in no trace. */
  silent: string[];
  /** Out on the water, away from any land (lib/core/sea.ts). */
  atSea: boolean;
  planes: Explained[];
  /** The twin spot across the leading aircraft's track, when there is a distinct one. */
  mirror: { lat: number; lon: number; score: number } | null;
};

export type Hypothesis = {
  lat: number;
  lon: number;
  start: number;
  /** The candidate's own loss, its aircraft and trace. */
  loss: number;
  hex: string;
  trace: number;
  /** Every trace read at this spot and time: the aircraft around that explains it best (index
   * into the flights used, -1 for none) and its loss; the evidence they make and what they are worth. */
  reads: { f: number; loss: number }[];
  evidence: number;
  worth: number;
  silent: string[];
  atSea: boolean;
};

export type WhereWhen = {
  answers: Answer[];
  /** The best answer's worth beats what the search's size can make by chance by MARGIN nats, two
   * flyovers or more are heard very well (wellHeard), and it leads the next distinct answer (not
   * its mirror) by LEAD nats. */
  confident: boolean;
  /** The size of the search in nats: the log of the distinct spots and starts in the square and
   * the window. An answer worth less can be chance. */
  searched: number;
  traces: number;
  flybys: Flyby[];
  /** Flights of the history within reach of the area during the window, and fits kept. */
  flights: number;
  candidates: number;
  /** With options.probe (the evals' truth): fits of each tone within 1 km and 30 s of it (and the
   * best one's loss), the first spot of the join there (rank, 0 if none), of the pool, of the exact
   * reading, every trace read at the truth, what the truth is worth and how many spots rank above. */
  probe?: { rank: number; pool: number; lite: number; fits: { n: number; loss: number }[]; truth: { hex: string; loss: number; clock: number }[]; worth?: number; evidence?: number; silent?: number; above?: number };
  /** The best distinct spots and times before the fine search (for the evals). */
  hypotheses: Hypothesis[];
  /** Wall time per stage, ms; `spots` and `fits` are counts (spots tried, fits kept). */
  ms: { shape: number; smooth: number; scan: number; join: number; joint: number; fine: number; total: number; spots: number; fits: number };
};

/** How far the best answer must lead the next one (another spot or time), in nats. */
export const LEAD = 3;
/** How far its worth must pass the size of the search, in nats. Chance alone gets far: on colsto's
 * day a wrong answer 39 km off passes it by 5.6, two flyovers heard well and 3.1 ahead of the truth
 * by the sound alone (it lies at sea: lib/core/sea.ts ranks it second now). */
export const MARGIN = 8;

const FT = 0.3048;
const RAD = Math.PI / 180;

/** Flights by 5-minute bucket, with their bounding box in that bucket. */
type Index = Map<number, { f: number; minLat: number; maxLat: number; minLon: number; maxLon: number }[]>;
const BUCKET = 300;

function indexOf(flights: Flight[]): Index {
  const index: Index = new Map();
  flights.forEach((f, i) => {
    let cur: { f: number; minLat: number; maxLat: number; minLon: number; maxLon: number } | null = null;
    let bucket = NaN;
    for (let j = 0; j < f.t.length; j++) {
      const b = Math.floor(f.t[j] / BUCKET);
      if (b !== bucket) {
        bucket = b;
        cur = { f: i, minLat: f.lat[j], maxLat: f.lat[j], minLon: f.lon[j], maxLon: f.lon[j] };
        const list = index.get(b) ?? [];
        list.push(cur);
        index.set(b, list);
      } else {
        cur!.minLat = Math.min(cur!.minLat, f.lat[j]);
        cur!.maxLat = Math.max(cur!.maxLat, f.lat[j]);
        cur!.minLon = Math.min(cur!.minLon, f.lon[j]);
        cur!.maxLon = Math.max(cur!.maxLon, f.lon[j]);
      }
    }
  });
  return index;
}

/** Flights within `range` metres of a point at some moment between two UTC times. */
function near(index: Index, lat: number, lon: number, from: number, to: number, range: number): number[] {
  const dLat = range / 111_195;
  const dLon = range / (111_195 * Math.cos(lat * RAD));
  const out = new Set<number>();
  for (let b = Math.floor(from / BUCKET); b <= Math.floor(to / BUCKET); b++) {
    for (const box of index.get(b) ?? []) {
      if (box.maxLat + dLat < lat || box.minLat - dLat > lat || box.maxLon + dLon < lon || box.minLon - dLon > lon) continue;
      out.add(box.f);
    }
  }
  return [...out];
}

/** A trace read under this loss is explained by its aircraft (an outlier costs MISS, 1.95). */
const EXPLAINS = 0.6 * MISS;
/** Spots and times read with every trace at once. */
const PICKS = 300;
/** Below this tone (Hz, at rest) a trace is not a jet's: jets raise no fits for it. */
const JET_TONE = 500;
/** A trace read under this loss is heard well (its aircraft counts as evidence). */
const GOOD = 0.4;
/** What an aircraft that passed close but explains nothing costs, in nats. */
const SILENT = 4;
/** Flyovers scanned at most, one tone each. */
const LEADS = 12;
/** Each tone's best fits that look for the other tones' fits next to them. */
const SEEDS = 100_000;
/** Spots and starts of the join read exactly, each tone against the flight found. */
const CHECKS = 30_000;
/** The best of them searched a little around (a sharp tone reads badly off its distance). */
const NUDGED = 3000;
/** Spots and times read with all the flights around (with the lead traces), then fully (PICKS of them). */
const POOL = 1000;
/** The resolution of an answer: square metres times seconds (500 m by 500 m, 10 s). */
const RESOLUTION = 2.5e5 * 10;

/** Aircraft that explain a trace well, each counted once, a trace of 30 s or more counting fully. */
function evidenceOf(reads: { f: number; loss: number }[], length: number[]): number {
  const per = new Map<number, number>();
  reads.forEach((r, ti) => {
    if (r.f < 0 || r.loss >= GOOD) return;
    const e = (1 - r.loss / GOOD) * Math.min(1, length[ti] / 30);
    per.set(r.f, Math.max(per.get(r.f) ?? 0, e));
  });
  let sum = 0;
  for (const e of per.values()) sum += e;
  return sum;
}

/** Flyovers heard very well (loss under GOOD / 2, 15 s of trace or more), by distinct aircraft, at
 * times apart (traces overlapping by less than half). */
function wellHeard(reads: { f: number; loss: number }[], shapes: Shape[]): number {
  const kept: number[] = [];
  reads.forEach((r, ti) => {
    if (r.f < 0 || r.loss >= GOOD / 2 || shapes[ti].times.length < 15) return;
    if (kept.some((k) => reads[k].f === r.f || overlapping(shapes[k], shapes[ti]))) return;
    kept.push(ti);
  });
  return kept.length;
}

const overlapping = (a: Shape, b: Shape) => {
  const [x, y] = [a.times, b.times];
  const overlap = Math.min(x[x.length - 1], y[y.length - 1]) - Math.max(x[0], y[0]);
  return overlap > 0.5 * Math.min(x[x.length - 1] - x[0], y[y.length - 1] - y[0]);
};

/** One trace per flyover (overlapping traces are one), the most confident, LEADS flyovers at most. */
function leadTraces(shapes: Shape[], confidence: number[]): number[] {
  const order = shapes.map((_, i) => i).sort((a, b) => confidence[b] - confidence[a]);
  const leads: number[] = [];
  for (const i of order) if (leads.length < LEADS && !leads.some((k) => overlapping(shapes[k], shapes[i]))) leads.push(i);
  return leads;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Polls as the page would have made them around a point and a time, from the history. */
function pollsAround(flights: Flight[], ids: number[], from: number, to: number): Poll[] {
  const polls: Poll[] = [];
  for (const i of ids) {
    const f = flights[i];
    const a = Math.max(0, firstAfter(f.t, from) - 1);
    const b = Math.min(f.t.length - 1, firstAfter(f.t, to));
    for (let j = a; j <= b; j++) {
      const baro = f.flags[j] & 1;
      const ac: PolledAircraft = { hex: f.hex, r: f.registration || undefined, t: f.type || undefined, lat: f.lat[j], lon: f.lon[j], gs: f.gs[j], track: f.track[j], geom_rate: f.vrate[j], seen_pos: 0 };
      if (baro) ac.alt_baro = f.altFt[j];
      else ac.alt_geom = f.altFt[j];
      polls.push({ now: Math.round(f.t[j] * 1000), aircraft: [ac] });
    }
  }
  return polls.sort((x, y) => x.now - y.now);
}

/**
 * Where and when the recording was made: its stack, the traces found in it (findTraces), the
 * flights of the history around the area during the window (lib/history.ts), and the window and
 * area to search.
 */
export async function whereWhen(segments: Segment[], flights: Flight[], options: WhereWhenOptions): Promise<WhereWhen> {
  const t0 = performance.now();
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) } as typeof DEFAULTS & WhereWhenOptions;
  const air = o.air ?? { groundTempC: 15 };
  const ground = o.ground ?? (() => 0);
  const atSea = seaOf(ground, o.area);
  // The stretches of the recording searched for traces, file seconds: silence counts only there.
  const ends = segments.map((g) => {
    const times = g.stack.base.times;
    return [g.offset, g.offset + times[times.length - 1] + (times[1] - times[0])] as [number, number];
  });
  const spans = options.searched ?? ends;
  const duration = Math.max(...spans.map((x) => x[1]), ...ends.map((x) => x[1]));
  const centre: Listener = { lat: o.area.lat, lon: o.area.lon, elevation: 0 };
  const half = o.area.side / 2;
  const [w0, w1] = o.window;
  const ms = { shape: 0, smooth: 0, scan: 0, join: 0, joint: 0, fine: 0, total: 0, spots: 0, fits: 0 };
  const heard = segments.flatMap((g, seg) => g.traces.map((trace) => ({ seg, trace, ...framesOf(trace, g.stack.base.times, g.offset) })));
  const searched = Math.log(((o.area.side ** 2) * Math.max(60, w1 - w0)) / RESOLUTION);
  const empty = (): WhereWhen => ({ answers: [], confident: false, searched, traces: heard.length, flybys: [], flights: 0, candidates: 0, hypotheses: [], ms: { ...ms, total: Math.round(performance.now() - t0) } });
  if (!heard.length) return empty();
  const traces = heard;

  // 1. Each trace on its own: its tone at rest (a jet's fan or not) and the leads a person can check.
  const c0 = pathSpeed(air, 300);
  const pieces = o.pieces ?? hereOnly;
  let shaped = 0;
  o.onProgress?.("shape", 0, heard.length);
  const shapes = await inParallel(heard, pieces.size, async (x) => {
    const shape = await pieces.shape(x.t, x.y, c0);
    o.onProgress?.("shape", ++shaped, heard.length);
    return shape;
  });
  const readings = shapes.map(flybyOf);
  ms.shape = Math.round(performance.now() - t0);

  // Flights that come within reach of the area while the window lasts.
  const inArea = (lat: number, lon: number, margin: number) => {
    const p = toLocal(centre, lat, lon, 0);
    return Math.abs(p[0]) <= half + margin && Math.abs(p[1]) <= half + margin;
  };
  const used: Flight[] = [];
  for (const f of flights) {
    let ok = false;
    for (let j = 0; j < f.t.length && !ok; j++) ok = f.t[j] >= w0 - 600 && f.t[j] <= w1 + duration + 600 && inArea(f.lat[j], f.lon[j], o.maxRange);
    if (ok) used.push(f);
  }
  const index = indexOf(used);
  // Each flight smoothed once: the tracks every read below is made of.
  const tS = performance.now();
  const smooth = used.map((f, i) => {
    if (i % 100 === 0) o.onProgress?.("smooth", i, used.length);
    return smoothFlight(f, centre, w0 - 600, w1 + duration + 600);
  });
  ms.smooth = Math.round(performance.now() - tS);

  // 2. Fits: for each flyover's tone, the spots and starts where a flight's real curve follows it.
  const t1 = performance.now();
  const leads = leadTraces(shapes, heard.map((x) => x.trace.confidence));
  const tones = leads.map((ti) => toneOf(ti, shapes[ti].times, shapes[ti].logs, readings[ti].f0 >= JET_TONE, c0));
  const paths = pathsOf(smooth, centre, w0 - 120, w1 + duration + 120, tones.some((t) => t.jets));
  const scan = await scanTracksWith(pieces, tones, paths, smooth, { half, window: o.window, ground: gridOfGround(ground, centre, half + o.maxRange), c: c0, maxRange: o.maxRange, onProgress: (done, total) => o.onProgress?.("candidates", done, total) });
  ms.scan = Math.round(performance.now() - t1);
  ms.spots = scan.spots;
  ms.fits = scan.fits.reduce((sum, f) => sum + f.n, 0);
  const counts = new Array(traces.length).fill(0);
  leads.forEach((ti, i) => (counts[ti] = scan.fits[i].n));
  const summary = readings.map((r, ti) => ({ ...r, candidates: counts[ti] }));

  // 3. Together: each tone's best fits, worth what they are, with the other tones' fits next to them.
  const t2 = performance.now();
  o.onProgress?.("coarse", 0, 1);
  const seeds = joinFits(scan, half, o.window, SEEDS, CHECKS, NUDGED, (ti, fi, x, y, start) => {
    const { lat, lon } = fromLocal(centre, x, y);
    return readFast(shapes[leads[ti]], smooth[fi], { lat, lon, elevation: ground(lat, lon) }, start, air, o.maxRange, 0.01, 10);
  });
  ms.join = Math.round(performance.now() - t2);
  o.onProgress?.("coarse", 1, 1);
  const tell = (stage: BestSoFar["stage"], at: { lat: number; lon: number; start: number }, hex: string, worth: number) => o.onBest?.({ stage, lat: at.lat, lon: at.lon, start: at.start, hex, worth });
  if (seeds.length) tell("coarse", { ...fromLocal(centre, seeds[0].x, seeds[0].y), start: seeds[0].start }, used[seeds[0].f].hex, seeds[0].score);
  let probe: WhereWhen["probe"];
  if (o.probe) {
    const pr = o.probe;
    const q = toLocal(centre, pr.lat, pr.lon, 0);
    const close = (x: number, y: number, start: number, m = 1000) => Math.hypot(x - q[0], y - q[1]) <= m && Math.abs(start - pr.start) <= 30;
    const fits = scan.fits.map((f) => {
      let n = 0;
      let loss = Infinity;
      for (let i = 0; i < f.n; i++) {
        if (!close(f.x[i], f.y[i], f.start[i])) continue;
        n++;
        loss = Math.min(loss, f.loss[i]);
      }
      return { n, loss };
    });
    // Each trace read at the truth itself, against the aircraft around that explains it best.
    const listener: Listener = { lat: pr.lat, lon: pr.lon, elevation: ground(pr.lat, pr.lon) };
    const around = near(index, pr.lat, pr.lon, pr.start - 60, pr.start + duration + 60, o.maxRange);
    const truth = shapes.map((s) => {
      let best = { hex: "", loss: MISS, clock: 0 };
      for (const fi of around) {
        const read = readFast(s, smooth[fi], listener, pr.start, air, o.maxRange, 0.01);
        if (read.loss < best.loss) best = { hex: used[fi].hex, loss: read.loss, clock: read.clock };
      }
      return best;
    });
    probe = { rank: seeds.findIndex((h) => close(h.x, h.y, h.start)) + 1, pool: 0, lite: 0, fits, truth };
  }

  // 4. Every trace read exactly at one spot and start: the aircraft around that explains it best,
  // the evidence (aircraft that explain a trace well, each counted once), what the lead tones are
  // worth, and the aircraft that passed close but explain nothing.
  const t3 = performance.now();
  const length = shapes.map((sh) => sh.times.length);
  const worthAt = (reads: Hypothesis["reads"]) => {
    const per = new Map<number, number>();
    leads.forEach((ti, i) => {
      const r = reads[ti];
      if (r.f >= 0) per.set(r.f, Math.max(per.get(r.f) ?? 0, worthOf(scan, i, r.loss)));
    });
    let sum = 0;
    for (const w of per.values()) sum += w;
    return sum;
  };
  const readAll = (lat: number, lon: number, start: number, which: number[], grid: number) => {
    const listener: Listener = { lat, lon, elevation: ground(lat, lon) };
    const reads: Hypothesis["reads"] = shapes.map(() => ({ f: -1, loss: MISS }));
    for (const ti of which) {
      const sh = shapes[ti];
      const [from, to] = [start + sh.times[0] - SWEEP - 40, start + sh.times[sh.times.length - 1] + SWEEP + 5];
      // Only the aircraft within reach while this trace was heard (an hour holds hundreds), and
      // no jet for a propeller's tone.
      for (const fi of near(index, lat, lon, from - 20, to + 55, o.maxRange)) {
        const f = smooth[fi];
        if (f.kind === KIND.jet && readings[ti].f0 < JET_TONE) continue;
        if (!within(f, listener, from, to, o.maxRange)) continue;
        const read = readFast(sh, f, listener, start, air, o.maxRange, 0.01, 5 * grid);
        if (read.loss < reads[ti].loss) reads[ti] = { f: fi, loss: read.loss };
      }
    }
    return { listener, reads, evidence: evidenceOf(reads, length), worth: worthAt(reads) };
  };
  // Silence: a propeller or rotor that passes within 500 m (any aircraft within 300 m) of the
  // spot while a searched stretch of the recording runs, and explains no trace.
  const silenceAt = (listener: Listener, start: number, reads: Hypothesis["reads"]) => {
    const explaining = new Set(reads.filter((r) => r.loss < EXPLAINS).map((r) => r.f));
    const silent: string[] = [];
    for (const fi of near(index, listener.lat, listener.lon, start - 60, start + duration + 60, 500)) {
      if (explaining.has(fi)) continue;
      const f = used[fi];
      const quiet = isProp(f.kind) ? 500 : 300;
      let close = false;
      for (const [from, to] of spans) {
        const a = firstAfter(f.t, start + from + 10);
        const b = firstAfter(f.t, start + to - 10);
        for (let j = a; j < b && !close; j++) {
          const q = toLocal(listener, f.lat[j], f.lon[j], f.altFt[j] * FT);
          close = Math.hypot(q[0], q[1], q[2]) < quiet;
        }
      }
      if (close) silent.push(f.hex);
    }
    return silent;
  };

  // The pool: the best spots and starts of the join, one per spot and time.
  type Pick = { lat: number; lon: number; start: number; loss: number; f: number; trace: number };
  const pool: Pick[] = [];
  const cell = (lat: number, lon: number, start: number) => `${Math.round(lat * 400)}:${Math.round(lon * 400)}:${Math.round(start / 20)}`;
  const taken = new Set<string>();
  for (const h of seeds) {
    if (pool.length >= POOL) break;
    const { lat, lon } = fromLocal(centre, h.x, h.y);
    if (taken.has(cell(lat, lon, h.start))) continue;
    // Its neighbours too: one spot and time, not 27 copies of it.
    for (const da of [-1, 0, 1]) for (const dn of [-1, 0, 1]) for (const dt of [-1, 0, 1]) taken.add(`${Math.round(lat * 400) + da}:${Math.round(lon * 400) + dn}:${Math.round(h.start / 20) + dt}`);
    pool.push({ lat, lon, start: h.start, loss: h.loss, f: h.f, trace: leads[h.tone] });
  }
  // A first reading of the pool with one trace per flyover, every second other.
  const lite = pool.map((cd) => ({ cd, ...readAll(cd.lat, cd.lon, cd.start, leads, 2) }));
  lite.sort((x, y) => y.worth - x.worth || y.evidence - x.evidence || x.cd.loss - y.cd.loss);
  if (probe && o.probe) {
    const pr = o.probe;
    const close = (c: Pick) => Math.abs(c.start - pr.start) <= 30 && Math.hypot(...offset(pr, c)) <= 1000;
    Object.assign(probe, { pool: pool.findIndex(close) + 1, lite: lite.findIndex((x) => close(x.cd)) + 1 });
  }
  // What a spot is worth by the sound alone, then with the prior against the open water.
  const heardOf = (h: { worth: number; silent: string[] }) => h.worth - SILENT * h.silent.length;
  const rankOf = (h: { worth: number; silent: string[]; atSea: boolean }) => heardOf(h) - (h.atSea ? AT_SEA : 0);
  // The best of them read with every trace, silence counted.
  const hypotheses: Hypothesis[] = [];
  const everyTrace = shapes.map((_, ti) => ti);
  let bestRead = -Infinity;
  for (const { cd } of lite.slice(0, PICKS)) {
    const { listener, reads, evidence, worth } = readAll(cd.lat, cd.lon, cd.start, everyTrace, 1);
    const silent = silenceAt(listener, cd.start, reads);
    // The fine search follows the lead tone worth most here.
    let trace = cd.trace;
    let top = -1;
    leads.forEach((ti, i) => {
      const w = reads[ti].f >= 0 ? worthOf(scan, i, reads[ti].loss) : -1;
      if (w > top) [top, trace] = [w, ti];
    });
    const hypothesis: Hypothesis = { lat: cd.lat, lon: cd.lon, start: cd.start, loss: cd.loss, hex: used[cd.f].hex, trace, reads, evidence, worth, silent, atSea: atSea(cd.lat, cd.lon) };
    hypotheses.push(hypothesis);
    const added = rankOf(hypothesis);
    if (added > bestRead) {
      bestRead = added;
      tell("joint", cd, used[cd.f].hex, added);
    }
    if (hypotheses.length % 50 === 0) {
      o.onProgress?.("joint", hypotheses.length, Math.min(PICKS, lite.length));
      await tick();
    }
  }
  hypotheses.sort((x, y) => rankOf(y) - rankOf(x) || y.evidence - x.evidence);
  keepBest(hypotheses, heardOf);
  ms.joint = Math.round(performance.now() - t3);
  if (probe && o.probe) {
    // The truth read like a hypothesis, and how many hypotheses rank above it.
    const at = readAll(o.probe.lat, o.probe.lon, o.probe.start, everyTrace, 1);
    const silent = silenceAt(at.listener, o.probe.start, at.reads);
    Object.assign(probe, { worth: at.worth, evidence: at.evidence, silent: silent.length, above: hypotheses.filter((h) => rankOf(h) > rankOf({ worth: at.worth, silent, atSea: atSea(o.probe!.lat, o.probe!.lon) })).length });
  }

  // 5. locate() around the best few, with the flight data of that time as polls, then every
  // trace read again at the spot and start it found.
  const t4 = performance.now();
  const answers: Answer[] = [];
  let bestFine = -Infinity;
  for (const [i, h] of hypotheses.slice(0, o.refine).entries()) {
    o.onProgress?.("fine", i, Math.min(o.refine, hypotheses.length));
    const ids = near(index, h.lat, h.lon, h.start - 60, h.start + duration + 60, 12_000);
    const g = segments[heard[h.trace].seg];
    const polls = pollsAround(used, ids, h.start + g.offset - 60, h.start + ends[heard[h.trace].seg][1] + 60);
    const listener = { lat: h.lat, lon: h.lon, elevation: ground(h.lat, h.lon) };
    // The segment that holds this hypothesis's trace, its first sample at h.start + offset.
    const rec = { samples: new Float32Array(0), sampleRate: 8000, start: h.start + g.offset, listener, air, polls };
    const loc = await locate(rec, { lat: h.lat, lon: h.lon, side: 1600 }, { stack: g.stack, found: g.traces, steps: [100, 25], sigmas: [0.008, 0.005], clockSpread: 3, keep: 3, spots: 1 });
    const top = loc.spots[0];
    const at = top ? { lat: top.lat, lon: top.lon, start: h.start + top.clock } : h;
    const again = readAll(at.lat, at.lon, at.start, everyTrace, 1);
    // Keep the better of the two readings: the fine search follows one trace only.
    const use = again.worth >= h.worth ? { ...at, ...again, silent: silenceAt(again.listener, at.start, again.reads) } : { ...h, listener, silent: h.silent };
    const planes: Explained[] = [];
    use.reads.forEach((r, ti) => {
      if (r.f < 0 || r.loss >= GOOD) return;
      const f = used[r.f];
      planes.push({ trace: ti, hex: f.hex, registration: f.registration, type: f.type, f0: top && ti === h.trace && top.aircraft === f.hex ? Math.round(top.f0 * 10) / 10 : 0 });
    });
    answers.push({
      lat: use.lat,
      lon: use.lon,
      start: use.start,
      score: top?.score ?? 0,
      evidence: use.evidence,
      worth: use.worth,
      wellHeard: wellHeard(use.reads, shapes),
      silent: use.silent,
      atSea: atSea(use.lat, use.lon),
      planes,
      mirror: loc.mirror ? { lat: loc.mirror.lat, lon: loc.mirror.lon, score: loc.mirror.score } : null,
    });
    const rank = rankOf({ ...use, atSea: atSea(use.lat, use.lon) });
    if (rank > bestFine) {
      bestFine = rank;
      tell("fine", use, planes[0]?.hex ?? h.hex, rank);
    }
  }
  answers.sort((x, y) => rankOf(y) - rankOf(x) || y.evidence - x.evidence);
  keepBest(answers, heardOf);
  const distinct: Answer[] = [];
  for (const ans of answers) {
    const twin = distinct.find((d) => Math.hypot(...offset(d, ans)) < 300 && Math.abs(d.start - ans.start) < 20);
    if (!twin && distinct.length < o.answers) distinct.push(ans);
  }
  ms.fine = Math.round(performance.now() - t4);
  ms.total = Math.round(performance.now() - t0);
  const best = distinct[0];
  // The next answer that is neither the same spot nor its mirror.
  const rival = best && distinct.slice(1).find((ans) => !best.mirror || Math.hypot(...offset(best.mirror, ans)) > 300 || Math.abs(ans.start - best.start) > 20);
  // One flyover is never enough over a day (on Livermore R01, thousands of aircraft, spots and
  // starts fit its one pass better than the truth): two heard well, by two aircraft, at one spot
  // and one start, worth more than the search's size can make by chance, ahead of every other answer.
  // Ahead by the sound alone: the prior against the water never raises the flag.
  const confident = !!best && best.wellHeard >= 2 && rankOf(best) >= searched + MARGIN && (!rival || rankOf(best) - heardOf(rival) >= LEAD);
  return { answers: distinct, confident, searched, traces: traces.length, flybys: summary, flights: used.length, candidates: ms.fits, probe, hypotheses: hypotheses.slice(0, 50), ms };
}

/** Metres east and north from one point to another. */
function offset(from: { lat: number; lon: number }, to: { lat: number; lon: number }): [number, number] {
  const p = toLocal({ lat: from.lat, lon: from.lon, elevation: 0 }, to.lat, to.lon, 0);
  return [p[0], p[1]];
}
