// Locate me: where the phone was, from its recording and the flight tracks around, without its
// GPS. The phone's position only gives the area to search (the 0.1° cell the server already
// sees). For a straight, steady flyby the curve's shape fixes the slant distance at the closest
// approach and the clock fixes where along the track: two spots, one each side of the track. A
// turn, a climb or a second aircraft breaks the tie.
//
// Each track is built once around the area's centre and shifted to every point tried. The cheap
// search fits the blind traces (lib/core/trace.ts) to each aircraft's modelled curve, the tone
// in closed form from the log residuals, the clock swept, coarse to fine; the matcher's evidence
// score then ranks the best few spots. Every trace is searched on its own as well as all of them
// together: a tone no aircraft explains (a car, a generator) must not drag the answer away.

import { collect } from "../adsb";
import { heardAt, type Air } from "./doppler";
import { fromLocal, toLocal, type Listener } from "./geo";
import { curveScore } from "./match";
import type { Recording } from "./pipeline";
import { buildStack, type Stack } from "./spectrogram";
import { findTraces, REAL_RANGE, type Trace, type TraceOptions } from "./trace";
import { buildTrack, type Track } from "./track";

const R = 6_371_008.8;
const RAD = Math.PI / 180;

/** A square to search, centred on a point, `side` metres wide. */
export type Area = { lat: number; lon: number; side: number };

/** What the server sees of a listener: its position rounded to 0.1°, about 10 km. */
export function serverArea(listener: { lat: number; lon: number }, side = 20_000): Area {
  return { lat: Math.round(listener.lat * 10) / 10, lon: Math.round(listener.lon * 10) / 10, side };
}

/**
 * The same track seen from (e, n) metres east and north of the listener it was built around, at
 * the same height. The smoothing is linear, so shifting the smoothed points is about the same as
 * smoothing shifted fixes (tests: within a metre and 0.01 % of Doppler factor 7 km away): the
 * flat-Earth frame's east scale (cos latitude) and the curvature folded into "up" are carried
 * over to the new point.
 */
export function shiftTrack(track: Track, e: number, n: number, lat = 0): Track {
  const k = Math.cos((lat + n / R / RAD) * RAD) / Math.cos(lat * RAD);
  const points = track.points.map((q) => {
    const pe = q.p[0];
    const pn = q.p[1];
    const ne = (pe - e) * k;
    const nn = pn - n;
    // toLocal folds the Earth's drop (e² + n²) / 2R into up: swap the old centre's for the new
    // one's. Velocities are the reported ones in every frame, as buildTrack keeps them.
    const up = q.p[2] + (pe * pe + pn * pn - ne * ne - nn * nn) / (2 * R);
    return { t: q.t, p: [ne, nn, up] as [number, number, number], v: q.v };
  });
  return { points, start: track.start, end: track.end };
}

export type LocateOptions = {
  /** Grid steps, coarse to fine, metres. */
  steps?: number[];
  /** Cells kept and refined at each level, for each way of reading the traces. */
  keep?: number;
  /** Relative spread of a trace around its model at each level: wide while the grid is coarse. */
  sigmas?: number[];
  /** How far the phone's clock may be from the flight data's, seconds, either way. */
  clockSpread?: number;
  /** Misfit added at a clock of ±clockSpread: only enough to choose among spots that fit alike. */
  clockPrior?: number;
  /** Beyond this distance an aircraft is not heard, metres. */
  maxRange?: number;
  /** Spots returned. */
  spots?: number;
  traces?: TraceOptions;
  /** The traces already found in this stack (wherewhen searches many spots with the same ones). */
  found?: Trace[];
  /** A stack already built for this recording (analyze() builds one), to skip building it again. */
  stack?: Stack;
};

const DEFAULTS = {
  steps: [500, 100, 25],
  keep: 4,
  sigmas: [0.02, 0.008, 0.005],
  clockSpread: 2,
  clockPrior: 0.02,
  maxRange: 10_000,
  spots: 5,
  traces: REAL_RANGE,
};

