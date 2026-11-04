// Guesses from the real tracks: for each flyover heard and each flight of the history, the spots
// and starts where that flight's own Doppler curve (its turns, speed and height) follows the tone.
// A straight-pass fit (lib/core/flyby.ts) cannot find them: on colsto's hour it puts the Beech's
// closest moment 12 s off and reads a Piper turning 8 km away as a pass under 700 m.
//
// Every spot near a track is the closest point of some moment of that track, so spots are sampled
// that way: a moment of the flight every few seconds, then slant distances on each side of it. The
// curve heard there is computed once, on whole seconds of receive time, and each tone slides along
// it. Fits under a limit are kept, and the rate of fits is counted: how many flights fit that well,
// per spot and second, in the whole square and window. That rate is what a fit is worth: a flat tone
// any flight explains counts for little, a long steep one for a lot.

import { KIND, type Flight } from "../history";
import { fromLocal, toLocal, type Listener } from "./geo";

const FT = 0.3048;
const KT = 1852 / 3600;
const RAD = Math.PI / 180;

/** A stretch of a flight on whole seconds, in a flat frame around the area (east, north, height). */
export type Path = { f: number; t0: number; n: number; x: Float32Array; y: Float32Array; z: Float32Array; vx: Float32Array; vy: Float32Array; vz: Float32Array };

/** Gaps over this cut a flight in two, seconds (as lib/core/guess.ts: the track is unknown there). */
const GAP = 60;

/** Stretches of smoothed flights between two UTC times, on whole seconds. */
export function pathsOf(flights: Flight[], centre: Listener, from: number, to: number, jets = true): Path[] {
  const paths: Path[] = [];
  flights.forEach((f, fi) => {
    if (!jets && f.kind === KIND.jet) return;
    let a = 0;
    while (a < f.t.length && f.t[a] < from) a++;
    a = Math.max(0, a - 1);
    while (a < f.t.length - 1 && f.t[a] <= to) {
      let b = a + 1;
      while (b < f.t.length && f.t[b] - f.t[b - 1] <= GAP && f.t[b - 1] <= to) b++;
      const t0 = Math.ceil(f.t[a]);
      const n = Math.floor(f.t[b - 1]) - t0 + 1;
      if (n >= 10) {
        const p: Path = { f: fi, t0, n, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), vx: new Float32Array(n), vy: new Float32Array(n), vz: new Float32Array(n) };
        const { t: ft, lat, lon, altFt, track, gs, vrate } = f;
        let k = a;
        // Velocities as vectors: a track angle does not interpolate across north. Worked out once per pair of fixes.
        let pair = -1;
        let v0x = 0;
        let v0y = 0;
        let v0z = 0;
        let v1x = 0;
        let v1y = 0;
        let v1z = 0;
        for (let i = 0; i < n; i++) {
          const t = t0 + i;
          while (k < b - 2 && ft[k + 1] <= t) k++;
          const u = ft[k + 1] > ft[k] ? (t - ft[k]) / (ft[k + 1] - ft[k]) : 0;
          const q = toLocal(centre, lat[k] + u * (lat[k + 1] - lat[k]), lon[k] + u * (lon[k + 1] - lon[k]), 0);
          p.x[i] = q[0];
          p.y[i] = q[1];
          p.z[i] = (altFt[k] + u * (altFt[k + 1] - altFt[k])) * FT;
          if (k !== pair) {
            pair = k;
            const th0 = track[k] * RAD;
            const gs0 = gs[k] * KT;
            v0x = gs0 * Math.sin(th0);
            v0y = gs0 * Math.cos(th0);
            v0z = (vrate[k] * FT) / 60;
            const th1 = track[k + 1] * RAD;
            const gs1 = gs[k + 1] * KT;
            v1x = gs1 * Math.sin(th1);
            v1y = gs1 * Math.cos(th1);
            v1z = (vrate[k + 1] * FT) / 60;
          }
          p.vx[i] = v0x + u * (v1x - v0x);
          p.vy[i] = v0y + u * (v1y - v0y);
          p.vz[i] = v0z + u * (v1z - v0z);
        }
        paths.push(p);
      }
      a = b;
    }
  });
  return paths;
}

