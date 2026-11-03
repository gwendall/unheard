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
// 1. Shape (lib/core/flyby.ts). Each trace fitted to the curve of a straight, steady flyby: for
//    every speed, the distance and the moment of closest approach that fit (flybys(): the leads a
//    person can check without any history).
// 2. Candidates. An aircraft of the history flying at a speed the trace accepts, at a height
//    below the distance it gives, puts the listener on two lines along its track (one each side:
//    the mirror) and the recording's start at one time for each point of its track.
// 3. Pairs. Two flyovers heard apart must agree on one spot and one start: the candidates of two
//    such traces that agree are read first.
// 4. The real track. Each candidate is scored again with the aircraft's own track (smoothed once
//    per flight: turns, climbs, speed changes), its clock swept a few seconds.
// 5. Together. The best distinct spots and times are read with every trace at once, and lose
//    ground for every aircraft that passed close during the recording but is heard nowhere
//    (silence rules spots out).
// 6. Fine. locate() searches around the best few, with the flight data of that time, and its
//    evidence score ranks them.

import type { Poll, PolledAircraft } from "../adsb";
import { isProp, KIND, type Flight } from "../history";
import { pathSpeed, type Air } from "./doppler";
import { flybyOf, framesOf, shapeOf, SPEEDS, WIDTHS, type Flyby, type Segment, type Shape } from "./flyby";
import { toLocal, type Listener } from "./geo";
import { firstAfter, MISS, RANGE, readFast, smoothFlight, SWEEP, within } from "./guess";
import { locate, type Area } from "./locate";

export { findSegments, flybys, type Flyby, type Segment } from "./flyby";
export { readAt } from "./guess";

export type WhereWhenOptions = {
  /** UTC seconds: the earliest and the latest the recording may have started. */
  window: [number, number];
  /** The square to search. */
  area: Area;
  /** Ground height at a point, metres above sea level (default 0). */
  ground?: (lat: number, lon: number) => number;
  air?: Air;
  /** Spots and times refined by locate() at the end. */
  refine?: number;
  /** Answers returned. */
  answers?: number;
  /** Beyond this distance an aircraft is not heard, metres. */
  maxRange?: number;
  /** Stretches of the file searched for traces (file seconds): silence counts there. Default:
   * the segments themselves. */
  searched?: [number, number][];
  /** Candidates read with their aircraft's track at most (3 M: two to four minutes of CPU in Node on a Mac). */
  budget?: number;
  /** Called as the search goes: the stage and how far into it. */
  onProgress?: (stage: "candidates" | "coarse" | "joint" | "fine", done: number, total: number) => void;
  /** The evals' truth: report how the candidates near it ranked (never used to search). */
  probe?: { lat: number; lon: number; start: number };
};

const DEFAULTS = { refine: 12, answers: 5, maxRange: RANGE, budget: 3_000_000 };

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
  /** Flyovers heard very well, by distinct aircraft at times apart: two or more can be trusted. */
  wellHeard: number;
  /** Aircraft that passed close during the recording and are heard in no trace. */
  silent: string[];
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
   * into the flights used, -1 for none) and its loss; the evidence they make. */
  reads: { f: number; loss: number }[];
  evidence: number;
  silent: string[];
};

export type WhereWhen = {
  answers: Answer[];
  /** The best answer hears two flyovers or more very well (wellHeard) and leads the next distinct
   * answer (not its mirror) by LEAD aircraft. */
  confident: boolean;
  traces: number;
  flybys: Flyby[];
  /** Flights of the history within reach of the area during the window, and candidates scored. */
  flights: number;
  candidates: number;
  /** With options.probe: per trace, whether the straight-flyby fit accepted any speed; the rank
   * (1-based, 0 if none) and loss of the best candidate within 500 m and 30 s of the probe; the
   * best loss of all. */
  probe?: { rank: number; loss: number; best: number; accepted: number; pairRank: number; pairs: number; truth: { hex: string; loss: number; clock: number }[]; evidence?: number; silent?: number; above?: number; pool?: number; lite?: number };
  /** The best distinct spots and times before the fine search (for the evals). */
  hypotheses: Hypothesis[];
  /** Wall time per stage, ms; `pairs` and `read` are counts (agreeing pairs, candidates read). */
  ms: { shape: number; smooth: number; candidates: number; pairs: number; read: number; coarse: number; joint: number; fine: number; total: number };
};