/**
 * From this evidence score on, the best spot can be trusted: in evals/locate of 2026-11-03, the
 * 16 best spots at 12 or more were all within 1 km of the truth and 15 within 250 m (median
 * 60 m; the other one on the mirror side); under 12, 4 of 36 within 250 m.
 */
export const CONFIDENT = 12;

export type Spot = {
  lat: number;
  lon: number;
  /** Metres east and north of the area's centre. */
  e: number;
  n: number;
  /** Robust misfit of the traces to the modelled curves (lower is better). */
  loss: number;
  /** The matcher's evidence along the modelled curves, in spreads of wrong tones (higher is better). */
  score: number;
  /** Aircraft that explains the trace, its tone (Hz) and the clock (s, as in Match). */
  aircraft: string;
  f0: number;
  clock: number;
};

export type Location = {
  /** Distinct spots, best first (at least 150 m apart). */
  spots: Spot[];
  /** The best spot's score reaches CONFIDENT. */
  confident: boolean;
  /** The twin of the best spot across the track of its aircraft, when there is a distinct one. */
  mirror: Spot | null;
  /** The coarse search as a heat map: log-likelihood per cell (row by north, west to east). */
  grid: { lat: number; lon: number; step: number; size: number; logLik: Float32Array };
  traces: Trace[];
  /** Aircraft in the polls that could be heard from somewhere in the area. */
  aircraft: number;
  ms: number;
};

type Plane = { id: string; track: Track; window: Track["points"] };

type Ctx = {
  stack: Stack;
  start: number;
  air: Air;
  lat: number;
  planes: Plane[];
  traces: Trace[];
  /** Frames the traces span, with room for the clock. */
  lo: number;
  hi: number;
  hop: number;
  clocks: number;
  maxRange: number;
  /** Log frequency of every trace frame. */
  logs: Float64Array[];
  clockSpread: number;
  clockPrior: number;
};

type Fit = { loss: number; plane: number; logF0: number; clock: number };
/**
 * One point tried, read in each of 1 + traces ways: way 0 fits every trace with one clock (the
 * phone has one), way 1 + t trace t alone. loss[way] and fits[way] (one per trace for way 0).
 */
type Cell = { e: number; n: number; loss: number[]; fits: Fit[][] };

/** Frames between the curve points modelled at each level: 1 s, 0.5 s, then every frame. */
const STRIDES = [4, 2, 1];
const strideOf = (level: number) => STRIDES[Math.min(level, STRIDES.length - 1)];

const rho = (x: number) => Math.log1p(0.5 * x * x);
/** What a trace frame the aircraft cannot explain costs: an outlier at 6 spreads. */
const MISS = rho(6);

/**
 * Misfit of the traces at one point: each trace takes the aircraft and the tone that explain it
 * best. Curves are read every `stride` frames and the clock moves by whole strides, so a coarse
 * pass models a quarter of the frames.
 */
