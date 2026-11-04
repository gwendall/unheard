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

/** The smoother's memory for one stretch, kept from one to the next (a day holds thousands). */
let smoother = { XF: new Float64Array(0), PF: new Float64Array(0), XP: new Float64Array(0), PP: new Float64Array(0) };

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
  if (smoother.XF.length < 3 * n) smoother = { XF: new Float64Array(6 * n), PF: new Float64Array(18 * n), XP: new Float64Array(6 * n), PP: new Float64Array(18 * n) };
  const { XF, PF, XP, PP } = smoother;
  let x0 = z[0];
  let x1 = w[0];
  let x2 = 0;
  let p0 = sp;
  let p1 = 0;
  let p2 = 0;
  let p3 = 0;
  let p4 = sv;
  let p5 = 0;
  let p6 = 0;
  let p7 = 0;
  let p8 = 1;
  for (let k = 0; k < n; k++) {
    if (k > 0) {
      const dt = t[k] - t[k - 1];
      const f2 = (dt * dt) / 2;
      const d2 = dt * dt;
      const d3 = d2 * dt;
      // F P, then (F P) F', then Q added: F = [1, dt, f2; 0, 1, dt; 0, 0, 1].
      const a0 = p0 + dt * p3 + f2 * p6;
      const a1 = p1 + dt * p4 + f2 * p7;
      const a2 = p2 + dt * p5 + f2 * p8;
      const a3 = p3 + dt * p6;
      const a4 = p4 + dt * p7;
      const a5 = p5 + dt * p8;
      p0 = a0 + a1 * dt + a2 * f2 + (q * d3 * d2) / 20;
      p1 = a1 + a2 * dt + (q * d2 * d2) / 8;
      p2 = a2 + (q * d3) / 6;
      p3 = a3 + a4 * dt + a5 * f2 + (q * d2 * d2) / 8;
      p4 = a4 + a5 * dt + (q * d3) / 3;
      p5 = a5 + (q * d2) / 2;
      const a6 = p6;
      const a7 = p7;
      const a8 = p8;
      p6 = a6 + a7 * dt + a8 * f2 + (q * d3) / 6;
      p7 = a7 + a8 * dt + (q * d2) / 2;
      p8 = a8 + q * dt;
      const nx0 = x0 + dt * x1 + (d2 / 2) * x2;
      x1 = x1 + dt * x2;
      x0 = nx0;
    }
    const k3 = 3 * k;
    const k9 = 9 * k;
    XP[k3] = x0;
    XP[k3 + 1] = x1;
    XP[k3 + 2] = x2;
    PP[k9] = p0;
    PP[k9 + 1] = p1;
    PP[k9 + 2] = p2;
    PP[k9 + 3] = p3;
    PP[k9 + 4] = p4;
    PP[k9 + 5] = p5;
    PP[k9 + 6] = p6;
    PP[k9 + 7] = p7;
    PP[k9 + 8] = p8;
    // Measure position and velocity.
    const a = p0 + sp;
    const b = p1;
    const c = p3;
    const d = p4 + sv;
    const det = a * d - b * c;
    const i00 = d / det;
    const i01 = -b / det;
    const i10 = -c / det;
    const i11 = a / det;
    const k00 = p0 * i00 + p1 * i10;
    const k01 = p0 * i01 + p1 * i11;
    const k10 = p3 * i00 + p4 * i10;
    const k11 = p3 * i01 + p4 * i11;
    const k20 = p6 * i00 + p7 * i10;
    const k21 = p6 * i01 + p7 * i11;
    const y0 = z[k] - x0;
    const y1 = w[k] - x1;
    x0 = x0 + k00 * y0 + k01 * y1;
    x1 = x1 + k10 * y0 + k11 * y1;
    x2 = x2 + k20 * y0 + k21 * y1;
    const q0 = p0;
    const q1 = p1;
    const q2 = p2;
    const q3 = p3;
    const q4 = p4;
    const q5 = p5;
    p0 = q0 - k00 * q0 - k01 * q3;
    p1 = q1 - k00 * q1 - k01 * q4;
    p2 = q2 - k00 * q2 - k01 * q5;
    p3 = q3 - k10 * q0 - k11 * q3;
    p4 = q4 - k10 * q1 - k11 * q4;
    p5 = q5 - k10 * q2 - k11 * q5;
    const q6 = p6;
    const q7 = p7;
    const q8 = p8;
    p6 = q6 - k20 * q0 - k21 * q3;
    p7 = q7 - k20 * q1 - k21 * q4;
    p8 = q8 - k20 * q2 - k21 * q5;
    XF[k3] = x0;
    XF[k3 + 1] = x1;
    XF[k3 + 2] = x2;
    PF[k9] = p0;
    PF[k9 + 1] = p1;
    PF[k9 + 2] = p2;
    PF[k9 + 3] = p3;
    PF[k9 + 4] = p4;
    PF[k9 + 5] = p5;
    PF[k9 + 6] = p6;
    PF[k9 + 7] = p7;
    PF[k9 + 8] = p8;
  }
  let s0 = XF[3 * (n - 1)];
  let s1 = XF[3 * (n - 1) + 1];
  let s2 = XF[3 * (n - 1) + 2];
  z[n - 1] = s0;
  w[n - 1] = s1;
  for (let k = n - 2; k >= 0; k--) {
    const dt = t[k + 1] - t[k];
    const f2 = (dt * dt) / 2;
    const k9 = 9 * k;
    const m9 = 9 * (k + 1);
    // PF[k] F'.
    const g0 = PF[k9];
    const g1 = PF[k9 + 1];
    const g2 = PF[k9 + 2];
    const g3 = PF[k9 + 3];
    const g4 = PF[k9 + 4];
    const g5 = PF[k9 + 5];
    const g6 = PF[k9 + 6];
    const g7 = PF[k9 + 7];
    const g8 = PF[k9 + 8];
    const h0 = g0 + g1 * dt + g2 * f2;
    const h1 = g1 + g2 * dt;
    const h2 = g2;
    const h3 = g3 + g4 * dt + g5 * f2;
    const h4 = g4 + g5 * dt;
    const h5 = g5;
    const h6 = g6 + g7 * dt + g8 * f2;
    const h7 = g7 + g8 * dt;
    const h8 = g8;
    // The inverse of PP[k + 1].
    const pa = PP[m9];
    const pb = PP[m9 + 1];
    const pc = PP[m9 + 2];
    const pd = PP[m9 + 3];
    const pe = PP[m9 + 4];
    const pf = PP[m9 + 5];
    const pg = PP[m9 + 6];
    const ph = PP[m9 + 7];
    const pi = PP[m9 + 8];
    const A = pe * pi - pf * ph;
    const B = pd * pi - pf * pg;
    const Cc = pd * ph - pe * pg;
    const det = pa * A + pb * -B + pc * Cc;
    const v0 = A / det;
    const v1 = (pc * ph - pb * pi) / det;
    const v2 = (pb * pf - pc * pe) / det;
    const v3 = -B / det;
    const v4 = (pa * pi - pc * pg) / det;
    const v5 = (pc * pd - pa * pf) / det;
    const v6 = Cc / det;
    const v7 = (pb * pg - pa * ph) / det;
    const v8 = (pa * pe - pb * pd) / det;
    // C = h v, then xs = XF[k] + C (xs - XP[k + 1]).
    const c0 = h0 * v0 + h1 * v3 + h2 * v6;
    const c1 = h0 * v1 + h1 * v4 + h2 * v7;
    const c2 = h0 * v2 + h1 * v5 + h2 * v8;
    const c3 = h3 * v0 + h4 * v3 + h5 * v6;
    const c4 = h3 * v1 + h4 * v4 + h5 * v7;
    const c5 = h3 * v2 + h4 * v5 + h5 * v8;
    const c6 = h6 * v0 + h7 * v3 + h8 * v6;
    const c7 = h6 * v1 + h7 * v4 + h8 * v7;
    const c8 = h6 * v2 + h7 * v5 + h8 * v8;
    const m3 = 3 * (k + 1);
    const e0 = s0 - XP[m3];
    const e1 = s1 - XP[m3 + 1];
    const e2 = s2 - XP[m3 + 2];
    const k3 = 3 * k;
    s0 = XF[k3] + c0 * e0 + c1 * e1 + c2 * e2;
    s1 = XF[k3 + 1] + c3 * e0 + c4 * e1 + c5 * e2;
    s2 = XF[k3 + 2] + c6 * e0 + c7 * e1 + c8 * e2;
    z[k] = s0;
    w[k] = s1;
  }
}