/** A tone as the scan reads it: at most FRAMES frames, whole seconds after its first frame. */
export type Tone = { trace: number; first: number; length: number; dt: Int32Array; y: Float32Array; jets: boolean; minSpeed: number; fall: number };

const FRAMES = 16;

/** Seconds of a tone the scan reads at most: its stretch of largest fall. */
const LONGEST = 90;

/** A trace's frames (file seconds, log frequency, about a second apart) thinned for the scan. */
export function toneOf(trace: number, times: Float64Array, logs: Float64Array, jets: boolean, c: number): Tone {
  let [a, b] = [0, times.length];
  if (times[b - 1] - times[0] > LONGEST) {
    let top = -Infinity;
    for (let i = 0, k = 0; i < times.length; i++) {
      while (k + 1 < times.length && times[k + 1] - times[i] <= LONGEST) k++;
      const fall = logs[i] - logs[k];
      if (fall > top) [top, a, b] = [fall, i, k + 1];
    }
  }
  const n = b - a;
  const stride = Math.max(1, Math.ceil(n / FRAMES));
  const dt: number[] = [];
  const y: number[] = [];
  for (let i = a; i < b; i += stride) {
    dt.push(Math.round(times[i] - times[a]));
    y.push(logs[i]);
  }
  // The largest fall a flight can make is 2 v / c, whatever it does: a floor on its speed.
  const head = (logs[a] + logs[Math.min(a + 1, b - 1)] + logs[Math.min(a + 2, b - 1)]) / 3;
  const tail = (logs[b - 1] + logs[Math.max(a, b - 2)] + logs[Math.max(a, b - 3)]) / 3;
  return { trace, first: times[a], length: dt[dt.length - 1], dt: Int32Array.from(dt), y: Float32Array.from(y), jets, minSpeed: 0.8 * ((c * Math.abs(head - tail)) / 2), fall: Math.abs(head - tail) };
}

export type ScanOptions = {
  /** Square half side, metres, around the frame's origin. */
  half: number;
  /** Earliest and latest start of the recording, UTC seconds. */
  window: [number, number];
  /** Ground height in the frame (x, y metres). */
  ground: (x: number, y: number) => number;
  /** Speed of sound on the path, m/s. */
  c: number;
  maxRange: number;
  /** Seconds of flight between two moments sampled. */
  every?: number;
  /** Ratio between two slant distances tried. */
  ratio?: number;
  /** Seconds past the tone's ends its closest moment may lie. */
  margin?: number;
  /** Fits kept at most per tone: the best. */
  keep?: number;
  /** Loss a fit must beat to be kept. */
  limit?: number;
  onProgress?: (done: number, total: number) => void;
};

/** A fit: a spot (frame metres), a start (UTC s), its path's flight, its loss. Columns. */
export type Fits = { n: number; x: Float32Array; y: Float32Array; start: Float64Array; f: Int32Array; loss: Float32Array; d: Float32Array };

export type Scan = {
  fits: Fits[];
  /** Per tone: expected flights fitting under each loss bin's top, at a random spot and start. */
  rate: Float64Array[];
  /** Per tone: the loss fits had to beat in the end (the rate is only known under it). */
  limits: number[];
  spots: number;
  slides: number;
};

/** Loss bins of the rate tables. */
export const BIN = 0.02;
const BINS = 100;

const SIGMA = 0.01;
const RHO_STEP = 40;
const RHO = Float32Array.from({ length: 6 * RHO_STEP + 1 }, (_, i) => Math.log1p(0.5 * (i / RHO_STEP) ** 2));
const RHO_MAX = RHO.length - 1;
const MISS = RHO[RHO_MAX];
const RHO_K = RHO_STEP / SIGMA;

const fitsOf = (cap: number): Fits => ({ n: 0, x: new Float32Array(cap), y: new Float32Array(cap), start: new Float64Array(cap), f: new Int32Array(cap), loss: new Float32Array(cap), d: new Float32Array(cap) });

function growFits(a: Fits, cap: number): Fits {
  const b = fitsOf(cap);
  b.n = a.n;
  b.x.set(a.x.subarray(0, a.n));
  b.y.set(a.y.subarray(0, a.n));
  b.start.set(a.start.subarray(0, a.n));
  b.f.set(a.f.subarray(0, a.n));
  b.loss.set(a.loss.subarray(0, a.n));
  b.d.set(a.d.subarray(0, a.n));
  return b;
}

