// ADS-B as the app sees it: polls of the aircraft around a point (adsb.lol's /v2/point, readsb
// JSON), slimmed to what the physics needs. The API route, the page, the track recorder and the
// evals all read polls through this one file.

import type { Fix } from "./core/track";

/** One aircraft in one poll, readsb field names, only what we use. */
export type PolledAircraft = {
  hex: string;
  flight?: string;
  r?: string;
  t?: string;
  category?: string;
  lat?: number;
  lon?: number;
  /** Feet, WGS84 ellipsoid. */
  alt_geom?: number;
  /** Feet, pressure altitude, or "ground". */
  alt_baro?: number | "ground";
  /** Knots over the ground. */
  gs?: number;
  /** Degrees true. */
  track?: number;
  /** Feet per minute. */
  geom_rate?: number;
  baro_rate?: number;
  /** Seconds since the position was received. */
  seen_pos?: number;
};

/** What the aggregator knew at `now` (UTC milliseconds). */
export type Poll = { now: number; aircraft: PolledAircraft[] };

export type AircraftMeta = {
  hex: string;
  callsign?: string;
  registration?: string;
  /** ICAO type designator, e.g. C172. */
  type?: string;
  /** ADS-B emitter category: A1 light, A7 rotorcraft... */
  category?: string;
};

const KEEP = ["hex", "flight", "r", "t", "category", "lat", "lon", "alt_geom", "alt_baro", "gs", "track", "geom_rate", "baro_rate", "seen_pos"] as const;

/** Slims an upstream answer (adsb.lol `ac`, adsb.fi `aircraft`) to a Poll. */
export function slimPoll(upstream: { now?: number; ac?: unknown[]; aircraft?: unknown[] }): Poll {
  // adsb.lol gives milliseconds, adsb.fi seconds.
  const raw = upstream.now ?? Date.now();
  const now = raw < 1e11 ? raw * 1000 : raw;
  const list = (upstream.ac ?? upstream.aircraft ?? []) as Record<string, unknown>[];
  const aircraft: PolledAircraft[] = [];
  for (const a of list) {
    if (typeof a.hex !== "string" || typeof a.lat !== "number" || typeof a.lon !== "number") continue;
    const slim: Record<string, unknown> = {};
    for (const k of KEEP) if (a[k] !== undefined) slim[k] = typeof a[k] === "string" ? (a[k] as string).trim() : a[k];
    aircraft.push(slim as PolledAircraft);
  }
  return { now, aircraft };
}

const FT = 0.3048;
const KT = 1852 / 3600;
const FPM = FT / 60;

/** A position fix from one polled aircraft, or null when it is on the ground or incomplete. */
export function fixOf(a: PolledAircraft, nowMs: number): Fix | null {
  if (a.lat === undefined || a.lon === undefined || a.gs === undefined || a.track === undefined) return null;
  const feet = typeof a.alt_geom === "number" ? a.alt_geom : typeof a.alt_baro === "number" ? a.alt_baro : null;
  if (feet === null) return null;
  const rad = (a.track * Math.PI) / 180;
  const gs = a.gs * KT;
  const climb = (a.geom_rate ?? a.baro_rate ?? 0) * FPM;
  return {
    t: nowMs / 1000 - (a.seen_pos ?? 0),
    lat: a.lat,
    lon: a.lon,
    altitude: feet * FT,
    velocity: [gs * Math.sin(rad), gs * Math.cos(rad), climb],
  };
}

export type Sighting = { meta: AircraftMeta; fixes: Fix[] };

/** Every aircraft seen across the polls, with its fixes in time order. */
export function collect(polls: Poll[]): Map<string, Sighting> {
  const seen = new Map<string, Sighting>();
  for (const poll of polls) {
    for (const a of poll.aircraft) {
      const fix = fixOf(a, poll.now);
      let s = seen.get(a.hex);
      if (!s) {
        s = { meta: { hex: a.hex }, fixes: [] };
        seen.set(a.hex, s);
      }
      if (a.flight) s.meta.callsign = a.flight;
      if (a.r) s.meta.registration = a.r;
      if (a.t) s.meta.type = a.t;
      if (a.category) s.meta.category = a.category;
      if (fix) s.fixes.push(fix);
    }
  }
  for (const s of seen.values()) s.fixes.sort((x, y) => x.t - y.t);
  return seen;
}
