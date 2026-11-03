// The Livermore set (Pathak 2026, Zenodo record 23424278, CC BY 4.0): 40 smartphone recordings
// of aircraft passing over Livermore, California, in May 2026, each with its ADS-B track (KML)
// and the UTC frequency-time ridge of one harmonic. scripts/fetch-livermore.ts fetches it into
// evals/.cache/livermore/. This file reads it into what an eval scenario needs; evals/lib/real.ts
// turns that into scenarios. See evals/DATASETS.md for the traps.
//
// What the set does not publish, and how it is recovered here:
// - The microphone position. Each passage gives L, the horizontal distance from the recorder to
//   the ADS-B ground track at closest approach, and H, the track's height above the recorder.
//   The recorder is the point whose distance to the tracks best matches L (robust least
//   squares, passages more than 150 m off set aside and fitted again as a second site), at the
//   track's altitude minus H. Each passage keeps its residual.
// - The UTC time of the first sample. The ridge's times are UTC; sliding the ridge over the
//   recording's own spectrogram finds the start that puts it on the tone, to about 0.1 s. The
//   author's clock is the phone's file-name time, to about a second.
// - Velocities: the KML has positions only. Ground speed, track and climb come from the
//   neighbouring points.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Poll, PolledAircraft } from "../../lib/adsb";
import { toLocal, type Listener } from "../../lib/core/geo";
import { computeSpectrogram } from "../../lib/core/spectrogram";

export const LIVERMORE = new URL("../.cache/livermore/", import.meta.url);

/** One KML point: UTC seconds, degrees, metres above mean sea level (EGM96). */
export type TrackPoint = { t: number; lat: number; lon: number; alt: number };

export type Passage = {
  /** The dataset's case name, e.g. N86LP_R01: registration and recording number. */
  id: string;
  registration: string;
  /** ICAO 24-bit address, from the US registration. */
  hex: string;
  category: string;
  dir: URL;
  /** The whole flight from its KML, airborne points only. */
  track: TrackPoint[];
  /** The author's frequency-time ridge of one harmonic, UTC seconds and Hz. */
  ridge: { t: number; f: number }[];
  /** L: horizontal distance from the recorder to the ADS-B ground track at closest approach, m. */
  offset: number;
  /** H: the track's height above the recorder at closest approach, m. */
  height: number;
  /** Slant distance at closest approach from the published ADS-B values, m. */
  slant: number;
};

const iso = (s: string) => Date.parse(s) / 1000;

/** The points of a gx:Track, in time order, duplicates and ground points (altitude 0) left out. */
export function readKml(text: string): TrackPoint[] {
  const when = [...text.matchAll(/<when\s*>([^<]+)<\/when>/g)].map((m) => iso(m[1].trim()));
  const coords = [...text.matchAll(/<gx:coord\s*>([^<]+)<\/gx:coord>/g)].map((m) => m[1].trim().split(/\s+/).map(Number));
  if (when.length !== coords.length) throw new Error(`KML: ${when.length} times for ${coords.length} points`);
  const points = when.map((t, i) => ({ t, lon: coords[i][0], lat: coords[i][1], alt: coords[i][2] })).filter((p) => Number.isFinite(p.t) && p.alt > 0);
  points.sort((a, b) => a.t - b.t);
  return points.filter((p, i) => i === 0 || p.t - points[i - 1].t > 0.05);
}

/** Minimal CSV (no quoted commas in this set). */
function readCsv(text: string): Record<string, string>[] {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const keys = head.split(",");
  return rows.map((line) => Object.fromEntries(line.split(",").map((v, i) => [keys[i], v])));
}

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, no O
const SUFFIX = 1 + LETTERS.length * (1 + LETTERS.length);
const BUCKET4 = 1 + LETTERS.length + 10;
const BUCKET3 = 10 * BUCKET4 + SUFFIX;
const BUCKET2 = 10 * BUCKET3 + SUFFIX;
const BUCKET1 = 10 * BUCKET2 + SUFFIX;