/** Keep the best half of a fit list, returning the loss of the worst kept. */
function halve(a: Fits): number {
  const order = Array.from(a.loss.subarray(0, a.n)).sort((p, q) => p - q);
  const limit = order[a.n >> 1];
  let m = 0;
  for (let i = 0; i < a.n; i++) {
    if (a.loss[i] > limit) continue;
    a.x[m] = a.x[i];
    a.y[m] = a.y[i];
    a.start[m] = a.start[i];
    a.f[m] = a.f[i];
    a.loss[m] = a.loss[i];
    a.d[m] = a.d[i];
    m++;
  }
  a.n = m;
  return limit;
}


/** The ground read back from a grid of 500 m around the frame's origin: the scan asks millions of times. */
export function groundGrid(ground: (lat: number, lon: number) => number, centre: Listener, half: number): (x: number, y: number) => number {
  const step = 500;
  const size = Math.ceil((2 * half) / step) + 1;
  const grid = new Float32Array(size * size);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const { lat, lon } = fromLocal(centre, -half + j * step, -half + i * step);
      grid[i * size + j] = ground(lat, lon);
    }
  }
  return (x, y) => {
    const j = Math.round((x + half) / step);
    const i = Math.round((y + half) / step);
    return i < 0 || j < 0 || i >= size || j >= size ? 0 : grid[i * size + j];
  };
}

const yieldNow = () => new Promise((r) => setTimeout(r, 0));

/** Slant distances tried, metres, outward. */
const ringsOf = (ratio: number, maxRange: number) => {
  const out: number[] = [];
  for (let d = 120; d <= maxRange; d *= ratio) out.push(d);
  return out;
};

/** Every moment of every path, every slant distance on each side, every tone slid along the curve. */
/** What a scan keeps from one path to the next, and the memory its loops reuse. */
type ScanState = {
  o: ScanOptions;
  tones: Tone[];
  /** Per tone: the fall between its two ends, read before any slide. */
  falls: Float64Array;
  fits: Fits[];
  limits: number[];
  hist: Float64Array[];
  curve: Float32Array;
  R: Float64Array;
  A: Float64Array;
  res: Float32Array;
  rings: Float64Array;
  /** Per ring, (d * ratio) squared: the patch of ground a spot stands for. */
  rings2: Float64Array;
  last: Int32Array;
  speeds: Float64Array;
  anyJets: boolean;
  W: number;
  spots: number;
  slides: number;
};

/**
 * The spots along one flight's track, each read against every tone. Apart from the async loop
 * that calls it: in a loop that can be suspended V8 optimises far less, and this one runs for
 * every path of a day of flights.
 */