function fitCell(ctx: Ctx, e: number, n: number, sigma: number, stride: number, only: Set<number> | null): Cell {
  const { stack, start, air, planes, traces, lo, hi, hop, clocks, maxRange, logs, clockPrior } = ctx;
  const steps = Math.floor(clocks / stride);
  const nc = 2 * steps + 1;
  // Per trace and clock: the best loss so far over the aircraft, and which one.
  const best = traces.map(() => Array.from({ length: nc }, () => ({ loss: MISS, plane: -1, logF0: 0 })));
  const span = Math.floor((hi - lo) / stride) + 1;
  const logF = new Float64Array(span);
  const resid = new Float64Array(span);
  const tFirst = start + stack.base.times[0];
  for (let a = 0; a < planes.length; a++) {
    if (only && !only.has(a)) continue;
    // Too far from this point all along the traces: not heard here.
    if (!planes[a].window.some((q) => (q.p[0] - e) ** 2 + (q.p[1] - n) ** 2 < maxRange * maxRange)) continue;
    const track = shiftTrack(planes[a].track, e, n, ctx.lat);
    for (let j = 0; j < span; j++) {
      const h = heardAt(track, tFirst + (lo + j * stride) * hop, air);
      logF[j] = h && h.range < maxRange ? Math.log(h.factor) : NaN;
    }
    for (let ti = 0; ti < traces.length; ti++) {
      const tr = traces[ti];
      // First trace frame on the stride's lattice.
      const k0 = tr.from + ((((lo - tr.from) % stride) + stride) % stride);
      for (let c = 0; c < nc; c++) {
        const shift = (c - steps) * stride;
        let count = 0;
        let total = 0;
        for (let k = k0; k <= tr.to; k += stride) {
          total++;
          const v = logF[(k + shift - lo) / stride];
          if (Number.isFinite(v)) resid[count++] = logs[ti][k - tr.from] - v;
        }
        if (count < total / 2) continue;
        const r = resid.subarray(0, count).sort();
        const m = r[count >> 1];
        let loss = (total - count) * MISS;
        for (let i = 0; i < count; i++) loss += rho((r[i] - m) / sigma);
        loss /= total;
        if (loss < best[ti][c].loss) best[ti][c] = { loss, plane: a, logF0: m };
      }
    }
  }
  // A whisper of prior on the clock: along one straight track every clock fits as well (the spot
  // slides with it), and the phone's clock is most likely nearly right.
  const prior = (c: number) => clockPrior * (((c - steps) * stride * hop) / ctx.clockSpread) ** 2;
  const length = traces.map((t) => t.to - t.from + 1);
  const all = length.reduce((a, b) => a + b, 0);
  const pick = (cost: (c: number) => number) => {
    let at = 0;
    for (let c = 1; c < nc; c++) if (cost(c) < cost(at)) at = c;
    return at;
  };
  const joint = pick((c) => best.reduce((sum, b, ti) => sum + b[c].loss * length[ti], 0) / all + prior(c));
  const loss = [best.reduce((sum, b, ti) => sum + b[joint].loss * length[ti], 0) / all + prior(joint)];
  const fits = [best.map((b) => ({ ...b[joint], clock: (joint - steps) * stride * hop }))];
  for (const b of best) {
    const own = pick((c) => b[c].loss + prior(c));
    loss.push(b[own].loss + prior(own));
    fits.push([{ ...b[own], clock: (own - steps) * stride * hop }]);
  }
  return { e, n, loss, fits };
}

/** The best cells read one way, at least `apart` metres from each other. */
function distinct(cells: Cell[], way: number, apart: number, count: number): Cell[] {
  const out: Cell[] = [];
  for (const c of [...cells].sort((a, b) => a.loss[way] - b.loss[way])) {
    if (out.every((o) => Math.hypot(o.e - c.e, o.n - c.n) >= apart)) out.push(c);
    if (out.length === count) break;
  }
  return out;
}

const planesOf = (c: Cell, way: number) => new Set(c.fits[way].map((f) => f.plane).filter((p) => p >= 0));

