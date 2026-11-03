// Scenario generation for the evals: a recording and the polls the page would have made, both
// derived from "truth" tracks, with everything production gets wrong on purpose (clock error,
// sparse, late and noisy ADS-B, forecast air instead of real air, wind the model ignores,
// passing cars, doors, hum), and what the right answer is.

import type { Poll, PolledAircraft } from "../../lib/adsb";
import type { Air } from "../../lib/core/doppler";
import { fromLocal, type Listener, type Vec3 } from "../../lib/core/geo";
import { ANALYSIS_RATE, type Recording } from "../../lib/core/pipeline";
import { synthesize, type Source } from "../../lib/core/synth";
import { stateAt, type Track } from "../../lib/core/track";

export type Rng = { next: () => number; uniform: (a: number, b: number) => number; gauss: (sd?: number) => number; pick: <T>(xs: readonly T[]) => T; int: (a: number, b: number) => number };

export function rng(seed: number): Rng {
  let a = seed >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    uniform: (lo, hi) => lo + (hi - lo) * next(),
    gauss: (sd = 1) => sd * Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next()),
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
  };
}

export type Truth = {
  /** Hex of the aircraft heard, null when none is in the recording or in the data. */
  heard: string | null;
  /** Other acceptable answers (two aircraft heard at once). */
  alsoHeard?: string[];
  f0?: number;
  clock?: number;
};

/** The exact sound that was heard, to measure how findable it was with a perfect model. */
export type Oracle = { truth: Track; air: Air; f0: number; harmonics: number[]; start: number };

export type Scenario = {
  id: string;
  kind: "heard" | "noise" | "missing" | "two";
  recording: Recording;
  truth: Truth;
  oracle?: Oracle;
  tags: Record<string, string | number>;
  /** The sound at the file's own rate, when it had one before the analysis rate (real clips). */
  native?: { samples: Float32Array; sampleRate: number };
};

const R = 6_371_008.8;
const FT = 0.3048;
const KT = 1852 / 3600;

/** Degrades a truth state into what an aggregator reports: lagged, quantised, noisy. */
function report(r: Rng, listener: Listener, hex: string, truth: Track, t: number, meta: Partial<PolledAircraft>): PolledAircraft | null {
  const lag = r.uniform(0, 1.5);
  const s = stateAt(truth, t - lag);
  if (!s) return null;
  const e = s.p[0] + r.gauss(6);
  const n = s.p[1] + r.gauss(6);
  const { lat, lon } = fromLocal(listener, e, n);
  const altitude = s.p[2] + listener.elevation + (e * e + n * n) / (2 * R);
  const gs = Math.hypot(s.v[0], s.v[1]);
  const track = ((Math.atan2(s.v[0], s.v[1]) * 180) / Math.PI + 360) % 360;
  return {
    hex,
    lat,
    lon,
    alt_geom: Math.round(altitude / FT / 25) * 25,
    alt_baro: Math.round((altitude / FT + r.gauss(80)) / 25) * 25,
    gs: Math.round((gs / KT + r.gauss(0.7)) * 10) / 10,
    track: Math.round((track + r.gauss(0.4)) * 100) / 100,
    geom_rate: Math.round(((s.v[2] / FT) * 60) / 64) * 64,
    seen_pos: Math.round(lag * 10) / 10,
    ...meta,
  };
}

/**
 * The polls the page makes: every ~2 s from 6 s before the start to the end, some lost, each
 * aircraft reported with its own lag and noise.
 */
export function pollsFrom(r: Rng, listener: Listener, aircraft: { hex: string; truth: Track; meta: Partial<PolledAircraft> }[], from: number, to: number, every = 2, drop = 0.05): Poll[] {
  const polls: Poll[] = [];
  for (let t = from; t <= to; t += every + r.uniform(-0.3, 0.3)) {
    if (r.next() < drop) continue;
    const list: PolledAircraft[] = [];
    for (const a of aircraft) {
      if (t < a.truth.start || t > a.truth.end) continue;
      const rep = report(r, listener, a.hex, a.truth, t, a.meta);
      if (rep) list.push(rep);
    }
    polls.push({ now: Math.round(t * 1000), aircraft: list });
  }
  return polls;
}

export type Sound = { truth: Track; f0: number; harmonics: number[]; level: number };

/** A recording of the given sounds in a randomised but plausible acoustic scene. */
export function scene(r: Rng, start: number, duration: number, sounds: Sound[], air: Air) {
  const hum = Array.from({ length: r.int(0, 3) }, () => ({ freq: r.pick([50, 60, 100, 120, 150, 180]), level: r.uniform(0.05, 0.6) }));
  const chirps = Array.from({ length: r.int(0, 3) }, () => {
    const from = r.uniform(60, 400);
    return { at: r.uniform(0, duration - 8), duration: r.uniform(3, 8), from, to: from * r.uniform(0.6, 0.95), level: r.uniform(0.1, 0.6) };
  });
  const bursts = Array.from({ length: r.int(0, 5) }, () => ({ at: r.uniform(0, duration - 2), duration: r.uniform(0.1, 1.5), level: r.uniform(1, 6) }));
  const sources: Source[] = sounds.map((s) => ({ track: s.truth, f0: s.f0, harmonics: s.harmonics, level: s.level }));
  return synthesize({ start, duration, sampleRate: ANALYSIS_RATE, air, sources, noise: 1, rumble: r.uniform(0.3, 2), hum, chirps, bursts, seed: r.int(1, 1e9) });
}

export const HARMONIC_PROFILES = [
  [1, 0.5, 0.3],
  [0.4, 1, 0.5],
  [1, 0.8, 0.6, 0.4],
  [1, 0.2],
] as const;

/** The air the page assumes (forecast temperature, no wind) next to the real one. */
export function airs(r: Rng): { real: Air; model: Air } {
  const temp = r.uniform(-5, 35);
  const speed = r.uniform(0, 10);
  const dir = r.uniform(0, 2 * Math.PI);
  const wind: Vec3 = [speed * Math.sin(dir), speed * Math.cos(dir), 0];
  return { real: { groundTempC: temp, wind }, model: { groundTempC: temp + r.gauss(2) } };
}