/** US registration (N-number) to its ICAO address, the FAA's own block allocation. */
export function nNumberToIcao(registration: string): string {
  const n = registration.toUpperCase();
  if (!/^N[1-9][0-9A-HJ-NP-Z]{0,4}$/.test(n)) throw new Error(`not a US registration: ${registration}`);
  const rest = n.slice(1);
  const letters = (s: string) => (s.length ? (LETTERS.length + 1) * LETTERS.indexOf(s[0]) + 1 + (s.length > 1 ? LETTERS.indexOf(s[1]) + 1 : 0) : 0);
  let out = 0xa00001 + (Number(rest[0]) - 1) * BUCKET1;
  const buckets = [BUCKET2, BUCKET3, BUCKET4];
  for (let i = 1; i < rest.length; i++) {
    const c = rest[i];
    if (LETTERS.includes(c)) {
      out += i === 4 ? 1 + LETTERS.indexOf(c) : letters(rest.slice(i));
      break;
    }
    out += i === 4 ? 1 + LETTERS.length + Number(c) : SUFFIX + Number(c) * buckets[i - 1];
  }
  return out.toString(16);
}

/** Every passage of the set, in the order of its results table; empty when not fetched. */
export function readPassages(root = LIVERMORE): Passage[] {
  const table = new URL("downloads/final_results_40_cases.csv", root);
  const extracted = new URL("extracted/", root);
  if (!existsSync(table) || !existsSync(extracted)) return [];
  // Case directories sit two levels down: extracted/<zip>/<category>/<case>/.
  const dirs = new Map<string, URL>();
  const subdirs = (u: URL) => readdirSync(u, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => new URL(`${d.name}/`, u));
  for (const zip of subdirs(extracted)) for (const category of subdirs(zip)) for (const dir of subdirs(category)) dirs.set(dir.pathname.split("/").at(-2)!, dir);
  const out: Passage[] = [];
  for (const row of readCsv(readFileSync(table, "utf8"))) {
    const dir = dirs.get(row.case);
    if (!dir || !existsSync(new URL("audio.wav", dir))) continue;
    const registration = row.case.split("_")[0];
    const ridge = readCsv(readFileSync(new URL("frequency_vs_time_used.csv", dir), "utf8")).map((r) => ({ t: iso(r.time_utc), f: Number(r.frequency_hz) }));
    out.push({
      id: row.case,
      registration,
      hex: nNumberToIcao(registration),
      category: row.category,
      dir,
      track: readKml(readFileSync(new URL(row.track_file, dir), "utf8")),
      ridge,
      offset: Number(row.L_ADSB_m),
      height: Number(row.H_ADSB_above_recorder_m),
      slant: Number(row.R_ADSB_m),
    });
  }
  return out;
}

/** Where the ridge sits in time: its middle, UTC seconds (sound received, not emitted). */
export const ridgeMiddle = (p: Passage) => (p.ridge[0].t + p.ridge[p.ridge.length - 1].t) / 2;

