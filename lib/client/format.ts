import type { AircraftMeta } from "../adsb";
import { aircraftType } from "./types";

/** Feet and miles per hour for American English, metres and km/h everywhere else. */
export const imperial = () => typeof navigator !== "undefined" && /^en-US$/i.test(navigator.language);

export const km = (m: number) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} km`);
/** A height: "550 m" or "1,800 ft", rounded the way people say it. */
export const height = (m: number) =>
  imperial() ? `${(Math.round(m / 0.3048 / 50) * 50).toLocaleString("en-US")} ft` : `${(Math.round(m / (m < 1000 ? 10 : 50)) * (m < 1000 ? 10 : 50)).toLocaleString("en-US")} m`;
/** A ground speed: "200 km/h" or "124 mph". */
export const speed = (ms: number) => (imperial() ? `${Math.round(ms * 2.23694)} mph` : `${Math.round(ms * 3.6)} km/h`);
export const seconds = (s: number) => `${Math.round(s)} s`;
export const clock = (s: number) => `${s < 0 ? "-" : ""}${Math.floor(Math.abs(s) / 60)}:${String(Math.floor(Math.abs(s) % 60)).padStart(2, "0")}`;

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
