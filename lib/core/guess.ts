// Check one guess: a spot and a start, each trace of a recording read against the aircraft that
// flew around then (lib/history.ts), the one that explains it best and how well. The reading the
// search (lib/core/wherewhen.ts) makes millions of times, and what a page can show to say why a
// guess holds: the flights smoothed once (the Rauch-Tung-Striebel smoother of lib/core/track.ts,
// in scalars), then for each moment of the trace the sound that left the aircraft earlier, its
// Doppler factor from the aircraft's speed toward the listener, the tone at rest fitted, the
// clock swept a few seconds.

import type { Flight } from "../history";
import { heardAt, pathSpeed, type Air } from "./doppler";
import { framesOf, shapeOf, type Segment, type Shape } from "./flyby";
import { fromLocal, toLocal, type Listener } from "./geo";
import { buildTrack, TRUST, type Fix, type Track } from "./track";

const FT = 0.3048;
const KT = 1852 / 3600;
const RAD = Math.PI / 180;
const R = 6_371_008.8;

export const rho = (x: number) => Math.log1p(0.5 * x * x);
/** What a trace frame no aircraft explains costs: an outlier at 6 spreads (as in locate). */
export const MISS = rho(6);
/** Beyond this distance an aircraft is not heard, metres (the search's default too). */
export const RANGE = 10_000;

// ---------------------------------------------------------------------------------------------
// Flights: positions as fixes, smoothed once.

export function fixAt(f: Flight, j: number): Fix {
  const rad = f.track[j] * RAD;
  const gs = f.gs[j] * KT;
  return { t: f.t[j], lat: f.lat[j], lon: f.lon[j], altitude: f.altFt[j] * FT, velocity: [gs * Math.sin(rad), gs * Math.cos(rad), (f.vrate[j] * FT) / 60] };
}

/** First index with t >= x. */
export function firstAfter(t: Float64Array, x: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A flight's track between two UTC times, around a listener; null when it has under two fixes there. */
function trackOf(f: Flight, from: number, to: number, listener: Listener): Track | null {
  const a = Math.max(0, firstAfter(f.t, from) - 1);
  const b = Math.min(f.t.length - 1, firstAfter(f.t, to));
  if (b - a < 1) return null;
  // A gap of more than a minute inside: the track is unknown there.
  for (let j = a + 1; j <= b; j++) if (f.t[j] - f.t[j - 1] > 60) return null;
  const fixes: Fix[] = [];
  for (let j = a; j <= b; j++) fixes.push(fixAt(f, j));
  return buildTrack(fixes, listener, { smooth: false });
}

/** Whether a flight comes within `range` metres of a listener between two UTC times. */
export function within(f: Flight, listener: Listener, from: number, to: number, range: number): boolean {
  const a = Math.max(0, firstAfter(f.t, from) - 1);
  const b = Math.min(f.t.length - 1, firstAfter(f.t, to));
  for (let j = a; j <= b; j++) {
    const q = toLocal(listener, f.lat[j], f.lon[j], f.altFt[j] * FT);
    if (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] < range * range) return true;
  }
  return false;
}

/**
 * One axis of a flight smoothed: the Rauch-Tung-Striebel smoother of lib/core/track.ts (state
 * position, velocity, acceleration; positions and velocities measured; TRUST's noise), written out
 * in scalars so a whole day of flights is smoothed once (30 times faster than building smoothed
 * tracks spot by spot). Raw fixes read badly: on Livermore R01 the truth's trace misfit is 0.49
 * with them, 0.25 smoothed.
 */
