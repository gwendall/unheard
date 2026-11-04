// The aircraft around the listener right now, for the live list while recording.

import { collect, fixOf, type AircraftMeta, type Poll } from "../adsb";
import { FRESH_FOR, STALE_FOR } from "../area";
import { toLocal, type Listener } from "../core/geo";

export type Nearby = {
  meta: AircraftMeta;
  /** Straight-line distance now, metres. */
  distance: number;
  /** Height above the listener, metres. */
  height: number;
  /** Seconds until it is closest (negative: already passed), and how close it gets, metres. */
  closestIn: number;
  closestAt: number;
};

/**
 * The aircraft of a poll as they are at `at` (UTC milliseconds), straight ahead from the poll: a
 * shared answer is a few seconds old, a minute when upstream refuses. A phone whose clock is
 * further from the poll's than any cache could keep it is not believed.
 */
export function nearbyFrom(poll: Poll | null, listener: Listener, limit = 6, at = poll?.now ?? 0): Nearby[] {
  if (!poll) return [];
  const old = (at - poll.now) / 1000;
  const age = old > 0 && old <= FRESH_FOR + STALE_FOR ? old : 0;
  const metas = collect([poll]);
  const out: Nearby[] = [];
  for (const a of poll.aircraft) {
    const fix = fixOf(a, poll.now);
    if (!fix) continue;
    const [ve, vn, vu] = fix.velocity;
    const [pe, pn, pu] = toLocal(listener, fix.lat, fix.lon, fix.altitude);
    const p = [pe + ve * age, pn + vn * age, pu + vu * age];
    const v2 = ve * ve + vn * vn;
    const tc = v2 > 1 ? -(p[0] * ve + p[1] * vn) / v2 : 0;
    const ce = p[0] + ve * tc;
    const cn = p[1] + vn * tc;
    out.push({
      meta: metas.get(a.hex)!.meta,
      distance: Math.hypot(p[0], p[1], p[2]),
      height: p[2],
      closestIn: tc,
      closestAt: Math.hypot(ce, cn, p[2]),
    });
  }
  return out.sort((a, b) => a.distance - b.distance).slice(0, limit);
}