/** The arrays of one stretch, kept from one to the next. */
const stretchOf = (n: number) => ({ t: new Float64Array(n), px: new Float64Array(n), py: new Float64Array(n), pz: new Float64Array(n), vx: new Float64Array(n), vy: new Float64Array(n), vz: new Float64Array(n) });
let stretch = stretchOf(1024);

/**
 * A flight smoothed once, in a frame around the area (stretches cut at gaps of a minute). `from`
 * and `to`, UTC seconds: only the stretches that reach them.
 */
export function smoothFlight(f: Flight, centre: Listener, from = -Infinity, to = Infinity): Flight {
  const out: Flight = { ...f, lat: f.lat.slice(), lon: f.lon.slice(), altFt: f.altFt.slice(), gs: f.gs.slice(), track: f.track.slice(), vrate: f.vrate.slice() };
  for (let a = 0; a < f.t.length; ) {
    let b = a + 1;
    while (b < f.t.length && f.t[b] - f.t[b - 1] <= 60) b++;
    const n = b - a;
    // A stretch outside [from, to] is left raw: a stretch smooths on its own, and nobody reads it
    // (a read takes the fix just before `from` and the one just after `to` too).
    const reached = (f.t[b - 1] >= from || (b < f.t.length && f.t[b] >= from)) && (f.t[a] <= to || (a > 0 && f.t[a - 1] <= to));
    if (n >= 3 && reached) {
      if (stretch.t.length < n) stretch = stretchOf(2 * n);
      const t = f.t.subarray(a, b);
      const { px, py, pz, vx, vy, vz } = stretch;
      for (let k = 0; k < n; k++) {
        const j = a + k;
        const q = toLocal(centre, f.lat[j], f.lon[j], f.altFt[j] * FT);
        const rad = f.track[j] * RAD;
        const gs = f.gs[j] * KT;
        px[k] = q[0];
        py[k] = q[1];
        pz[k] = q[2];
        vx[k] = gs * Math.sin(rad);
        vy[k] = gs * Math.cos(rad);
        vz[k] = (f.vrate[j] * FT) / 60;
      }
      smoothAxis(t, px, vx, 0);
      smoothAxis(t, py, vy, 1);
      smoothAxis(t, pz, vz, 2);
      for (let k = 0; k < n; k++) {
        const ll = fromLocal(centre, px[k], py[k]);
        const j = a + k;
        out.lat[j] = ll.lat;
        out.lon[j] = ll.lon;
        out.altFt[j] = (pz[k] + centre.elevation + (px[k] ** 2 + py[k] ** 2) / (2 * R)) / FT;
        out.gs[j] = Math.hypot(vx[k], vy[k]) / KT;
        out.track[j] = ((Math.atan2(vx[k], vy[k]) / RAD) + 360) % 360;
        out.vrate[j] = (vz[k] / FT) * 60;
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
let buf = { t: new Float64Array(512), x: new Float64Array(512), y: new Float64Array(512), z: new Float64Array(512), vx: new Float64Array(512), vy: new Float64Array(512), vz: new Float64Array(512), logF: new Float64Array(512), res: new Float64Array(512) };
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
  if (m > buf.t.length) buf = { t: new Float64Array(2 * m), x: new Float64Array(2 * m), y: new Float64Array(2 * m), z: new Float64Array(2 * m), vx: new Float64Array(2 * m), vy: new Float64Array(2 * m), vz: new Float64Array(2 * m), logF: buf.logF, res: buf.res };
  const { t, x, y, z, vx, vy, vz } = buf;
  for (let k = 0; k < m; k++) {
    const j = a + k;
    const q = toLocal(listener, f.lat[j], f.lon[j], f.altFt[j] * FT);
    const th = f.track[j] * RAD;
    const gs = f.gs[j] * KT;
    t[k] = f.t[j];
    x[k] = q[0];
    y[k] = q[1];
    z[k] = q[2];
    vx[k] = gs * Math.sin(th);
    vy[k] = gs * Math.cos(th);
    vz[k] = (f.vrate[j] * FT) / 60;
  }
  const c = pathSpeed(air, Math.max(0, z[m >> 1]));
  // The curve every second from SWEEP before the trace to SWEEP after it, computed every g s.
  const M = n + 2 * SWEEP;
  if (buf.logF.length < M) buf.logF = new Float64Array(2 * M);
  if (buf.res.length < n) buf.res = new Float64Array(2 * n);
  const { logF, res } = buf;
  const first = t[0];
  const final = t[m - 1];
  let k = 0;
  const g = Math.max(1, Math.min(4, Math.floor(width / 5)));
  for (let i = 0; ; i += g) {
    const kk = Math.min(i, M - 1);
    // The sound heard at kk left the aircraft earlier: a few steps find when.
    const tR = start + (kk < SWEEP ? times[0] - (SWEEP - kk) : kk >= n + SWEEP ? times[n - 1] + (kk - n - SWEEP + 1) : times[kk - SWEEP]);
    let te = tR;
    let px = 0;
    let py = 0;
    let pz = 0;
    let wx = 0;
    let wy = 0;
    let wz = 0;
    let known = true;
    for (let it = 0; it < 5; it++) {
      if (te < first - EXTEND || te > final + EXTEND) {
        known = false;
        break;
      }
      while (k < m - 2 && te >= t[k + 1]) k++;
      while (k > 0 && te < t[k]) k--;
      // Between fixes k and k + 1, or straight on past the ends.
      const before = te <= first;
      const after = te >= final;
      const u = before ? 0 : after ? 1 : (te - t[k]) / (t[k + 1] - t[k]);
      const e = before ? te - first : after ? te - final : 0;
      const i0 = before ? 0 : after ? m - 1 : k;
      const i1 = before ? 0 : after ? m - 1 : k + 1;
      wx = vx[i0] + u * (vx[i1] - vx[i0]);
      wy = vy[i0] + u * (vy[i1] - vy[i0]);
      wz = vz[i0] + u * (vz[i1] - vz[i0]);
      px = x[i0] + u * (x[i1] - x[i0]) + e * wx;
      py = y[i0] + u * (y[i1] - y[i0]) + e * wy;
      pz = z[i0] + u * (z[i1] - z[i0]) + e * wz;
      te = tR - Math.sqrt(px * px + py * py + pz * pz) / c;
    }
    let value = NaN;
    if (known) {
      const r = Math.sqrt(px * px + py * py + pz * pz);
      if (!(r >= maxRange || r === 0)) {
        const approach = -(wx * px + wy * py + wz * pz) / r;
        value = Math.log(c / (c - approach));
      }
    }
    logF[kk] = value;
    if (kk > 0 && g > 1) {
      const from = Math.max(0, kk - g);
      for (let j = from + 1; j < kk; j++) logF[j] = logF[from] + ((logF[kk] - logF[from]) * (j - from)) / (kk - from);
    }
    if (kk === M - 1) break;
  }
  let best = miss;
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
    for (let i = 0; i < count; i++) {
      const dev = (res[i] - centre) / sigma;
      l += Math.log1p(0.5 * dev * dev);
    }
    l = l / n + 0.02 * (cl / SWEEP) ** 2;
    if (l < best.loss) best = { loss: l, clock: cl, logF0: centre };
  }
  return best;
}