function smoothAxis(t: Float64Array, z: Float64Array, w: Float64Array, axis: number): void {
  const n = t.length;
  const sp = TRUST.position[axis] ** 2;
  const sv = TRUST.velocity[axis] ** 2;
  const q = TRUST.jerk;
  const XF = new Float64Array(3 * n);
  const PF = new Float64Array(9 * n);
  const XP = new Float64Array(3 * n);
  const PP = new Float64Array(9 * n);
  let x = [z[0], w[0], 0];
  let P = [sp, 0, 0, 0, sv, 0, 0, 0, 1];
  const predict = (x: number[], P: number[], dt: number): [number[], number[]] => {
    const F = [1, dt, (dt * dt) / 2, 0, 1, dt, 0, 0, 1];
    const d2 = dt * dt;
    const d3 = d2 * dt;
    const Q = [(q * d3 * d2) / 20, (q * d2 * d2) / 8, (q * d3) / 6, (q * d2 * d2) / 8, (q * d3) / 3, (q * d2) / 2, (q * d3) / 6, (q * d2) / 2, q * dt];
    const FP = mul3(F, P);
    const FPFt = mul3t(FP, F);
    return [[x[0] + dt * x[1] + (d2 / 2) * x[2], x[1] + dt * x[2], x[2]], FPFt.map((v, i) => v + Q[i])];
  };
  for (let k = 0; k < n; k++) {
    if (k > 0) [x, P] = predict(x, P, t[k] - t[k - 1]);
    XP.set(x, 3 * k);
    PP.set(P, 9 * k);
    // Measure position and velocity.
    const a = P[0] + sp;
    const b = P[1];
    const c = P[3];
    const d = P[4] + sv;
    const det = a * d - b * c;
    const [i00, i01, i10, i11] = [d / det, -b / det, -c / det, a / det];
    const K = [0, 1, 2].map((r) => [P[3 * r] * i00 + P[3 * r + 1] * i10, P[3 * r] * i01 + P[3 * r + 1] * i11]);
    const y0 = z[k] - x[0];
    const y1 = w[k] - x[1];
    x = x.map((v, r) => v + K[r][0] * y0 + K[r][1] * y1);
    P = P.map((v, i) => v - K[Math.floor(i / 3)][0] * P[i % 3] - K[Math.floor(i / 3)][1] * P[3 + (i % 3)]);
    XF.set(x, 3 * k);
    PF.set(P, 9 * k);
  }
  let xs = Array.from(XF.subarray(3 * (n - 1)));
  z[n - 1] = xs[0];
  w[n - 1] = xs[1];
  for (let k = n - 2; k >= 0; k--) {
    const dt = t[k + 1] - t[k];
    const F = [1, dt, (dt * dt) / 2, 0, 1, dt, 0, 0, 1];
    const C = mul3(mul3t(Array.from(PF.subarray(9 * k, 9 * k + 9)), F), inv3(Array.from(PP.subarray(9 * (k + 1), 9 * (k + 1) + 9))));
    const e = [0, 1, 2].map((i) => xs[i] - XP[3 * (k + 1) + i]);
    xs = [0, 1, 2].map((i) => XF[3 * k + i] + C[3 * i] * e[0] + C[3 * i + 1] * e[1] + C[3 * i + 2] * e[2]);
    z[k] = xs[0];
    w[k] = xs[1];
  }
}

/** 3 x 3 matrices, row-major: a b, a b transposed, the inverse. */
const mul3 = (a: number[], b: number[]) => [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => a[3 * Math.floor(i / 3)] * b[i % 3] + a[3 * Math.floor(i / 3) + 1] * b[3 + (i % 3)] + a[3 * Math.floor(i / 3) + 2] * b[6 + (i % 3)]);
const mul3t = (a: number[], b: number[]) => [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => a[3 * Math.floor(i / 3)] * b[3 * (i % 3)] + a[3 * Math.floor(i / 3) + 1] * b[3 * (i % 3) + 1] + a[3 * Math.floor(i / 3) + 2] * b[3 * (i % 3) + 2]);
function inv3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** A flight smoothed once, in a frame around the area (stretches cut at gaps of a minute). */
export function smoothFlight(f: Flight, centre: Listener): Flight {
  const out: Flight = { ...f, lat: f.lat.slice(), lon: f.lon.slice(), altFt: f.altFt.slice(), gs: f.gs.slice(), track: f.track.slice(), vrate: f.vrate.slice() };
  for (let a = 0; a < f.t.length; ) {
    let b = a + 1;
    while (b < f.t.length && f.t[b] - f.t[b - 1] <= 60) b++;
    const n = b - a;
    if (n >= 3) {
      const t = f.t.slice(a, b);
      const p = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
      const v = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
      for (let k = 0; k < n; k++) {
        const fix = fixAt(f, a + k);
        const q = toLocal(centre, fix.lat, fix.lon, fix.altitude);
        for (let i = 0; i < 3; i++) [p[i][k], v[i][k]] = [q[i], fix.velocity[i]];
      }
      for (let i = 0; i < 3; i++) smoothAxis(t, p[i], v[i], i);
      for (let k = 0; k < n; k++) {
        const ll = fromLocal(centre, p[0][k], p[1][k]);
        const j = a + k;
        out.lat[j] = ll.lat;
        out.lon[j] = ll.lon;
        out.altFt[j] = (p[2][k] + centre.elevation + (p[0][k] ** 2 + p[1][k] ** 2) / (2 * R)) / FT;
        out.gs[j] = Math.hypot(v[0][k], v[1][k]) / KT;
        out.track[j] = ((Math.atan2(v[0][k], v[1][k]) / RAD) + 360) % 360;
        out.vrate[j] = (v[2][k] / FT) * 60;
      }
    }
    a = b;
  }
  return out;
}

/**
 * Check one guess: each trace read at a spot and a start against the given flights (smoothed
 * first unless `smooth` is false), the one that explains it best (hex, loss as in the search,
 * clock in seconds). For the evals, and for a page that wants to show why a guess holds.
 */
