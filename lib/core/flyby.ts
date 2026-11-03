// A flyby read on its own: each tone of a recording fitted to the curve of a straight, steady pass
// (no flight history needed). A straight pass heard from a slant distance d at speed v makes one
// curve whose form depends only on v / c once time is counted in units of d / v, so a trace gives
// the speeds and distances it accepts, the moment of closest approach for each, and the tone at
// rest: the leads a person can check, and where lib/core/wherewhen.ts starts. Taken from
// dopplerprint's README (MIT): fit a constant-velocity Doppler curve per tone first (rest
// frequency, speed, closest distance and time).

import { pathSpeed, type Air } from "./doppler";
import { buildStack, type Stack } from "./spectrogram";
import { findTraces, type Trace } from "./trace";

/** A stretch of the recording: its stack, where it starts in the file (s), the traces found in it. */
export type Segment = { stack: Stack; offset: number; traces: Trace[] };

/** Traces as locate() reads them: propeller and rotor tones up to jet fans (3.4 kHz). */
const TRACES = { fMin: 40, fMax: 3400 };

/**
 * The traces of a recording, whole when it is short; a long one (colsto's hour) chunk by chunk,
 * 180 s every 120 s up to 1 kHz (propellers and rotors), a tone found twice in an overlap kept
 * once. Only the chunks that hold a trace are kept. `searched` is what silence may count on.
 */
export function findSegments(samples: Float32Array, sampleRate: number, chunk = 180, step = 120): { segments: Segment[]; searched: [number, number][] } {
  const total = samples.length / sampleRate;
  if (total <= chunk + 60) {
    const stack = buildStack(samples, sampleRate);
    return { segments: [{ stack, offset: 0, traces: findTraces(stack, TRACES).traces }], searched: [[0, total]] };
  }
  const segments: Segment[] = [];
  const middle = (g: { stack: Stack; offset: number }, t: Trace) => g.offset + g.stack.base.times[(t.from + t.to) >> 1];
  const pitch = (t: Trace) => t.freq[(t.from + t.to) >> 1];
  for (let offset = 0; offset + 30 < total; offset += step) {
    const stack = buildStack(samples.subarray(Math.round(offset * sampleRate), Math.min(samples.length, Math.round((offset + chunk) * sampleRate))), sampleRate, { maxHz: 1000 });
    const here = { stack, offset };
    const traces = findTraces(stack, { ...TRACES, fMax: 400 }).traces.filter((t) => !segments.some((g) => g.traces.some((u) => Math.abs(middle(g, u) - middle(here, t)) < 20 && Math.abs(Math.log(pitch(u) / pitch(t))) < 0.02)));
    if (traces.length) segments.push({ stack, offset, traces });
  }
  return { segments, searched: [[0, total]] };
}

/** What a trace says on its own, read as a straight steady flyby: the leads a person can check. */
export type Flyby = {
  /** File seconds the trace spans, and when its closest point was heard (best fit). */
  from: number;
  to: number;
  closest: number;
  /** Tone at the closest point, Hz (a harmonic of the blade-pass, maybe). */
  f0: number;
  /** Speeds (m/s) and closest distances (m) the trace accepts. */
  speeds: [number, number];
  distances: [number, number];
  /** Candidates (aircraft, spot, start) it raised in the history (0 before the search). */
  candidates: number;
};

const rho = (x: number) => Math.log1p(0.5 * x * x);

/** Speeds tried, m/s: a glider's tow to a jet on approach. */
export const SPEEDS = Array.from({ length: 36 }, (_, i) => 20 + 4 * i);
/** d / v, seconds: how long the pass takes, 1 s (low and fast) to 3 min (far and slow). */
export const WIDTHS = Array.from({ length: 44 }, (_, i) => 1.5 * 1.115 ** i);
const ETA = 60;
const ETA_STEP = 0.02;

/**
 * log(heard / emitted) of a straight steady pass at speed beta = v / c, at receive time eta (in
 * units of d / v from the moment the closest point's sound arrives), tabulated once per speed.
 */
const curves = new Map<number, Float64Array>();
function curveOf(beta: number): Float64Array {
  const key = Math.round(beta * 1e4);
  let table = curves.get(key);
  if (table) return table;
  const n = Math.round((2 * ETA) / ETA_STEP) + 1;
  table = new Float64Array(n);
  let xi = -ETA;
  for (let i = 0; i < n; i++) {
    const eta = -ETA + i * ETA_STEP;
    // Emission time xi (same units) solves eta = xi + beta (sqrt(1 + xi^2) - 1).
    for (let it = 0; it < 30; it++) {
      const s = Math.sqrt(1 + xi * xi);
      const step = (xi + beta * (s - 1) - eta) / (1 + (beta * xi) / s);
      xi -= step;
      if (Math.abs(step) < 1e-9) break;
    }
    table[i] = -Math.log1p((beta * xi) / Math.sqrt(1 + xi * xi));
  }
  curves.set(key, table);
  return table;
}
const lookup = (table: Float64Array, eta: number) => {
  const x = (eta + ETA) / ETA_STEP;
  if (x <= 0) return table[0];
  if (x >= table.length - 1) return table[table.length - 1];
  const i = Math.floor(x);
  return table[i] + (x - i) * (table[i + 1] - table[i]);
};

