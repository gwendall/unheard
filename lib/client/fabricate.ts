// Polls made up from flybys, in the exact shape the aircraft API returns. The example on the
// page and the end-to-end fixture both use it, so they go through the real parsing path.

import type { AircraftMeta, PolledAircraft, Poll } from "../adsb";
import type { Listener } from "../core/geo";
import { flybyFixes, type Flyby } from "../core/synth";
import type { Fix } from "../core/track";

export type Actor = { meta: AircraftMeta; flyby: Flyby };

const FT = 0.3048;
const KT = 1852 / 3600;

function polled(meta: AircraftMeta, f: Fix): PolledAircraft {
  const [ve, vn, vu] = f.velocity;
  return {
    hex: meta.hex,
    flight: meta.callsign,
    r: meta.registration,
    t: meta.type,
    category: meta.category,
    lat: Number(f.lat.toFixed(6)),
    lon: Number(f.lon.toFixed(6)),
    alt_geom: Math.round(f.altitude / FT),
    alt_baro: Math.round(f.altitude / FT),
    gs: Number((Math.hypot(ve, vn) / KT).toFixed(1)),
    track: Number((((Math.atan2(ve, vn) * 180) / Math.PI + 360) % 360).toFixed(2)),
    geom_rate: Math.round((vu / FT) * 60),
    seen_pos: 0,
  };
}

/** One poll every `every` seconds from `from` to `to` (UTC seconds), every actor in each. */
export function fabricatePolls(listener: Listener, actors: Actor[], from: number, to: number, every = 2): Poll[] {
  const tracks = actors.map((a) => flybyFixes(listener, a.flyby, from, to, every));
  const polls: Poll[] = [];
  for (let i = 0; i < tracks[0].length; i++) {
    polls.push({ now: Math.round(tracks[0][i].t * 1000), aircraft: actors.map((a, j) => polled(a.meta, tracks[j][i])) });
  }
  return polls;
}
