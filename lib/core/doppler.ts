import { dot, norm, type Vec3 } from "./geo";
import { stateAt, type Track } from "./track";

export type Air = {
  /** Air temperature at the listener, °C. */
  groundTempC: number;
  /** Where the air moves to, east/north/up m/s. Sound rides it: the wavefront drifts with the wind. */
  wind?: Vec3;
};

export const STANDARD_AIR: Air = { groundTempC: 15 };

/** Speed of sound in dry air, m/s. */
export const speedOfSound = (tempC: number) => 331.3 * Math.sqrt(1 + tempC / 273.15);

/**
 * Speed of sound along the path from a source `height` metres above the listener: the air cools
 * by about 6.5 °C per km, and sound crossing a linear gradient goes at the speed of its mean.
 */
export const pathSpeed = (air: Air, height: number) => speedOfSound(air.groundTempC - (0.0065 * Math.max(0, height)) / 2);

export type Heard = {
  /** UTC seconds when the sound heard at tRecv left the aircraft. */
  emitted: number;
  /** Distance from the aircraft to the listener at that moment, metres. */
  range: number;
  /** Heard frequency divided by emitted frequency. */
  factor: number;
};

/**
 * What the listener hears at UTC time tRecv: the sound that left the aircraft earlier, at the
 * moment `emitted` that solves tRecv = emitted + range(emitted) / c. The Doppler shift comes from
 * the aircraft's speed toward the listener at that earlier moment, not at tRecv: using tRecv
 * gives a different curve altogether, not the same one late (see lib/core/doppler.test.ts).
 */
export function heardAt(track: Track, tRecv: number, air: Air): Heard | null {
  const w = air.wind ?? [0, 0, 0];
  // The path from where the sound left (p) to the listener (origin), drifting with the air for
  // the `travel` seconds it takes.
  const path = (p: Vec3, travel: number): Vec3 => [-p[0] - w[0] * travel, -p[1] - w[1] * travel, -p[2] - w[2] * travel];
  // Fixed point: each step shrinks the error by about speed / c (< 0.3 for anything that flies here).
  let emitted = Math.min(tRecv, track.end);
  for (let i = 0; i < 16; i++) {
    const s = stateAt(track, emitted);
    if (!s) return null;
    const next = tRecv - norm(path(s.p, tRecv - emitted)) / pathSpeed(air, s.p[2]);
    const done = Math.abs(next - emitted) < 1e-6;
    emitted = next;
    if (done) break;
  }
  const s = stateAt(track, emitted);
  if (!s) return null;
  const d = path(s.p, tRecv - emitted);
  const range = norm(d);
  const c = pathSpeed(air, s.p[2]);
  if (range === 0) return { emitted, range, factor: 1 };
  const u: Vec3 = [d[0] / range, d[1] / range, d[2] / range];
  // d(emitted)/d(tRecv), the ratio of heard to emitted frequency: c / (c - approach) in still air.
  const factor = (c + dot(u, w)) / (c + dot(u, w) - dot(u, s.v));
  return { emitted, range, factor };
}

/** The tempting mistake, kept for the tests: the aircraft's speed at the moment of hearing. */
export function naiveHeardAt(track: Track, tRecv: number, air: Air): Heard | null {
  const s = stateAt(track, tRecv);
  if (!s) return null;
  const range = norm(s.p);
  const c = pathSpeed(air, s.p[2]);
  const approach = range > 0 ? -dot(s.v, s.p) / range : 0;
  return { emitted: tRecv, range, factor: c / (c - approach) };
}