/** The track's horizontal closest approach to a point: distance (m) and the altitude there (m). */
export function closestApproach(track: TrackPoint[], at: Listener, around: number, span = 180): { distance: number; alt: number } {
  let best = { distance: Infinity, alt: NaN };
  const near = track.filter((p) => Math.abs(p.t - around) <= span);
  const xy = near.map((p) => toLocal(at, p.lat, p.lon, p.alt));
  for (let i = 0; i + 1 < xy.length; i++) {
    const [ax, ay] = xy[i];
    const [bx, by] = xy[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const u = Math.max(0, Math.min(1, (-ax * dx - ay * dy) / Math.max(dx * dx + dy * dy, 1e-9)));
    const d = Math.hypot(ax + u * dx, ay + u * dy);
    if (d < best.distance) best = { distance: d, alt: near[i].alt + u * (near[i + 1].alt - near[i].alt) };
  }
  return best;
}

export type Site = {
  lat: number;
  lon: number;
  /** Metres above mean sea level: the median over the passages of track altitude minus H. */
  elevation: number;
  /** Per passage: distance to its track minus the published L, m. */
  residuals: Map<string, number>;
};

/** Soft L1 loss: quadratic under `scale`, linear beyond, so a stray passage pulls the fit less (see consensus). */
const softL1 = (r: number, scale = 50) => 2 * scale * scale * (Math.sqrt(1 + (r / scale) ** 2) - 1);

/**
 * The recorder as the one point whose horizontal distance to every passage's track matches its
 * published L: a coarse grid, then a pattern search from its best cells, on a robust loss.
 */
export function trilaterate(passages: Passage[], near: { lat: number; lon: number }): Site {
  const origin: Listener = { lat: near.lat, lon: near.lon, elevation: 0 };
  const mPerDegLat = 111_132;
  const mPerDegLon = 111_320 * Math.cos((near.lat * Math.PI) / 180);
  const at = (e: number, n: number): Listener => ({ lat: origin.lat + n / mPerDegLat, lon: origin.lon + e / mPerDegLon, elevation: 0 });
  // Only the minutes around each passage matter: cut the tracks once.
  const cut = passages.map((p) => ({ ...p, track: p.track.filter((x) => Math.abs(x.t - ridgeMiddle(p)) <= 180) }));
  const cost = (e: number, n: number) => cut.reduce((s, p) => s + softL1(closestApproach(p.track, at(e, n), ridgeMiddle(p)).distance - p.offset), 0);
  const grid: { e: number; n: number; c: number }[] = [];
  for (let e = -15_000; e <= 15_000; e += 500) for (let n = -15_000; n <= 15_000; n += 500) grid.push({ e, n, c: cost(e, n) });
  // Each passage alone allows two lines (one on each side of its track): refine the ten best
  // cells, not only the best, so a near-miss crossing cannot hold the fit.
  const refined = grid
    .sort((a, b) => a.c - b.c)
    .slice(0, 10)
    .map((cell) => {
      let best = cell;
      for (let step = 250; step > 0.1; ) {
        let moved = false;
        for (const [de, dn] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
          const c = cost(best.e + de, best.n + dn);
          if (c < best.c) {
            best = { e: best.e + de, n: best.n + dn, c };
            moved = true;
          }
        }
        if (!moved) step /= 2;
      }
      return best;
    });
  const best = refined.reduce((a, b) => (b.c < a.c ? b : a));
  const site = at(best.e, best.n);
  const residuals = new Map<string, number>();
  const elevations: number[] = [];
  for (const p of passages) {
    const ca = closestApproach(p.track, site, ridgeMiddle(p));
    residuals.set(p.id, ca.distance - p.offset);
    elevations.push(ca.alt - p.height);
  }
  elevations.sort((a, b) => a - b);
  return { lat: site.lat, lon: site.lon, elevation: elevations[elevations.length >> 1], residuals };
}

/** Passages whose distance to their track misses L by more than this were recorded elsewhere. */
const ELSEWHERE = 150;

export type Placed = { listener: Listener; site: string; residual: number };

/** How far a passage's track passes from a point, less its published L, m. */
const miss = (p: Passage, at: { lat: number; lon: number }) => closestApproach(p.track, { ...at, elevation: 0 }, ridgeMiddle(p)).distance - p.offset;

/**
 * The site most passages agree on: fit, keep the passages within 150 m of their L, fit again on
 * those, until the set holds. A robust loss alone still lets a few far passages drag the point.
 */
function consensus(passages: Passage[], near: { lat: number; lon: number }): { fit: Site; members: Passage[] } | null {
  let members = passages;
  let fit = trilaterate(members, near);
  for (let round = 0; round < 10; round++) {
    const next = passages.filter((p) => Math.abs(miss(p, fit)) < ELSEWHERE);
    if (next.length < 3) return null;
    if (next.length === members.length && next.every((p, i) => p === members[i])) break;
    members = next;
    fit = trilaterate(members, near);
  }
  return { fit, members };
}

/**
 * Where each passage was recorded: the site most passages agree on, then, among the passages it
 * does not explain, a second site when at least three agree on one. A passage neither site
 * explains is left out (no entry).
 */
export function placeRecorders(passages: Passage[], near = { lat: 37.68, lon: -121.77 }): Map<string, Placed> {
  const out = new Map<string, Placed>();
  let rest = passages;
  for (const site of ["main", "second"]) {
    if (rest.length < 3) break;
    const found = consensus(rest, near);
    if (!found) break;
    const { fit, members } = found;
    for (const p of members) out.set(p.id, { listener: { lat: fit.lat, lon: fit.lon, elevation: fit.elevation }, site, residual: fit.residuals.get(p.id)! });
    rest = rest.filter((p) => !members.includes(p));
  }
  return out;
}

/**
 * The UTC time of the first sample: the start that lays the published ridge (UTC) on the
 * recording's own tone. Whitened power (each bin less its median over the recording) along the
 * ridge, searched every 20 ms over every start that keeps the ridge inside the recording; it lands
 * within about 0.1 s (a bin either side is accepted, and the tone's slope is gentle).
 * `contrast` is the best mean against the spread of all others: a sharp peak is above 5.
 */
export function alignRidge(samples: Float32Array, sampleRate: number, ridge: { t: number; f: number }[]): { start: number; contrast: number } {
  const maxHz = Math.min(sampleRate / 2 - 50, Math.max(...ridge.map((r) => r.f)) * 1.2 + 50);
  const spec = computeSpectrogram(samples, sampleRate, { windowSeconds: 0.25, hopSeconds: 0.02, minHz: 20, maxHz });
  const { frames, bins, binHz, minHz, db, times } = spec;
  const white = new Float32Array(db.length);
  const column = new Float32Array(frames);
  for (let b = 0; b < bins; b++) {
    for (let k = 0; k < frames; k++) column[k] = db[k * bins + b];
    const sorted = Float32Array.from(column).sort();
    const med = sorted[frames >> 1];
    for (let k = 0; k < frames; k++) white[k * bins + b] = db[k * bins + b] - med;
  }
  const hop = times[1] - times[0];
  const duration = samples.length / sampleRate;
  const first = ridge[0].t;
  const last = ridge[ridge.length - 1].t;
  const scores: { start: number; s: number }[] = [];
  for (let start = last - duration + 0.2; start <= first - 0.2; start += 0.02) {
    let sum = 0;
    for (const r of ridge) {
      const k = Math.round((r.t - start - times[0]) / hop);
      const b = Math.round((r.f - minHz) / binHz);
      if (k < 0 || k >= frames || b < 1 || b + 1 >= bins) continue;
      const i = k * bins + b;
      sum += Math.max(white[i - 1], white[i], white[i + 1]);
    }
    scores.push({ start, s: sum / ridge.length });
  }
  const best = scores.reduce((a, b) => (b.s > a.s ? b : a));
  const others = scores.filter((x) => Math.abs(x.start - best.start) > 1).map((x) => x.s);
  const mean = others.reduce((a, b) => a + b, 0) / Math.max(1, others.length);
  const sd = Math.sqrt(others.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, others.length)) || 1;
  return { start: best.start, contrast: (best.s - mean) / sd };
}

