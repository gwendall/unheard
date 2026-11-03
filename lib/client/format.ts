import type { AircraftMeta } from "../adsb";
import { DEFAULT_LOCALE, LANGUAGES, type Locale } from "../locales";
import { aircraftType } from "./types";

/** Feet and miles per hour for American English, metres and km/h everywhere else. */
export const imperial = () => typeof navigator !== "undefined" && /^en-US$/i.test(navigator.language);

/** One significant figure: 187 is 200, 1.4 is 1. */
const rough = (x: number) => {
  const unit = 10 ** Math.floor(Math.log10(Math.max(x, 1e-9)));
  return Math.round(x / unit) * unit;
};

/** Distances, heights and times as people say them in a language: "1.2 km" or "1,2 km". */
export function formatFor(locale: Locale) {
  const loc = LANGUAGES[locale].tag;
  // Every language but English keeps the number and its unit together.
  const unit = locale === DEFAULT_LOCALE ? " " : "\u00a0";
  const n = (x: number, digits = 0) => x.toLocaleString(loc, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return {
    km: (m: number) => (m < 950 ? `${n(Math.round(m / 10) * 10)}${unit}m` : `${n(m / 1000, m < 9500 ? 1 : 0)}${unit}km`),
    /** A height: "550 m" or "1,800 ft", rounded the way people say it. */
    height: (m: number) => (imperial() ? `${n(Math.round(m / 0.3048 / 50) * 50)}${unit}ft` : `${n(Math.round(m / (m < 1000 ? 10 : 50)) * (m < 1000 ? 10 : 50))}${unit}m`),
    /** A ground speed: "200 km/h" or "124 mph". */
    speed: (ms: number) => (imperial() ? `${Math.round(ms * 2.23694)}${unit}mph` : `${Math.round(ms * 3.6)}${unit}km/h`),
    /** A distance only known as an order of magnitude: one significant figure, "600 m" or "3 km". */
    roughKm: (m: number) => (rough(m) < 1000 ? `${n(rough(m))}${unit}m` : `${n(rough(m / 1000))}${unit}km`),
    /** A speed only known as an order of magnitude: one significant figure, "200 km/h" or "100 mph". */
    roughSpeed: (ms: number) => (imperial() ? `${n(rough(ms * 2.23694))}${unit}mph` : `${n(rough(ms * 3.6))}${unit}km/h`),
    seconds: (s: number) => `${Math.round(s)}${unit}s`,
    clock,
  };
}
export type Format = ReturnType<typeof formatFor>;

export const clock = (s: number) => `${s < 0 ? "-" : ""}${Math.floor(Math.abs(s) / 60)}:${String(Math.floor(Math.abs(s) % 60)).padStart(2, "0")}`;
export const { km, height, speed, seconds } = formatFor(DEFAULT_LOCALE);

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
