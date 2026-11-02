// The aircraft around the listener right now, for the live list while recording.

import { collect, fixOf, type AircraftMeta, type Poll } from "../adsb";
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

export function nearbyFrom(poll: Poll | null, listener: Listener, limit = 6): Nearby[] {
  if (!poll) return [];
  const metas = collect([poll]);
  const out: Nearby[] = [];
  for (const a of poll.aircraft) {
    const fix = fixOf(a, poll.now);
    if (!fix) continue;
    const p = toLocal(listener, fix.lat, fix.lon, fix.altitude);
    const [ve, vn] = fix.velocity;
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
