// Which aircraft around the listener is worth listening for, and when. Read from the live flight
// data before and during a recording, so nobody records two minutes of an empty sky.

import type { Nearby } from "./nearby";
import { isTonal } from "./types";

/** Seconds ahead worth waiting for: past that, the forecast of a straight track means little. */
export const HORIZON = 600;
/** Closest distance under which an aircraft can be heard: propellers and rotors, then jets. */
export const REACH_TONAL = 5_000;
export const REACH_JET = 2_500;

/** Whether this aircraft can leave a trace a phone picks up, judging by its kind and how close it comes. */
export function audible(n: Nearby): boolean {
  const reach = isTonal(n.meta.type, n.meta.category) === false ? REACH_JET : REACH_TONAL;
  if (n.closestIn > HORIZON) return false;
  // Already past: only while it is still near.
  if (n.closestIn < 0) return n.distance < reach;
  return n.closestAt < reach;
}

export type Outlook =
  /** One will pass close: in `in` seconds, at `at` metres. */
  | { kind: "coming"; best: Nearby; in: number; at: number }
  /** One is close right now. */
  | { kind: "passing"; best: Nearby }
  /** Aircraft around, none close enough to hear. */
  | { kind: "quiet"; nearest: Nearby | null; count: number };

/** Within this many seconds of its closest point, an aircraft is passing. */
const NOW = 15;

/**
 * The best chance among the aircraft around: the one that will be heard best soonest. Distance
 * counts more than time (a plane 1 km away in 3 minutes beats one 4 km away now), and a
 * propeller beats a jet.
 */
export function outlook(around: Nearby[]): Outlook {
  let best: Nearby | null = null;
  let bestCost = Infinity;
  for (const n of around) {
    if (!audible(n)) continue;
    const jet = isTonal(n.meta.type, n.meta.category) === false;
    const at = n.closestIn < 0 ? n.distance : n.closestAt;
    const cost = at / 1000 + Math.max(0, n.closestIn) / 120 + (jet ? 2 : 0);
    if (cost < bestCost) {
      best = n;
      bestCost = cost;
    }
  }
  if (!best) {
    const nearest = around.reduce<Nearby | null>((a, n) => (!a || n.distance < a.distance ? n : a), null);
    return { kind: "quiet", nearest, count: around.length };
  }
  if (best.closestIn <= NOW) return { kind: "passing", best };
  return { kind: "coming", best, in: best.closestIn, at: best.closestAt };
}