/** How far the best answer must lead the next one (another spot or time), in aircraft heard. */
export const LEAD = 1;

const FT = 0.3048;
const KT = 1852 / 3600;
const RAD = Math.PI / 180;
const R = 6_371_008.8;

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

/** Seconds of flight between two candidates of one aircraft: under twice the sweep. */
const THIN = 6;
/** A trace read under this loss is explained by its aircraft (an outlier costs MISS, 1.95). */
const EXPLAINS = 0.6 * MISS;
/** Slant distances tried for a candidate: every 10 %, at most 6 per point of a flight. */
const D_STEP = 1.1;
const D_MAX = 6;
/** Spots and times read with every trace at once. */
const PICKS = 300;
/** Below this tone (Hz, at rest) a trace is not a jet's: jets raise no candidates for it. */
const JET_TONE = 500;

// ---------------------------------------------------------------------------------------------

/** An aircraft (index into the flights used), the trace it would explain, a spot and a start;
 * the pass's width d / v (s) and, once read, its loss. */
type Candidate = { f: number; trace: number; lat: number; lon: number; start: number; width: number; loss: number; prior: number };

/** A trace read under this loss is heard well (its aircraft counts as evidence). */
const GOOD = 0.4;
/** What an aircraft that passed close but explains nothing costs, in aircraft heard. */
const SILENT = 0.5;
/** The first reading of the pool uses this many traces at most, one per flyover. */
const LEADS = 12;
/** Candidates one trace raises at most, the best-fitting speeds and distances first. */
const PER_TRACE = 300_000;
/** Spots and times read first (with the lead traces), then fully (PICKS of them). */
const POOL = 3000;

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

/** One trace per flyover (overlapping traces are one), the strongest, LEADS flyovers at most:
 * all of them when there are few traces. */
function leadTraces(shapes: Shape[], confidence: number[]): number[] {
  const order = shapes.map((_, i) => i).sort((a, b) => confidence[b] - confidence[a]);
  if (shapes.length <= LEADS) return order;
  const leads: number[] = [];
  for (const i of order) if (leads.length < LEADS && !leads.some((k) => overlapping(shapes[k], shapes[i]))) leads.push(i);
  return leads;
}

/** Two candidates agree when their spots are this close (m) and their starts (s). */
const AGREE = { metres: 1000, seconds: 10 };
/** Pairs kept at most. */
const MAX_PAIRS = 2_000_000;

/**
 * Pairs of candidates from two traces heard apart (overlapping by less than half the shorter)
 * that agree: spots within AGREE.metres, starts within AGREE.seconds. Read from the straight-flyby
 * spots and starts, before any track is read, so only the pairs need reading. Indexes into
 * `candidates`.
 */
function agree(candidates: Candidate[], shapes: Shape[]): [number, number][] {
  const apart = shapes.map((sa) => shapes.map((sb) => !overlapping(sa, sb)));
  if (!apart.some((row) => row.some(Boolean))) return [];
  // Cells of 0.01 degree (about 1 km) and AGREE.seconds, numbered.
  let t0 = Infinity;
  for (const c of candidates) t0 = Math.min(t0, c.start);
  const cellOf = (la: number, lo: number, t: number) => ((la + 9000) * 40_000 + (lo + 18_000)) * 100_000 + t;
  const grid = new Map<number, number[]>();
  const at = candidates.map((c) => [Math.floor(c.lat * 100), Math.floor(c.lon * 100), Math.floor((c.start - t0) / AGREE.seconds)]);
  candidates.forEach((_, i) => {
    const k = cellOf(at[i][0], at[i][1], at[i][2]);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  });
  const pairs: [number, number][] = [];
  for (let i = 0; i < candidates.length && pairs.length < MAX_PAIRS; i++) {
    const c = candidates[i];
    const row = apart[c.trace];
    for (const da of [-1, 0, 1])
      for (const dn of [-1, 0, 1])
        for (const dt of [-1, 0, 1]) {
          for (const j of grid.get(cellOf(at[i][0] + da, at[i][1] + dn, at[i][2] + dt)) ?? []) {
            const d = candidates[j];
            if (j <= i || d.trace === c.trace || !row[d.trace] || Math.abs(d.start - c.start) > AGREE.seconds) continue;
            if (Math.hypot(...offset(c, d)) <= AGREE.metres) pairs.push([i, j]);
          }
        }
  }
  return pairs;
}

