// The where page's arithmetic, no DOM and no worker: what a file's date prefills, the time window
// and the days a day and an hour mean, a typed place, and the time at a place.

import type { CreatedAt, FileMetadata } from "./metadata";

/** The square searched around the place given, metres. */
export const SQUARE = 100_000;

/** The oldest day the archive will reach: where the daily job stops (OLDEST in scripts/history-job.ts). */
export const OLDEST_DAY = "2026-01-01";
/** An hour given means this far either side: the hour the search was measured with. */
const HALF_HOUR = 1800;

/** Roughly where: its name, its centre, and its time zone when the geocoder gives one. */
export type Place = { name: string; lat: number; lon: number; zone?: string };

export type Zone = "local" | "utc";

/** What a file's date means for the form: `from` says what the page tells about it. */
export type Prefill = { day?: string; time?: string; zone: Zone; from?: "zoned" | "utc" | "clock" | "day"; source?: string };

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (utc: number) => new Date(utc * 1000).toISOString().slice(0, 10);
const timeOf = (utc: number) => new Date(utc * 1000).toISOString().slice(11, 16);

/**
 * The day and hour a file's date gives. A clock with a zone, and an `mvhd` (UTC by the format),
 * are absolute: shown in UTC. A clock with no zone is what the owner's clock said there: shown as
 * it reads, as local time. A year or a month alone fills nothing.
 */
export function prefillOf(meta: Pick<FileMetadata, "createdAt">): Prefill {
  const c: CreatedAt | undefined = meta.createdAt;
  if (!c || c.precision === "year" || c.precision === "month") return { zone: "local" };
  const absolute = c.offsetMinutes !== undefined || c.source === "mvhd";
  const zone: Zone = absolute ? "utc" : "local";
  if (c.precision === "day") return { day: dayOf(c.utc), zone: "local", from: "day", source: c.source };
  return { day: dayOf(c.utc), time: timeOf(c.utc), zone, from: c.offsetMinutes !== undefined ? "zoned" : absolute ? "utc" : "clock", source: c.source };
}

/** Coordinates as people type them: "48.85, 2.35", "48.85 2.35", "48,85 2,35". */
export function parseCoordinates(text: string): { lat: number; lon: number } | null {
  const m = /^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1].replace(",", "."));
  const lon = Number(m[2].replace(",", "."));
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

export const coordinates = (p: { lat: number; lon: number }, digits = 4) => `${p.lat.toFixed(digits)}, ${p.lon.toFixed(digits)}`;

/** Minutes ahead of UTC at a place at a moment: its zone when known, else what its longitude says. */
export function offsetAt(place: Pick<Place, "lon" | "zone">, utc: number): number {
  if (!place.zone) return Math.round(place.lon / 15) * 60;
  const at = new Date(utc * 1000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: place.zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(at).map((x) => [x.type, Number(x.value)]));
  return Math.round((Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - Math.floor(utc / 60) * 60_000) / 60_000);
}

/**
 * The earliest and the latest the recording may have started, UTC seconds. An hour is the half
 * hour either side of it; with no hour, the whole day. Local time needs the place.
 */
export function windowOf(when: { day: string; time?: string; zone: Zone }, place: Pick<Place, "lon" | "zone">): [number, number] {
  const face = Date.parse(`${when.day}T${when.time || "00:00"}:00Z`) / 1000;
  const utc = (t: number) => (when.zone === "utc" ? t : t - offsetAt(place, t - offsetAt(place, t) * 60) * 60);
  return when.time ? [utc(face) - HALF_HOUR, utc(face) + HALF_HOUR] : [utc(face), utc(face + 86_400)];
}

/** The UTC days of flights that a window and a recording's length reach. */
export function daysOf(window: [number, number], duration: number): string[] {
  const days: string[] = [];
  for (let d = Math.floor(window[0] / 86_400); d <= Math.floor((window[1] + duration) / 86_400); d++) days.push(dayOf(d * 86_400));
  return days;
}

/** How many separate passes some tones make: closest moments within 30 s of a pass's first are that pass. */
export function passesOf(closest: number[]): number {
  let n = 0;
  let first = -Infinity;
  for (const t of [...closest].sort((a, b) => a - b)) {
    if (t - first < 30) continue;
    n++;
    first = t;
  }
  return n;
}

/** The time of day at a UTC moment, offset by some minutes: "18:03:44". */
export function clockOf(utc: number, offsetMinutes = 0): string {
  const t = new Date((utc + offsetMinutes * 60) * 1000);
  return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}

export const osmLink = (p: { lat: number; lon: number }) => `https://www.openstreetmap.org/?mlat=${p.lat.toFixed(5)}&mlon=${p.lon.toFixed(5)}#map=14/${p.lat.toFixed(5)}/${p.lon.toFixed(5)}`;

/** Metres between two points, on the flat: they lie in one search square. */
export function metresApart(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const east = (a.lon - b.lon) * 111_195 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((a.lat - b.lat) * 111_195, east);
}

/**
 * The answers to show: the best, then the next ones that are not its mirror at the same start,
 * which the best already names (wherewhen's rule for the answer it must lead).
 */
export function distinctAnswers<A extends { lat: number; lon: number; start: number; mirror: { lat: number; lon: number } | null }>(answers: A[], count: number): A[] {
  const best = answers[0];
  return answers.filter((a) => a === best || !best.mirror || metresApart(best.mirror, a) > 300 || Math.abs(a.start - best.start) > 20).slice(0, count);
}

/** Places by name, from Open-Meteo's geocoder: no key, and only the typed name is sent. */
export async function geocode(name: string, language: string, signal?: AbortSignal): Promise<Place[]> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=${language}&format=json`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const { results } = (await res.json()) as { results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number; timezone?: string }[] };
  return (results ?? []).map((r) => ({ name: [r.name, r.admin1, r.country].filter((x, i, all) => x && all.indexOf(x) === i).join(", "), lat: r.latitude, lon: r.longitude, zone: r.timezone }));
}