export type Shape = {
  /** File seconds and log frequency of the trace frames used (every second). */
  times: Float64Array;
  logs: Float64Array;
  /** Per speed and width: best moment of closest approach (file seconds, as heard) and loss. */
  at: Float32Array;
  loss: Float32Array;
  best: number;
  /** The best fit's cell (speed * widths + width) and log f0. */
  cell: number;
  logF0: number;
  /** Loss accepted: the best plus what the frames' own scatter allows. */
  accept: number;
};

/** Spread of a trace around a straight flyby: the grid's 0.25 % and the real track's wobble. */
const SHAPE_SIGMA = 0.006;

/** A trace as file seconds and log frequencies, every fourth base frame (a second apart). */
export function framesOf(trace: Trace, times: Float64Array, offset: number): { t: Float64Array; y: Float64Array } {
  const ks: number[] = [];
  for (let k = trace.from; k <= trace.to; k += 4) if (Number.isFinite(trace.freq[k])) ks.push(k);
  return { t: Float64Array.from(ks, (k) => times[k] + offset), y: Float64Array.from(ks, (k) => Math.log(trace.freq[k])) };
}

export function shapeOf(t: Float64Array, y: Float64Array, c: number): Shape {
  const n = t.length;
  const V = SPEEDS.length;
  const W = WIDTHS.length;
  const at = new Float32Array(V * W).fill(NaN);
  const loss = new Float32Array(V * W).fill(Infinity);
  const r = new Float64Array(n);
  let best = Infinity;
  let logF0 = NaN;
  let cell = 0;
  for (let vi = 0; vi < V; vi++) {
    const table = curveOf(SPEEDS[vi] / c);
    for (let wi = 0; wi < W; wi++) {
      const w = WIDTHS[wi];
      const step = Math.max(0.25, w / 8);
      for (let sc = t[0] - 2 * w; sc <= t[n - 1] + 2 * w; sc += step) {
        let mean = 0;
        for (let i = 0; i < n; i++) mean += r[i] = y[i] - lookup(table, (t[i] - sc) / w);
        mean /= n;
        let l = 0;
        for (let i = 0; i < n; i++) l += rho((r[i] - mean) / SHAPE_SIGMA);
        l /= n;
        if (l < loss[vi * W + wi]) {
          loss[vi * W + wi] = l;
          at[vi * W + wi] = sc;
          if (l < best) [best, logF0, cell] = [l, mean, vi * W + wi];
        }
      }
    }
  }
  // Frames a second apart are not independent either: about one in two.
  return { times: t, logs: y, at, loss, best, cell, logF0, accept: best + Math.max(0.15, 6 / n) };
}

/** The best fit's speed (m/s) and closest distance (m). */
export function bestOf(sh: Shape): { speed: number; distance: number } {
  const W = WIDTHS.length;
  const speed = SPEEDS[Math.floor(sh.cell / W)];
  return { speed, distance: speed * WIDTHS[sh.cell % W] };
}

export function flybyOf(sh: Shape): Flyby {
  const W = WIDTHS.length;
  const ok: number[] = [];
  sh.loss.forEach((l, i) => l <= sh.accept && ok.push(i));
  const speeds = ok.map((i) => SPEEDS[Math.floor(i / W)]);
  const distances = ok.map((i) => SPEEDS[Math.floor(i / W)] * WIDTHS[i % W]);
  return {
    from: sh.times[0],
    to: sh.times[sh.times.length - 1],
    closest: sh.at[sh.cell],
    f0: Math.exp(sh.logF0),
    speeds: [Math.min(...speeds), Math.max(...speeds)],
    distances: [Math.round(Math.min(...distances)), Math.round(Math.max(...distances))],
    candidates: 0,
  };
}

/** Each trace read on its own as a straight steady flyby (no history needed). */
export function flybys(segments: Segment[], air: Air = { groundTempC: 15 }): Flyby[] {
  const c = pathSpeed(air, 300);
  return segments.flatMap((g) => g.traces.map((trace) => {
    const { t, y } = framesOf(trace, g.stack.base.times, g.offset);
    return flybyOf(shapeOf(t, y, c));
  }));
}