function scanPath(st: ScanState, p: Path, jet: boolean) {
  const { o, tones, falls, fits, limits, hist, curve, R, A, res, rings, rings2, last, anyJets, W } = st;
  const every = o.every ?? 4;
  const margin = o.margin ?? 15;
  const keep = o.keep ?? 200_000;
  const w0 = o.window[0];
  const w1 = o.window[1];
  const half = o.half;
  const maxRange = o.maxRange;
  const ground = o.ground;
  const T = tones.length;
  const c = o.c;
  if (jet && !anyJets) return;
  const { x: px, y: py, z: pz, vx, vy, vz, n: pn, t0 } = p;
  if (st.speeds.length < pn) st.speeds = new Float64Array(2 * pn);
  const speeds = st.speeds;
  last.fill(-1_000_000);
  let spots = 0;
  let slides = 0;
  for (let j = 0; j < pn; j++) {
    const speed = Math.hypot(vx[j], vy[j]);
    speeds[j] = speed;
    if (speed < 15) continue;
    const gx = px[j];
    const gy = py[j];
    if (Math.abs(gx) > half + maxRange || Math.abs(gy) > half + maxRange) continue;
    const h0 = Math.max(10, pz[j] - ground(gx, gy));
    const ux = vy[j] / speed;
    const uy = -vx[j] / speed;
    for (let ring = 0; ring < rings.length; ring++) {
      const d = rings[ring];
      if (d < h0) continue;
      // A spot this far stands for a tenth of its distance along the track (or `every` seconds);
      // a turn sweeps the far rings faster than it moves along.
      const gap = j - last[ring];
      if (gap < Math.max(every, Math.round((0.12 * d) / speed))) {
        const l = last[ring];
        const cross = (vx[l] * vy[j] - vy[l] * vx[j]) / (speeds[l] * speed + 1e-6);
        if (Math.abs(cross) < 0.1) continue;
      }
      last[ring] = j;
      const across = Math.sqrt(d * d - h0 * h0);
      // The patch of ground this spot stands for, each side of the track: for the rate of fits.
      const cell = Math.max(every * speed, 0.12 * d) * (Math.sqrt(rings2[ring] - h0 * h0) - across);
      const width = d / speed;
      const stride = Math.max(1, Math.min(4, Math.floor(width / 10)));
      for (let side = across < 1 ? 1 : -1; side <= 1; side += 2) {
        const lx = gx + side * across * ux;
        const ly = gy + side * across * uy;
        if (Math.abs(lx) > half || Math.abs(ly) > half) continue;
        const lz = ground(lx, ly);
        spots++;
        // No tone can read this spot: the curve below would be for nothing.
        const dx0 = px[j] - lx;
        const dy0 = py[j] - ly;
        const dz0 = pz[j] - lz;
        const moment = t0 + j + Math.sqrt(dx0 * dx0 + dy0 * dy0 + dz0 * dz0) / c;
        let wanted = false;
        for (let ti = 0; ti < T && !wanted; ti++) {
          const tone = tones[ti];
          if ((jet && !tone.jets) || speed < tone.minSpeed) continue;
          const s0 = moment - tone.first;
          wanted = !(s0 + margin < w0 || s0 - tone.length - margin > w1);
        }
        if (!wanted) continue;
        // The curve: emission on whole seconds around the moment, then on whole seconds of
        // receive time from the moment's sound arriving (far spots every stride seconds).
        const from = j - stride * Math.floor(Math.min(W + 8, j) / stride);
        const to = j + Math.min(W + 8, pn - 1 - j);
        let m = 0;
        let hereR = 0;
        for (let e = from; e <= to; e += stride, m++) {
          const dx = px[e] - lx;
          const dy = py[e] - ly;
          const dz = pz[e] - lz;
          const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
          R[m] = e - j + r / c;
          if (e === j) hereR = R[m];
          const a = -(vx[e] * dx + vy[e] * dy + vz[e] * dz) / (r * c);
          // -log(1 - a), to the third order.
          A[m] = r < maxRange ? a + a * a * (0.5 + a / 3) : NaN;
        }
        if (m < 2) continue;
        let q = 0;
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = -W; i <= W; i++) {
          const u = hereR + i;
          while (q < m - 2 && R[q + 1] <= u) q++;
          if (u < R[0] || u > R[m - 1]) curve[i + W] = NaN;
          else {
            const v = A[q] + ((u - R[q]) / (R[q + 1] - R[q])) * (A[q + 1] - A[q]);
            curve[i + W] = v;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        const start0 = t0 + j + hereR;
        for (let ti = 0; ti < T; ti++) {
          const tone = tones[ti];
          if ((jet && !tone.jets) || speed < tone.minSpeed || hi - lo < tone.fall - 0.03) continue;
          const dt = tone.dt;
          const y = tone.y;
          const length = tone.length;
          // Only the starts in the window: outside it this tone cannot have been heard here.
          const s0 = start0 - tone.first;
          if (s0 + margin < w0 || s0 - length - margin > w1) continue;
          const nf = dt.length;
          const end = nf - 1;
          const fall = falls[ti];
          const limit = limits[ti] * nf;
          const d0 = dt[0];
          const d1 = dt[1];
          const d2 = dt[end - 1];
          const d3 = dt[end];
          const counts = hist[ti];
          let best = Infinity;
          let at = 0;
          for (let i0 = -length - margin; i0 <= margin; i0 += stride) {
            // The two ends first: most slides stop here.
            const base = W + i0;
            const ends = curve[base + d0] + curve[base + d1] - curve[base + d2] - curve[base + d3];
            if (Math.abs(ends - fall) > 0.06) continue;
            slides++;
            let count = 0;
            let sum = 0;
            for (let k = 0; k < nf; k++) {
              const v = curve[base + dt[k]];
              if (v === v) sum += res[count++] = y[k] - v;
            }
            if (count * 2 < nf) continue;
            const mean = sum / count;
            let l = (nf - count) * MISS;
            for (let k = 0; k < count && l < limit; k++) {
              const z = Math.abs(res[k] - mean) * RHO_K;
              l += z < RHO_MAX ? RHO[z | 0] : MISS;
            }
            if (l >= limit) continue;
            counts[Math.min(BINS - 1, Math.floor(l / nf / BIN))] += cell * stride;
            if (l < best) {
              best = l;
              at = i0;
            }
          }
          if (best === Infinity) continue;
          const start = s0 + at;
          if (start < w0 || start > w1) continue;
          let list = fits[ti];
          if (list.n === list.x.length) {
            if (list.n >= keep) {
              limits[ti] = halve(list);
              if (best >= limits[ti] * nf) continue;
            } else fits[ti] = list = growFits(list, Math.min(keep, 2 * list.n));
          }
          const a = list.n++;
          list.x[a] = lx;
          list.y[a] = ly;
          list.start[a] = start;
          list.f[a] = p.f;
          list.loss[a] = best / nf;
          list.d[a] = d;
        }
      }
    }
  }
  st.spots += spots;
  st.slides += slides;
}

export async function scanTracks(tones: Tone[], paths: Path[], flights: Flight[], o: ScanOptions): Promise<Scan> {
  const ratio = o.ratio ?? 1.12;
  const margin = o.margin ?? 15;
  const [w0, w1] = o.window;
  const longest = Math.max(...tones.map((t) => t.length));
  const W = longest + margin + 2;
  const rings = ringsOf(ratio, o.maxRange);
  const st: ScanState = {
    o,
    tones,
    falls: Float64Array.from(tones, ({ y, dt }) => y[0] + y[1] - y[dt.length - 2] - y[dt.length - 1]),
    fits: tones.map(() => fitsOf(4096)),
    limits: tones.map(() => o.limit ?? 0.5),
    hist: tones.map(() => new Float64Array(BINS)),
    curve: new Float32Array(2 * W + 1).fill(NaN),
    R: new Float64Array(2 * W + 64),
    A: new Float64Array(2 * W + 64),
    res: new Float32Array(FRAMES + 1),
    rings: Float64Array.from(rings),
    rings2: Float64Array.from(rings, (d) => (d * ratio) ** 2),
    last: new Int32Array(rings.length),
    speeds: new Float64Array(4096),
    anyJets: tones.some((t) => t.jets),
    W,
    spots: 0,
    slides: 0,
  };
  let done = 0;
  for (const p of paths) {
    if (++done % 200 === 0) {
      o.onProgress?.(done, paths.length);
      await yieldNow();
    }
    scanPath(st, p, flights[p.f].kind === KIND.jet);
  }
  const { fits, limits, hist, spots, slides } = st;
  // Cumulative: expected flights under each bin's top at a random spot and second.
  const volume = (2 * o.half) ** 2 * Math.max(60, w1 - w0);
  const rate = hist.map((h) => {
    const out = new Float64Array(BINS);
    let sum = 0;
    for (let b = 0; b < BINS; b++) out[b] = (sum += h[b]) / volume;
    // An exact read can beat every coarse fit: what never happened on the grid is not impossible.
    const first = out.find((r) => r > 0) ?? 1 / volume;
    for (let b = 0; b < BINS && out[b] === 0; b++) out[b] = first;
    return out;
  });
  return { fits, rate, limits, spots, slides };
}

/** Fits of one tone sorted by (start bin, x cell), for looking up spots and starts close by. */
type FitIndex = { order: Int32Array; offsets: Int32Array; bins: number; cells: number; t0: number };

/** Fits this close (a spot within metres, a start within seconds) may be the same spot and start. */
export const JOIN = { metres: 1000, seconds: 10 };

function indexFits(f: Fits, half: number, window: [number, number]): FitIndex {
  const t0 = window[0] - 8;
  const bins = Math.ceil((window[1] - window[0] + 16) / JOIN.seconds) + 1;
  const cells = Math.ceil((2 * half) / JOIN.metres) + 1;
  const offsets = new Int32Array(bins * cells + 1);
  const key = new Int32Array(f.n);
  for (let i = 0; i < f.n; i++) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor((f.start[i] - t0) / JOIN.seconds)));
    const c = Math.min(cells - 1, Math.max(0, Math.floor((f.x[i] + half) / JOIN.metres)));
    key[i] = b * cells + c;
    offsets[key[i] + 1]++;
  }
  for (let i = 1; i < offsets.length; i++) offsets[i] += offsets[i - 1];
  const fill = offsets.slice();
  const order = new Int32Array(f.n);
  for (let i = 0; i < f.n; i++) order[fill[key[i]]++] = i;
  return { order, offsets, bins, cells, t0 };
}