/** A pair read: one candidate at the midpoint, its loss the two traces' weighted by length. */
function joinPair(c: Candidate, d: Candidate, shapes: Shape[]): Candidate {
  const [na, nb] = [shapes[c.trace].times.length, shapes[d.trace].times.length];
  return { f: c.f, trace: c.trace, lat: (c.lat + d.lat) / 2, lon: (c.lon + d.lon) / 2, start: (c.start + d.start) / 2, width: c.width, loss: (c.loss * na + d.loss * nb) / (na + nb), prior: 0 };
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
  const ms = { shape: 0, smooth: 0, candidates: 0, pairs: 0, read: 0, coarse: 0, joint: 0, fine: 0, total: 0 };
  const heard = segments.flatMap((g, seg) => g.traces.map((trace) => ({ seg, trace, ...framesOf(trace, g.stack.base.times, g.offset) })));
  const empty = (): WhereWhen => ({ answers: [], confident: false, traces: heard.length, flybys: [], flights: 0, candidates: 0, hypotheses: [], ms: { ...ms, total: Math.round(performance.now() - t0) } });
  if (!heard.length) return empty();
  const traces = heard;

  // 1. Each trace against the straight-flyby family.
  const c0 = pathSpeed(air, 300);
  const shapes = heard.map((x) => shapeOf(x.t, x.y, c0));
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
  const smooth = used.map((f) => smoothFlight(f, centre));
  ms.smooth = Math.round(performance.now() - tS);

  // 2. Candidates: every point of every flight whose speed and height a trace accepts.
  const t1 = performance.now();
  const candidates: Candidate[] = [];
  const V = SPEEDS.length;
  const W = WIDTHS.length;
  const readings = shapes.map(flybyOf);
  // A trace that pins the speed down (within a factor of 1.6) raises candidates; one that fits
  // any speed (a short or flat stretch) only joins the reading, unless no trace pins it down.
  const pins = readings.map((r) => r.speeds[1] <= 1.6 * r.speeds[0]);
  const raising = pins.some(Boolean) ? pins : pins.map(() => true);
  for (let ti = 0; ti < traces.length; ti++) {
    if (!raising[ti]) continue;
    const s = shapes[ti];
    // A jet's tone is its fan (above 500 Hz); a propeller's blade-pass is far lower.
    const jets = readings[ti].f0 >= JET_TONE;
    // Per speed, the widths accepted there or one speed step away (a climb or a slight turn
    // bends the curve: measured on Livermore, the truth's speed is off the accepted band by up to
    // 6 m/s in 3 recordings of 40), each with the moment of closest approach of its best fit.
    const cellOf = new Int32Array(V * W).fill(-1);
    const span: [number, number][] = [];
    const edge: [number, number][] = [];
    for (let vi = 0; vi < V; vi++) {
      let lo = W;
      let hi = -1;
      for (let wi = 0; wi < W; wi++) {
        let best = -1;
        for (let u = Math.max(0, vi - 1); u <= Math.min(V - 1, vi + 1); u++) if (s.loss[u * W + wi] <= s.accept && (best < 0 || s.loss[u * W + wi] < s.loss[best])) best = u * W + wi;
        if (best < 0) continue;
        cellOf[vi * W + wi] = best;
        lo = Math.min(lo, wi);
        hi = Math.max(hi, wi);
      }
      // The distances accepted, and one step of D_STEP beyond each end (on colsto's hour the
      // Beech 350 passed at 3.6 km, its tone accepting 1.5 to 3.5 km).
      span.push(hi >= 0 ? [WIDTHS[lo] / D_STEP, WIDTHS[hi] * D_STEP] : [NaN, NaN]);
      edge.push([lo, hi]);
    }
    // Every candidate of this trace, in two passes: count them by fit, then keep the best-fitting
    // fits up to PER_TRACE candidates (a 300 km square holds nine times a 100 km one).
    const visit = (emit: (cell: number, cd: Candidate) => void) => {
      for (let fi = 0; fi < smooth.length; fi++) {
        const f = smooth[fi];
        if (f.kind === KIND.jet && !jets) continue;
        // A candidate every THIN seconds of flight at most: the clock sweep covers the spots between.
        let lastT = -Infinity;
        for (let j = 0; j < f.t.length; j++) {
          const tj = f.t[j];
          if (tj < w0 - 300 || tj > w1 + duration + 300 || tj - lastT < THIN) continue;
          const v = f.gs[j] * KT;
          const vi = Math.round((v - SPEEDS[0]) / 4);
          if (vi < 0 || vi >= V || !Number.isFinite(span[vi][0])) continue;
          if (!inArea(f.lat[j], f.lon[j], 8000)) continue;
          lastT = tj;
          const h = Math.max(0, f.altFt[j] * FT - ground(f.lat[j], f.lon[j]));
          const th = f.track[j] * RAD;
          // Slant distances the trace accepts at this speed (the curve's width is d / v).
          const d0 = Math.max(span[vi][0] * v, h + 10);
          const d1 = Math.min(span[vi][1] * v, o.maxRange);
          if (d1 < d0) continue;
          const steps = Math.min(D_MAX, Math.max(1, Math.ceil(Math.log(d1 / d0) / Math.log(D_STEP))));
          for (let k = 0; k < steps; k++) {
            const d = d0 * (d1 / d0) ** ((k + 0.5) / steps);
            const wi = Math.min(edge[vi][1], Math.max(edge[vi][0], Math.round(Math.log(d / v / WIDTHS[0]) / Math.log(WIDTHS[1] / WIDTHS[0]))));
            const cell = cellOf[vi * W + wi];
            if (cell < 0) continue;
            const x = Math.sqrt(Math.max(0, d * d - h * h));
            const start = tj + d / pathSpeed(air, h) - s.at[cell];
            if (start < w0 - SWEEP || start > w1 + SWEEP) continue;
            for (const side of x > 0 ? [1, -1] : [1]) {
              // Across the track: right of it is (cos, -sin) in east-north.
              const de = side * x * Math.cos(th);
              const dn = -side * x * Math.sin(th);
              const lat = f.lat[j] + dn / R / RAD;
              const lon = f.lon[j] + de / (R * Math.cos(f.lat[j] * RAD)) / RAD;
              if (!inArea(lat, lon, 0)) continue;
              emit(cell, { f: fi, trace: ti, lat, lon, start, width: d / v, loss: Infinity, prior: s.loss[cell] - s.best });
            }
          }
        }
      }
    };
    const count = new Int32Array(V * W);
    let total = 0;
    visit((cell) => (count[cell]++, total++));
    const allowed = new Uint8Array(V * W).fill(1);
    if (total > PER_TRACE) {
      allowed.fill(0);
      const cells = Array.from(count.keys()).filter((c) => count[c] > 0).sort((x, y) => s.loss[x] - s.loss[y]);
      let kept = 0;
      for (const c of cells) {
        if (kept && kept + count[c] > PER_TRACE) break;
        allowed[c] = 1;
        kept += count[c];
      }
    }
    visit((cell, cd) => allowed[cell] && candidates.push(cd));
  }
  ms.candidates = Math.round(performance.now() - t1);
  const counts = new Array(traces.length).fill(0);
  for (const cd of candidates) counts[cd.trace]++;
  const summary = readings.map((r, ti) => ({ ...r, candidates: counts[ti] }));
  o.onProgress?.("candidates", candidates.length, candidates.length);

  // 4. Each candidate with its aircraft's real track. Two flyovers heard apart must agree on one
  // spot and one start: the candidates of two such traces that agree are read first.
  const t2 = performance.now();
  const agreeing = agree(candidates, shapes);
  ms.pairs = agreeing.length;
  // At most `budget` reads: the agreeing pairs' candidates first (half the budget at most), then
  // every other candidate, those whose speed and distance fit their trace best first.
  const byPrior = (x: number, y: number) => candidates[x].prior - candidates[y].prior;
  const paired = [...new Set(agreeing.flat())].sort(byPrior).slice(0, o.budget >> 1);
  const inPair = new Uint8Array(candidates.length);
  for (const i of paired) inPair[i] = 1;
  const rest = candidates.map((_, i) => i).filter((i) => !inPair[i]);
  const toRead = paired.concat(rest.length > o.budget - paired.length ? rest.sort(byPrior).slice(0, o.budget - paired.length) : rest);
  ms.read = toRead.length;
  for (let r = 0; r < toRead.length; r++) {
    const i = toRead[r];
    const cd = candidates[i];
    const s = shapes[cd.trace];
    const listener: Listener = { lat: cd.lat, lon: cd.lon, elevation: ground(cd.lat, cd.lon) };
    const read = readFast(s, smooth[cd.f], listener, cd.start, air, o.maxRange, 0.01, cd.width);
    cd.loss = read.loss;
    cd.start += read.clock;
    if (r % 2000 === 1999) {
      o.onProgress?.("coarse", r + 1, toRead.length);
      await tick();
    }
  }
  ms.coarse = Math.round(performance.now() - t2);
  const pairs = agreeing.map(([i, j]) => joinPair(candidates[i], candidates[j], shapes)).filter((c) => Number.isFinite(c.loss)).sort((x, y) => x.loss - y.loss);
  let probe: WhereWhen["probe"];
  if (o.probe) {
    const pr = o.probe;
    const sorted = candidates.filter((c) => Number.isFinite(c.loss)).sort((a, b) => a.loss - b.loss);
    const rank = sorted.findIndex((c) => Math.abs(c.start - pr.start) <= 30 && Math.hypot(...offset(pr, c)) <= 500) + 1;
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
    const near500 = (c: Candidate) => Math.abs(c.start - pr.start) <= 30 && Math.hypot(...offset(pr, c)) <= 500;
    probe = { pairRank: pairs.findIndex(near500) + 1, pairs: pairs.length, rank, loss: rank ? sorted[rank - 1].loss : NaN, best: sorted[0]?.loss ?? NaN, accepted: candidates.filter((c) => Math.abs(c.start - pr.start) <= 30 && Math.hypot(...offset(pr, c)) <= 500).length, truth };
  }

  // 5. Together. Every trace read at one spot and start: the aircraft around that explains it best,
  // the evidence (aircraft that explain a trace well, each counted once) and the aircraft that
  // passed close but explain nothing.
  const t3 = performance.now();
  const length = shapes.map((sh) => sh.times.length);
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
    return { listener, reads, evidence: evidenceOf(reads, length) };
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

  // The pool: the agreeing pairs first, then each trace that raised candidates brings its best
  // (one trace's crowd never hides another's), one per spot and time.
  candidates.sort((x, y) => x.loss - y.loss);
  const pool: Candidate[] = [];
  const cell = (lat: number, lon: number, start: number) => `${Math.round(lat * 400)}:${Math.round(lon * 400)}:${Math.round(start / 20)}`;
  const taken = new Set<string>();
  const take = (cd: Candidate) => {
    if (taken.has(cell(cd.lat, cd.lon, cd.start))) return false;
    // Its neighbours too: one spot and time, not 27 copies of it.
    for (const da of [-1, 0, 1]) for (const dn of [-1, 0, 1]) for (const dt of [-1, 0, 1]) taken.add(`${Math.round(cd.lat * 400) + da}:${Math.round(cd.lon * 400) + dn}:${Math.round(cd.start / 20) + dt}`);
    pool.push(cd);
    return true;
  };
  for (const cd of pairs) if (pool.length < POOL / 4) take(cd);
  const quota = Math.ceil((POOL - pool.length) / Math.max(1, raising.filter(Boolean).length));
  const per = new Array(traces.length).fill(0);
  for (const cd of candidates) {
    if (!Number.isFinite(cd.loss) || pool.length >= POOL) break;
    if (per[cd.trace] < quota && take(cd)) per[cd.trace]++;
  }
  // A first reading of the pool with one trace per flyover (the strongest), every second other.
  const leads = leadTraces(shapes, heard.map((x) => x.trace.confidence));
  const lite = pool.map((cd, i) => ({ cd, evidence: readAll(cd.lat, cd.lon, cd.start, leads, 2).evidence, i }));
  lite.sort((x, y) => y.evidence - x.evidence || x.cd.loss - y.cd.loss);
  if (probe && o.probe) {
    // How many of the pool sit within 1 km and 30 s of the truth, and the first one's rank.
    const pr = o.probe;
    const close = (c: Candidate) => Math.abs(c.start - pr.start) <= 30 && Math.hypot(...offset(pr, c)) <= 1000;
    Object.assign(probe, { pool: pool.filter(close).length, lite: lite.findIndex((x) => close(x.cd)) + 1 });
  }
  // The best of them read with every trace, silence counted.
  const hypotheses: Hypothesis[] = [];
  const everyTrace = shapes.map((_, ti) => ti);
  for (const { cd } of lite.slice(0, PICKS)) {
    const { listener, reads, evidence } = readAll(cd.lat, cd.lon, cd.start, everyTrace, 1);
    const silent = silenceAt(listener, cd.start, reads);
    hypotheses.push({ lat: cd.lat, lon: cd.lon, start: cd.start, loss: cd.loss, hex: used[cd.f].hex, trace: cd.trace, reads, evidence, silent });
    if (hypotheses.length % 50 === 0) {
      o.onProgress?.("joint", hypotheses.length, Math.min(PICKS, lite.length));
      await tick();
    }
  }
  const rankOf = (h: { evidence: number; silent: string[] }) => h.evidence - SILENT * h.silent.length;
  hypotheses.sort((x, y) => rankOf(y) - rankOf(x));
  ms.joint = Math.round(performance.now() - t3);
  if (probe && o.probe) {
    // The truth read like a hypothesis, and how many hypotheses rank above it.
    const at = readAll(o.probe.lat, o.probe.lon, o.probe.start, everyTrace, 1);
    const silent = silenceAt(at.listener, o.probe.start, at.reads);
    const truth = { evidence: at.evidence, silent };
    Object.assign(probe, { evidence: at.evidence, silent: silent.length, above: hypotheses.filter((h) => rankOf(h) > rankOf(truth)).length });
  }

  // 6. locate() around the best few, with the flight data of that time as polls, then every
  // trace read again at the spot and start it found.
  const t4 = performance.now();
  const answers: Answer[] = [];
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
    const use = again.evidence >= h.evidence ? { ...at, ...again, silent: silenceAt(again.listener, at.start, again.reads) } : { ...h, listener, silent: h.silent };
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
      wellHeard: wellHeard(use.reads, shapes),
      silent: use.silent,
      planes,
      mirror: loc.mirror ? { lat: loc.mirror.lat, lon: loc.mirror.lon, score: loc.mirror.score } : null,
    });
  }
  answers.sort((x, y) => rankOf(y) - rankOf(x) || y.score - x.score);
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
  // One aircraft heard is never enough over a day: on Livermore R01 about 1,200 other aircraft,
  // spots and starts fit its one flyby better than the truth. Two flyovers heard well, by two
  // aircraft, at one spot and one start, and a lead of LEAD over every other answer.
  const confident = !!best && best.wellHeard >= 2 && (!rival || rankOf(best) - rankOf(rival) >= LEAD);
  return { answers: distinct, confident, traces: traces.length, flybys: summary, flights: used.length, candidates: candidates.length, probe, hypotheses: hypotheses.slice(0, 50), ms };
}

/** Metres east and north from one point to another. */
function offset(from: { lat: number; lon: number }, to: { lat: number; lon: number }): [number, number] {
  const p = toLocal({ lat: from.lat, lon: from.lon, elevation: 0 }, to.lat, to.lon, 0);
  return [p[0], p[1]];
}
