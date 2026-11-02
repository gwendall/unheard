import { toLocal, type Listener, type Vec3 } from "./geo";

/** One reported position of an aircraft, as broadcast over ADS-B. */
export type Fix = {
  /** UTC seconds when the position was valid. */
  t: number;
  lat: number;
  lon: number;
  /** Metres above sea level. */
  altitude: number;
  /** Ground velocity east, north and up, m/s. */
  velocity: Vec3;
};

type Point = { t: number; p: Vec3; v: Vec3 };

export type Track = { points: Point[]; start: number; end: number };

export type State = { p: Vec3; v: Vec3 };

/** How far past its first or last fix a track may be extended in a straight line, in seconds. */
const EXTEND = 8;

/**
 * How much to trust each part of a fix, per axis (east, north, up): reported positions wander by
 * metres, reported velocities by a fraction of a knot, and aircraft change their acceleration
 * gently (the jerk density). Tuned on evals/synthetic and evals/real-tracks.
 */
export const TRUST = {
  position: [8, 8, 8],
  velocity: [0.4, 0.4, 0.5],
  jerk: 0.05,
};

export function buildTrack(fixes: Fix[], listener: Listener, options: { smooth?: boolean } = {}): Track | null {
  const sorted = [...fixes].sort((a, b) => a.t - b.t);
  const points: Point[] = [];
  for (const fix of sorted) {
    const point = { t: fix.t, p: toLocal(listener, fix.lat, fix.lon, fix.altitude), v: [...fix.velocity] as Vec3 };
    // Two polls can return the same position: keep the later report of a given moment.
    if (points.length && fix.t - points[points.length - 1].t < 0.05) points[points.length - 1] = point;
    else points.push(point);
  }
  if (!points.length) return null;
  if (options.smooth !== false && points.length > 2) for (let axis = 0; axis < 3; axis++) smoothAxis(points, axis);
  return { points, start: points[0].t, end: points[points.length - 1].t };
}

type M3 = number[][];
const mul = (a: M3, b: M3): M3 => a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
const tr = (a: M3): M3 => a[0].map((_, j) => a.map((row) => row[j]));
const add = (a: M3, b: M3): M3 => a.map((row, i) => row.map((v, j) => v + b[i][j]));
const sub = (a: M3, b: M3): M3 => a.map((row, i) => row.map((v, j) => v - b[i][j]));
const vec = (x: number[]): M3 => x.map((v) => [v]);
function inv3(m: M3): M3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}
function inv2(m: number[][]): number[][] {
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  return [
    [m[1][1] / det, -m[0][1] / det],
    [-m[1][0] / det, m[0][0] / det],
  ];
}

/**
 * Rauch-Tung-Striebel smoother on one axis, state (position, velocity, acceleration): a Kalman
 * filter forward, then backward. Positions alone are too noisy to differentiate (6 m of noise
 * over 2 s is 4 m/s of false speed) and velocities alone drift; together, both come out right.
 */
function smoothAxis(points: Point[], axis: number): void {
  const sp = TRUST.position[axis] ** 2;
  const sv = TRUST.velocity[axis] ** 2;
  const q = TRUST.jerk;
  const n = points.length;
  const xf: M3[] = [];
  const Pf: M3[] = [];
  const xp: M3[] = [];
  const Pp: M3[] = [];
  const Fs: M3[] = [];
  let x = vec([points[0].p[axis], points[0].v[axis], 0]);
  let P: M3 = [
    [sp, 0, 0],
    [0, sv, 0],
    [0, 0, 1],
  ];
  for (let k = 0; k < n; k++) {
    if (k > 0) {
      const dt = points[k].t - points[k - 1].t;
      const F = [
        [1, dt, (dt * dt) / 2],
        [0, 1, dt],
        [0, 0, 1],
      ];
      const Q = [
        [(q * dt ** 5) / 20, (q * dt ** 4) / 8, (q * dt ** 3) / 6],
        [(q * dt ** 4) / 8, (q * dt ** 3) / 3, (q * dt ** 2) / 2],
        [(q * dt ** 3) / 6, (q * dt ** 2) / 2, q * dt],
      ];
      x = mul(F, x);
      P = add(mul(mul(F, P), tr(F)), Q);
      Fs[k] = F;
    }
    xp[k] = x;
    Pp[k] = P;
    // Measure position and velocity: H = [[1,0,0],[0,1,0]].
    const S = [
      [P[0][0] + sp, P[0][1]],
      [P[1][0], P[1][1] + sv],
    ];
    const Si = inv2(S);
    const K = P.map((row) => [row[0] * Si[0][0] + row[1] * Si[1][0], row[0] * Si[0][1] + row[1] * Si[1][1]]);
    const y = [points[k].p[axis] - x[0][0], points[k].v[axis] - x[1][0]];
    x = x.map((row, i) => [row[0] + K[i][0] * y[0] + K[i][1] * y[1]]);
    const KH = K.map((row) => [row[0], row[1], 0]);
    P = mul(sub([[1, 0, 0], [0, 1, 0], [0, 0, 1]], KH), P);
    xf[k] = x;
    Pf[k] = P;
  }
  let xs = xf[n - 1];
  points[n - 1].p[axis] = xs[0][0];
  points[n - 1].v[axis] = xs[1][0];
  for (let k = n - 2; k >= 0; k--) {
    const C = mul(mul(Pf[k], tr(Fs[k + 1])), inv3(Pp[k + 1]));
    xs = add(xf[k], mul(C, sub(xs, xp[k + 1])));
    points[k].p[axis] = xs[0][0];
    points[k].v[axis] = xs[1][0];
  }
}

/**
 * Position and velocity at time t. Between two fixes, a cubic Hermite curve that passes through
 * both positions with both reported velocities, so speed and heading change smoothly, as they do.
 * A short straight extension covers the edges; beyond that the track is unknown.
 */
export function stateAt(track: Track, t: number): State | null {
  const { points } = track;
  if (t < track.start - EXTEND || t > track.end + EXTEND) return null;
  if (t <= track.start || points.length === 1) return extend(points[0], t);
  if (t >= track.end) return extend(points[points.length - 1], t);
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const dt = b.t - a.t;
  const s = (t - a.t) / dt;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const d00 = 6 * s2 - 6 * s;
  const d10 = 3 * s2 - 4 * s + 1;
  const d01 = -6 * s2 + 6 * s;
  const d11 = 3 * s2 - 2 * s;
  const p: Vec3 = [0, 0, 0];
  const v: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    p[i] = h00 * a.p[i] + h10 * dt * a.v[i] + h01 * b.p[i] + h11 * dt * b.v[i];
    v[i] = (d00 * a.p[i] + d10 * dt * a.v[i] + d01 * b.p[i] + d11 * dt * b.v[i]) / dt;
  }
  return { p, v };
}

function extend(point: Point, t: number): State {
  const dt = t - point.t;
  return { p: [point.p[0] + point.v[0] * dt, point.p[1] + point.v[1] * dt, point.p[2] + point.v[2] * dt], v: point.v };
}
