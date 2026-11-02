import type { AircraftMeta } from "../adsb";
import { aircraftType } from "./types";

export const km = (m: number) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} km`);
export const feet = (m: number) => `${(Math.round(m / 0.3048 / 50) * 50).toLocaleString("en-US")} ft`;
export const knots = (ms: number) => `${Math.round(ms / (1852 / 3600))} knots`;
export const seconds = (s: number) => `${Math.round(s)} s`;
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** What to call an aircraft: its callsign, else its registration, else its hex code. */
export function nameOf(meta: AircraftMeta): string {
  return meta.callsign || meta.registration || meta.hex.toUpperCase();
}

/** "Cessna 172 Skyhawk, F-GABC" or just the type, or nothing. */
export function describe(meta: AircraftMeta): string {
  const type = aircraftType(meta.type)?.name;
  const reg = meta.registration && meta.registration !== nameOf(meta) ? meta.registration : null;
  return [type, reg].filter(Boolean).join(", ");
}