export function readAt(segments: Segment[], flights: Flight[], at: { lat: number; lon: number; start: number }, options: { air?: Air; ground?: (lat: number, lon: number) => number; smooth?: boolean; coarse?: boolean } = {}): { hex: string; loss: number; clock: number }[] {
  const air = options.air ?? { groundTempC: 15 };
  const c = pathSpeed(air, 300);
  const listener: Listener = { lat: at.lat, lon: at.lon, elevation: (options.ground ?? (() => 0))(at.lat, at.lon) };
  const heard = options.smooth === false ? flights : flights.map((f) => smoothFlight(f, listener));
  return segments.flatMap((g) =>
    g.traces.map((trace) => {
      const { t, y } = framesOf(trace, g.stack.base.times, g.offset);
      const s = shapeOf(t, y, c);
      let best = { hex: "", loss: MISS, clock: 0 };
      for (const f of heard) {
        let read: Read | null;
        if (options.coarse === false) {
          const track = trackOf(f, at.start + t[0] - SWEEP - 40, at.start + t[t.length - 1] + SWEEP + 5, listener);
          read = track && readTrace(s, track, at.start, air, RANGE, 0.01);
        } else read = readFast(s, f, listener, at.start, air, RANGE, 0.01);
        if (read && read.loss < best.loss) best = { hex: f.hex, loss: read.loss, clock: read.clock };
      }
      return best;
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// A trace read against one aircraft's real track, from one spot, at one start (clock swept).

export type Read = { loss: number; clock: number; logF0: number };

/** Clock swept in the coarse and joint reads, seconds either way, by whole seconds. */
export const SWEEP = 4;

function readTrace(shape: Shape, track: Track, start: number, air: Air, maxRange: number, sigma: number, coarse = false, width = 0): Read {
  const { times, logs } = shape;
  const n = times.length;
  // The curve every second from SWEEP before the trace to SWEEP after it. When coarse, computed
  // every g seconds and interpolated: the curve bends over d / v (the width), so g is a fifth of
  // it, 1 to 4 s.
  const m = n + 2 * SWEEP;
  const logF = new Float64Array(m);
  const at = (i: number) => (i < SWEEP ? times[0] - (SWEEP - i) : i >= n + SWEEP ? times[n - 1] + (i - n - SWEEP + 1) : times[i - SWEEP]);
  const value = (i: number) => {
    const h = heardAt(track, start + at(i), air);
    return h && h.range < maxRange ? Math.log(h.factor) : NaN;
  };
  const g = coarse ? Math.max(1, Math.min(4, Math.floor(width / 5))) : 1;
  for (let i = 0; ; i += g) {
    const k = Math.min(i, m - 1);
    logF[k] = value(k);
    if (k > 0 && g > 1) {
      const from = Math.max(0, k - g);
      for (let j = from + 1; j < k; j++) logF[j] = logF[from] + ((logF[k] - logF[from]) * (j - from)) / (k - from);
    }
    if (k === m - 1) break;
  }
  // Trace frames are a second apart (every fourth base frame), so whole-second clocks line up.
  let best: Read = { loss: MISS, clock: 0, logF0: 0 };
  const r = new Float64Array(n);
  for (let c = -SWEEP; c <= SWEEP; c++) {
    let count = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = logF[i + SWEEP + c];
      if (Number.isFinite(v)) sum += r[count++] = logs[i] - v;
    }
    if (count < n / 2) continue;
    // The tone at rest: the median of the residuals, or their mean when coarse (no sort).
    const centre = coarse ? sum / count : r.subarray(0, count).sort()[count >> 1];
    let l = (n - count) * MISS;
    for (let i = 0; i < count; i++) l += rho((r[i] - centre) / sigma);
    l = l / n + 0.02 * (c / SWEEP) ** 2;
    if (l < best.loss) best = { loss: l, clock: c, logF0: centre };
  }
  return best;
}

/** A flight's fixes around one read, in the listener's frame (reused: no allocation per read). */
let buf = { t: new Float64Array(512), x: new Float64Array(512), y: new Float64Array(512), z: new Float64Array(512), vx: new Float64Array(512), vy: new Float64Array(512), vz: new Float64Array(512) };
/** How far past its first or last fix a track is extended in a straight line (as lib/core/track.ts). */
const EXTEND = 8;

/**
 * readTrace for the search's many reads: the same curve (the sound heard at each moment left the
 * aircraft earlier, its Doppler factor from the aircraft's speed toward the listener then), from
 * a flight already smoothed, with positions and velocities interpolated linearly between fixes,
 * one sound speed for the pass, no wind, and the tone at rest as the mean residual. About seven
 * times faster than building a track and calling heardAt for each moment.
 */
export function readFast(shape: Shape, f: Flight, listener: Listener, start: number, air: Air, maxRange: number, sigma: number, width = 0): Read {
  const { times, logs } = shape;
  const n = times.length;
  const miss: Read = { loss: MISS, clock: 0, logF0: 0 };
  const a = Math.max(0, firstAfter(f.t, start + times[0] - SWEEP - 40) - 1);
  const b = Math.min(f.t.length - 1, firstAfter(f.t, start + times[n - 1] + SWEEP + 5));
  if (b - a < 1) return miss;
  for (let j = a + 1; j <= b; j++) if (f.t[j] - f.t[j - 1] > 60) return miss;
  const m = b - a + 1;
  if (m > buf.t.length) buf = { t: new Float64Array(2 * m), x: new Float64Array(2 * m), y: new Float64Array(2 * m), z: new Float64Array(2 * m), vx: new Float64Array(2 * m), vy: new Float64Array(2 * m), vz: new Float64Array(2 * m) };
  const { t, x, y, z, vx, vy, vz } = buf;
  for (let k = 0; k < m; k++) {
    const j = a + k;
    const q = toLocal(listener, f.lat[j], f.lon[j], f.altFt[j] * FT);
    const th = f.track[j] * RAD;
    const gs = f.gs[j] * KT;
    [t[k], x[k], y[k], z[k], vx[k], vy[k], vz[k]] = [f.t[j], q[0], q[1], q[2], gs * Math.sin(th), gs * Math.cos(th), (f.vrate[j] * FT) / 60];
  }
  const c = pathSpeed(air, Math.max(0, z[m >> 1]));
  // The curve every second from SWEEP before the trace to SWEEP after it, computed every g s.
  const M = n + 2 * SWEEP;
  const logF = new Float64Array(M);
  const at = (i: number) => (i < SWEEP ? times[0] - (SWEEP - i) : i >= n + SWEEP ? times[n - 1] + (i - n - SWEEP + 1) : times[i - SWEEP]);
  let k = 0;
  const value = (i: number) => {
    const tR = start + at(i);
    let te = tR;
    let px = 0;
    let py = 0;
    let pz = 0;
    let wx = 0;
    let wy = 0;
    let wz = 0;
    for (let it = 0; it < 5; it++) {
      if (te < t[0] - EXTEND || te > t[m - 1] + EXTEND) return NaN;
      while (k < m - 2 && te >= t[k + 1]) k++;
      while (k > 0 && te < t[k]) k--;
      // Between fixes k and k + 1, or straight on past the ends.
      const u = te <= t[0] ? 0 : te >= t[m - 1] ? 1 : (te - t[k]) / (t[k + 1] - t[k]);
      const e = te <= t[0] ? te - t[0] : te >= t[m - 1] ? te - t[m - 1] : 0;
      const [i0, i1] = te <= t[0] ? [0, 0] : te >= t[m - 1] ? [m - 1, m - 1] : [k, k + 1];
      wx = vx[i0] + u * (vx[i1] - vx[i0]);
      wy = vy[i0] + u * (vy[i1] - vy[i0]);
      wz = vz[i0] + u * (vz[i1] - vz[i0]);
      px = x[i0] + u * (x[i1] - x[i0]) + e * wx;
      py = y[i0] + u * (y[i1] - y[i0]) + e * wy;
      pz = z[i0] + u * (z[i1] - z[i0]) + e * wz;
      te = tR - Math.sqrt(px * px + py * py + pz * pz) / c;
    }
    const r = Math.sqrt(px * px + py * py + pz * pz);
    if (r >= maxRange || r === 0) return NaN;
    const approach = -(wx * px + wy * py + wz * pz) / r;
    return Math.log(c / (c - approach));
  };
  const g = Math.max(1, Math.min(4, Math.floor(width / 5)));
  for (let i = 0; ; i += g) {
    const kk = Math.min(i, M - 1);
    logF[kk] = value(kk);
    if (kk > 0 && g > 1) {
      const from = Math.max(0, kk - g);
      for (let j = from + 1; j < kk; j++) logF[j] = logF[from] + ((logF[kk] - logF[from]) * (j - from)) / (kk - from);
    }
    if (kk === M - 1) break;
  }
  let best = miss;
  const res = new Float64Array(n);
  for (let cl = -SWEEP; cl <= SWEEP; cl++) {
    let count = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = logF[i + SWEEP + cl];
      if (v === v) sum += res[count++] = logs[i] - v;
    }
    if (count < n / 2) continue;
    const centre = sum / count;
    let l = (n - count) * MISS;
    for (let i = 0; i < count; i++) l += rho((res[i] - centre) / sigma);
    l = l / n + 0.02 * (cl / SWEEP) ** 2;
    if (l < best.loss) best = { loss: l, clock: cl, logF0: centre };
  }
  return best;
}