/** A spot and a start held up by the tones that fit close to it. */
export type Seed = { x: number; y: number; start: number; f: number; tone: number; loss: number; score: number };

/** One tone read exactly against one flight at a spot and start (the caller's readFast). */
export type ReadOne = (tone: number, f: number, x: number, y: number, start: number) => { loss: number; clock: number };

/** Steps of the small search around a seed, metres: its fits come from a coarse grid. */
const NUDGES = [300, 150];

/**
 * The best spots and starts. Each tone's best fits look up the best fit of every other tone close
 * by (the coarse score, one flight counted once); the `checks` best distinct ones are then read
 * exactly, each tone against the flight found: only the tones that truly agree on that one spot and
 * start still count. On colsto's hour the coarse score alone ranks the truth 45,000th, since a box
 * of 2 km by 2 km and 20 s offers each tone hundreds of chances; read exactly, nothing beats it.
 */
export function joinFits(scan: Scan, half: number, window: [number, number], seeds: number, checks: number, nudged: number, read: ReadOne): Seed[] {
  const T = scan.fits.length;
  const indexes = scan.fits.map((f) => indexFits(f, half, window));
  /** The best fit of tone tj close to a point: its loss and flight in `found`. */
  const found = { loss: Infinity, f: -1 };
  const lookup = (tj: number, x: number, y: number, start: number) => {
    const g = scan.fits[tj];
    const ix = indexes[tj];
    const bin = Math.floor((start - ix.t0) / JOIN.seconds);
    const cell = Math.floor((x + half) / JOIN.metres);
    found.loss = Infinity;
    found.f = -1;
    for (let b = Math.max(0, bin - 1); b <= Math.min(ix.bins - 1, bin + 1); b++) {
      for (let c = Math.max(0, cell - 1); c <= Math.min(ix.cells - 1, cell + 1); c++) {
        const k = b * ix.cells + c;
        for (let o = ix.offsets[k]; o < ix.offsets[k + 1]; o++) {
          const i = ix.order[o];
          if (g.loss[i] >= found.loss || Math.abs(g.y[i] - y) > JOIN.metres || Math.abs(g.x[i] - x) > JOIN.metres || Math.abs(g.start[i] - start) > JOIN.seconds) continue;
          found.loss = g.loss[i];
          found.f = g.f[i];
        }
      }
    }
  };
  const per = new Float64Array(T);
  const who = new Int32Array(T);
  /** One flight counted once: its best tone. */
  const total = () => {
    let sum = 0;
    for (let i = 0; i < T; i++) {
      if (per[i] <= 0) continue;
      let top = true;
      for (let j = 0; j < T && top; j++) if (j !== i && who[j] === who[i] && (per[j] > per[i] || (per[j] === per[i] && j < i))) top = false;
      if (top) sum += per[i];
    }
    return sum;
  };
  const out: Seed[] = [];
  scan.fits.forEach((f, ti) => {
    // A fit worth nothing leads only when its tone has nothing better: the others find it anyway.
    const order = Array.from({ length: f.n }, (_, i) => i).sort((p, q) => f.loss[p] - f.loss[q]);
    const worthy = order.filter((a) => worthOf(scan, ti, f.loss[a]) > 0);
    for (const a of (worthy.length ? worthy : order).slice(0, seeds)) {
      for (let tj = 0; tj < T; tj++) {
        if (tj === ti) {
          [per[tj], who[tj]] = [worthOf(scan, ti, f.loss[a]), f.f[a]];
          continue;
        }
        lookup(tj, f.x[a], f.y[a], f.start[a]);
        [per[tj], who[tj]] = found.f >= 0 ? [worthOf(scan, tj, found.loss), found.f] : [0, -1];
      }
      out.push({ x: f.x[a], y: f.y[a], start: f.start[a], f: f.f[a], tone: ti, loss: f.loss[a], score: total() });
    }
  });
  out.sort((p, q) => q.score - p.score || p.loss - q.loss);
  // The best distinct ones (one per 500 m and 20 s) read exactly.
  const taken = new Set<number>();
  const cell = (x: number, y: number, start: number) => (Math.round(x / 500) + 1000) * 4_000_000_000 + (Math.round(y / 500) + 1000) * 2_000_000 + Math.round((start - window[0]) / 20);
  const checked: Seed[] = [];
  const flightsOf = (h: Seed) => {
    const out = new Int32Array(T);
    for (let tj = 0; tj < T; tj++) {
      lookup(tj, h.x, h.y, h.start);
      out[tj] = tj === h.tone ? h.f : found.f;
    }
    return out;
  };
  /** Every tone read against its flight at one point: the score, and the worthiest tone's clock. */
  const readSeed = (flights: Int32Array, x: number, y: number, start: number) => {
    let sum = 0;
    let top = -1;
    let clock = 0;
    for (let tj = 0; tj < T; tj++) {
      if (flights[tj] < 0) {
        [per[tj], who[tj]] = [0, -1];
        continue;
      }
      const r = read(tj, flights[tj], x, y, start);
      sum += r.loss;
      [per[tj], who[tj]] = [worthOf(scan, tj, r.loss), flights[tj]];
      if (per[tj] > top) [top, clock] = [per[tj], r.clock];
    }
    return { score: total(), loss: sum, clock };
  };
  for (const h of out) {
    if (checked.length >= checks) break;
    const k = cell(h.x, h.y, h.start);
    if (taken.has(k)) continue;
    taken.add(k);
    checked.push({ ...h, score: readSeed(flightsOf(h), h.x, h.y, h.start).score });
  }
  checked.sort((p, q) => q.score - p.score || p.loss - q.loss);
  // The best of them nudged: a sharp tone reads badly 6 % off its distance, where the grid can leave it.
  for (const h of checked.slice(0, nudged)) {
    const flights = flightsOf(h);
    let best = readSeed(flights, h.x, h.y, h.start);
    let [x, y] = [h.x, h.y];
    for (const step of NUDGES) {
      const [x0, y0] = [x, y];
      for (const dx of [-step, 0, step]) {
        for (const dy of [-step, 0, step]) {
          if (!dx && !dy) continue;
          const r = readSeed(flights, x0 + dx, y0 + dy, h.start);
          if (r.score > best.score || (r.score === best.score && r.loss < best.loss)) [best, x, y] = [r, x0 + dx, y0 + dy];
        }
      }
    }
    Object.assign(h, { x, y, start: h.start + best.clock, score: best.score });
  }
  return checked.sort((p, q) => q.score - p.score || p.loss - q.loss);
}

/** Minus the log of how often a fit this good happens at a random spot and second. */
export function surprise(rate: Float64Array, loss: number): number {
  const b = Math.min(rate.length - 1, Math.max(0, Math.floor(loss / BIN)));
  return -Math.log(Math.min(1, Math.max(rate[b], 1e-12)));
}

/**
 * Nats of surprise a fit must pass to count at all, and it counts for what lies above. Summed bare,
 * surprises add up anywhere: over the many tones of an hour, every spot collects some (Fisher's
 * sum: one nat per tone on average, by chance alone). On colsto's hour, 23 tones gave a spot 45 km
 * off 29 nats and 6 aircraft, each a so-so fit.
 */
export const FLOOR = 5;

/** What a fit of this loss is worth, for tone `ti` of a scan: 0 for what any flight could do. */
export function worthOf(scan: Scan, ti: number, loss: number): number {
  return loss < scan.limits[ti] ? Math.max(0, surprise(scan.rate[ti], loss) - FLOOR) : 0;
}