/** The evidence of one aircraft's curve heard from (e, n), its best tone and clock near a guess. */
function evidenceAt(ctx: Ctx, plane: number, e: number, n: number, logF0: number, clock: number): { raw: number; f0: number; clock: number; factor: Float32Array } {
  const { stack, start, air, maxRange } = ctx;
  const times = stack.base.times;
  const track = shiftTrack(ctx.planes[plane].track, e, n, ctx.lat);
  const curveAt = (c: number) => {
    const factor = new Float32Array(times.length);
    const weight = new Float32Array(times.length);
    for (let k = 0; k < times.length; k++) {
      const h = heardAt(track, start + times[k] + c, air);
      factor[k] = h && h.range < maxRange ? h.factor : NaN;
      weight[k] = h ? Math.min(1, (1000 / h.range) ** 2) : 0;
    }
    return { factor, weight };
  };
  // The trace may follow a harmonic: the tone, its half or its third, whichever reads best.
  const here = curveAt(clock);
  let base = Math.exp(logF0);
  let top = -Infinity;
  for (const div of [1, 2, 3]) {
    const raw = curveScore(stack, here.factor, Math.exp(logF0) / div, undefined, here.weight);
    if (raw > top) [top, base] = [raw, Math.exp(logF0) / div];
  }
  let best = { raw: top, f0: base, clock, factor: here.factor };
  for (let dc = -0.375; dc <= 0.375 + 1e-9; dc += 0.125) {
    const { factor, weight } = Math.abs(dc) < 1e-9 ? here : curveAt(clock + dc);
    for (let df = -0.006; df <= 0.006 + 1e-9; df += 0.001) {
      const raw = curveScore(stack, factor, base * (1 + df), undefined, weight);
      if (raw > best.raw) best = { raw, f0: base * (1 + df), clock: clock + dc, factor };
    }
  }
  return best;
}