const FT = 0.3048;
const KT = 1852 / 3600;
const KM = 40;

/**
 * Polls as the page would have made them, from the KML points of each aircraft: one fix per point
 * between `from` and `to` (and the nearest point outside each end, as the KML is sparser than a
 * 2 s poll), within 40 km of the listener. Speed, track and climb from the neighbouring points
 * (at least 4 s away).
 * Altitudes are MSL here, as is the listener's elevation (it comes from the same tracks).
 */
export function pollsOf(aircraft: { hex: string; registration: string; track: TrackPoint[] }[], listener: Listener, from: number, to: number): Poll[] {
  const polls: Poll[] = [];
  for (const a of aircraft) {
    const pts = a.track;
    const inside = pts.map((p, i) => (p.t >= from && p.t <= to ? i : -1)).filter((i) => i >= 0);
    const lo = inside.length ? Math.max(0, inside[0] - 1) : pts.findLastIndex((p) => p.t < from);
    const hi = inside.length ? Math.min(pts.length - 1, inside[inside.length - 1] + 1) : pts.findIndex((p) => p.t > to);
    if (lo < 0 || hi < 0) continue;
    const near = pts.slice(lo, hi + 1).some((p) => {
      const [e, n] = toLocal(listener, p.lat, p.lon, p.alt);
      return Math.hypot(e, n) < KM * 1000;
    });
    if (!near) continue;
    for (let i = lo; i <= hi; i++) {
      const p = pts[i];
      // Neighbours at least 4 s away on each side: two points a fraction of a second apart
      // turn a few metres of position noise into knots of false speed.
      let j = Math.max(0, i - 1);
      while (j > 0 && p.t - pts[j].t < 4) j--;
      let k = Math.min(pts.length - 1, i + 1);
      while (k < pts.length - 1 && pts[k].t - p.t < 4) k++;
      const prev = pts[j];
      const next = pts[k];
      const dt = next.t - prev.t;
      if (dt <= 0) continue;
      const [e0, n0] = toLocal(listener, prev.lat, prev.lon, prev.alt);
      const [e1, n1] = toLocal(listener, next.lat, next.lon, next.alt);
      const ve = (e1 - e0) / dt;
      const vn = (n1 - n0) / dt;
      const ac: PolledAircraft = {
        hex: a.hex,
        r: a.registration,
        lat: p.lat,
        lon: p.lon,
        alt_geom: Math.round(p.alt / FT),
        gs: Math.round((Math.hypot(ve, vn) / KT) * 10) / 10,
        track: Math.round((((Math.atan2(ve, vn) * 180) / Math.PI + 360) % 360) * 100) / 100,
        geom_rate: Math.round((((next.alt - prev.alt) / dt / FT) * 60) / 64) * 64,
        seen_pos: 0,
      };
      polls.push({ now: Math.round(p.t * 1000), aircraft: [ac] });
    }
  }
  return polls.sort((x, y) => x.now - y.now);
}