/** The spread of wrong tones along a curve: what the evidence of a right one is measured in. */
function nullOf(stack: Stack, factor: Float32Array, f0: number): { mid: number; spread: number } {
  const wrong: number[] = [];
  for (let f = 40; f <= 500; f += 3.7) if (Math.abs(f / f0 - Math.round(f / f0)) * f0 > 5 && Math.abs(f - f0 / 2) > 5) wrong.push(curveScore(stack, factor, f));
  wrong.sort((a, b) => a - b);
  const mid = wrong[wrong.length >> 1];
  const dev = wrong.map((w) => Math.abs(w - mid)).sort((a, b) => a - b);
  return { mid, spread: 1.4826 * dev[dev.length >> 1] + 1e-9 };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Where the recording was made, searched over `area` (default: 20 km around the 0.1° cell of
 * rec.listener) among the aircraft of rec.polls. rec.listener's position is only the search's
 * reference: its latitude and longitude never reach the answer otherwise.
 */
export async function locate(rec: Recording, area: Area = serverArea(rec.listener), options: LocateOptions = {}): Promise<Location> {
  const t0 = performance.now();
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) } as typeof DEFAULTS & LocateOptions;
  const centre: Listener = { lat: area.lat, lon: area.lon, elevation: rec.listener.elevation };
  const stack = o.stack ?? buildStack(rec.samples, rec.sampleRate);
  const traces = o.found ?? findTraces(stack, o.traces).traces;
  const times = stack.base.times;
  const hop = times.length > 1 ? times[1] - times[0] : 0.25;
  const half = area.side / 2;
  const clocks = Math.round(o.clockSpread / hop);
  const lo = (traces.length ? Math.min(...traces.map((t) => t.from)) : 0) - clocks;
  const hi = (traces.length ? Math.max(...traces.map((t) => t.to)) : times.length - 1) + clocks;

  // Every aircraft that comes within range of the area while the traces last, its track built
  // once around the centre, and its points meanwhile (to skip it quickly where it is never near).
  const planes: Plane[] = [];
  const from = rec.start + times[0] + (lo - 40) * hop;
  const to = rec.start + times[0] + (hi + 40) * hop;
  for (const [hex, s] of collect(rec.polls)) {
    const track = s.fixes.length ? buildTrack(s.fixes, centre) : null;
    const window = track?.points.filter((q) => q.t >= from && q.t <= to) ?? [];
    if (track && window.some((q) => Math.max(Math.abs(q.p[0]), Math.abs(q.p[1])) < half + o.maxRange)) planes.push({ id: hex, track, window });
  }
  const size = Math.floor(area.side / o.steps[0]) + 1;
  const logLik = new Float32Array(size * size).fill(NaN);
  const grid = { lat: area.lat, lon: area.lon, step: o.steps[0], size, logLik };
  const done = (spots: Spot[], mirror: Spot | null): Location => ({ spots, confident: (spots[0]?.score ?? 0) >= CONFIDENT, mirror, grid, traces, aircraft: planes.length, ms: Math.round(performance.now() - t0) });
  if (!traces.length || !planes.length) return done([], null);

  const logs = traces.map((t) => Float64Array.from({ length: t.to - t.from + 1 }, (_, i) => Math.log(t.freq[t.from + i])));
  const ctx: Ctx = { stack, start: rec.start, air: rec.air, lat: area.lat, planes, traces, lo, hi, hop, clocks, maxRange: o.maxRange, logs, clockSpread: o.clockSpread, clockPrior: o.clockPrior };
  const ways = traces.length + 1;

  // Coarse: the whole square.
  const coarse: Cell[] = [];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const c = fitCell(ctx, -half + j * o.steps[0], -half + i * o.steps[0], o.sigmas[0], STRIDES[0], null);
      logLik[i * size + j] = -c.loss[0];
      coarse.push(c);
    }
    await tick();
  }
  // Finer, each way of reading the traces on its own: around its best distinct cells, with the
  // aircraft they chose. The best point of a cell is within half a step of its centre.
  const pools: Cell[][] = Array.from({ length: ways }, () => coarse);
  for (let level = 1; level < o.steps.length; level++) {
    const step = o.steps[level];
    const reach = Math.ceil((0.6 * o.steps[level - 1]) / step) * step;
    for (let way = 0; way < ways; way++) {
      const next: Cell[] = [];
      for (const seed of distinct(pools[way], way, o.steps[level - 1] * 1.5, o.keep)) {
        const only = planesOf(seed, way);
        for (let de = -reach; de <= reach + 1e-9; de += step) for (let dn = -reach; dn <= reach + 1e-9; dn += step) next.push(fitCell(ctx, seed.e + de, seed.n + dn, o.sigmas[level], strideOf(level), only));
      }
      pools[way] = next;
      await tick();
    }
  }

  // Rank the best spots of every way by the matcher's evidence along the curves of their aircraft.
  const sigma = o.sigmas[o.sigmas.length - 1];
  const nulls = new Map<number, { mid: number; spread: number }>();
  const spotOf = (c: Cell, way: number): Spot | null => {
    // The aircraft of the strongest trace leads; for all traces at once, other aircraft that
    // clearly stand out add their own evidence (two aircraft at once pin the spot down).
    const byScore = way ? [0] : traces.map((_, i) => i).sort((a, b) => traces[b].score - traces[a].score);
    const order = byScore.map((i) => c.fits[way][i]).filter((f) => f.plane >= 0);
    let score = 0;
    let lead: Spot | null = null;
    const seen = new Set<number>();
    for (const fit of order) {
      if (seen.has(fit.plane)) continue;
      seen.add(fit.plane);
      const ev = evidenceAt(ctx, fit.plane, c.e, c.n, fit.logF0, fit.clock);
      let nul = nulls.get(fit.plane);
      if (!nul) nulls.set(fit.plane, (nul = nullOf(stack, ev.factor, ev.f0)));
      const z = (ev.raw - nul.mid) / nul.spread;
      if (!lead) {
        const { lat, lon } = fromLocal(centre, c.e, c.n);
        lead = { lat, lon, e: c.e, n: c.n, loss: c.loss[way], score: 0, aircraft: planes[fit.plane].id, f0: ev.f0, clock: ev.clock };
        score += z;
      } else if (z > 4) score += z;
    }
    return lead && { ...lead, score };
  };
  // Spots along one track fit alike, each with its own clock: the nearer to the phone's, the better.
  const rank = (x: Spot) => x.score - 0.25 * (x.clock / o.clockSpread) ** 2;
  const candidates: { spot: Spot; way: number }[] = [];
  for (let way = 0; way < ways; way++) {
    for (const c of distinct(pools[way], way, 150, 2)) {
      const spot = spotOf(c, way);
      if (spot) candidates.push({ spot, way });
    }
  }
  candidates.sort((a, b) => rank(b.spot) - rank(a.spot));
  const spots: Spot[] = [];
  for (const { spot } of candidates) if (spots.length < o.spots && spots.every((x) => Math.hypot(x.e - spot.e, x.n - spot.n) >= 150)) spots.push(spot);
  if (!spots.length) return done([], null);
  const way = candidates[0].way;

  // The best spot sits in a basin of cells that fit nearly as well (along the track above all,
  // where the clock trades for position): its centre, weighted by how well each cell fits, is a
  // better guess than its single best cell. Trace frames are not independent: about one in eight.
  const frames = (way ? traces[way - 1].to - traces[way - 1].from + 1 : traces.reduce((sum, t) => sum + t.to - t.from + 1, 0)) / 8;
  const basin = pools[way].filter((c) => Math.hypot(c.e - spots[0].e, c.n - spots[0].n) < 400);
  const floor = Math.min(...basin.map((c) => c.loss[way]));
  let [we, wn, wsum] = [0, 0, 0];
  for (const c of basin) {
    const w = Math.exp(-(c.loss[way] - floor) * frames);
    [we, wn, wsum] = [we + w * c.e, wn + w * c.n, wsum + w];
  }
  const middle = spotOf(fitCell(ctx, we / wsum, wn / wsum, sigma, 1, null), way);
  if (middle && rank(middle) > rank(spots[0]) - 1) spots[0] = middle;

  // The mirror: the best spot reflected across its aircraft's ground track at the closest point.
  const top = spots[0];
  const plane = planes.findIndex((p) => p.id === top.aircraft);
  const track = shiftTrack(planes[plane].track, top.e, top.n, area.lat);
  let closest: { d: number; p: number[]; v: number[] } | null = null;
  for (let k = 0; k < times.length; k++) {
    const h = heardAt(track, rec.start + times[k] + top.clock, rec.air);
    if (h && (!closest || h.range < closest.d)) {
      const q = track.points.reduce((a, b) => (Math.abs(b.t - h.emitted) < Math.abs(a.t - h.emitted) ? b : a));
      const dt = h.emitted - q.t;
      closest = { d: h.range, p: [q.p[0] + q.v[0] * dt, q.p[1] + q.v[1] * dt], v: q.v };
    }
  }
  let mirror: Spot | null = null;
  if (closest) {
    const speed = Math.hypot(closest.v[0], closest.v[1]) || 1;
    const [ux, uy] = [closest.v[0] / speed, closest.v[1] / speed];
    // The aircraft's ground point, across its track from the spot (the shifted frame's origin):
    // the spot's twin is twice that far, on the other side.
    const side = -closest.p[0] * uy + closest.p[1] * ux;
    if (Math.abs(2 * side) > 50) {
      const [me, mn] = [top.e - 2 * side * uy, top.n + 2 * side * ux];
      const fine = o.steps[o.steps.length - 1];
      const around: Cell[] = [];
      for (let de = -4 * fine; de <= 4 * fine + 1e-9; de += fine) for (let dn = -4 * fine; dn <= 4 * fine + 1e-9; dn += fine) around.push(fitCell(ctx, me + de, mn + dn, sigma, 1, new Set([plane])));
      mirror = spotOf(distinct(around, way, 0, 1)[0], way);
    }
  }
  return done(spots, mirror);
}

/** Metres east and north of `from` to a point: what the evals measure the answer with. */
export function offsetOf(from: { lat: number; lon: number }, lat: number, lon: number): [number, number] {
  const p = toLocal({ lat: from.lat, lon: from.lon, elevation: 0 }, lat, lon, 0);
  return [p[0], p[1]];
}
