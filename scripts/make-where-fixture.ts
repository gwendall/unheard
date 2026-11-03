// Writes the end-to-end test's flight history (committed, ODbL 1.0, © adsb.lol contributors): one
// hour of one real tile of a day, from a day indexed in evals/.cache/history/, and the scene the
// test's synthetic recording is made from: a spot on the ground where real propeller or rotor
// aircraft of that hour pass close, one after the other. No real recording, and no one's
// microphone: the spot is picked by this script.
//
//   node scripts/make-where-fixture.ts [day] [tile] [hour] [which spot]
//
// e2e/history/days.json, e2e/history/<day>/manifest.json, e2e/history/<day>/<tile>.bin.gz,
// e2e/history/scene.json

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { decodeTile, gunzip, isProp, STRIDE, TileWriter, type Flight, type Manifest } from "../lib/history.ts";
import { groundOf, httpTiles } from "../lib/terrain.ts";

const day = process.argv[2] ?? "2026-05-16";
const tile = process.argv[3] ?? "33_-112";
const hour = Number(process.argv[4] ?? 18);
const pick = Number(process.argv[5] ?? 0);
const DURATION = 300;
/** Degrees around the spot and seconds around the hour that the fixture keeps. */
const BOX = 0.25;
const MARGIN_S = 300;
/** The passes of the scene: low, within earshot of the spot. */
const ALT_FT = 4200;
/** One aircraft in so many, besides the scene's, stays in the fixture. */
const EVERY = Number(process.env.EVERY ?? 8);
const source = new URL(`../evals/.cache/history/${day}/`, import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", source), "utf8")) as Manifest;
const whole = decodeTile(await gunzip(new Uint8Array(readFileSync(new URL(`${tile}.bin.gz`, source)))));
const from = whole.day + hour * 3600;
const to = from + 3600;

// The scene: per 1 km cell, the aircraft that pass it straight and level, 300 m to 1.5 km away,
// and the cell where the most of them pass one after the other, then the quietest over the hour.
const flights = whole.flights.filter((f) => isProp(f.kind));
const CELL = 1000;
const M_LAT = 111_195;
const mLon = M_LAT * Math.cos(((whole.lat0 + whole.size / 2) * Math.PI) / 180);
type Pass = { f: Flight; t: number; d: number };
const cells = new Map<string, Map<string, Pass>>();
const straight = (f: Flight, j: number) => {
  for (let k = j - 1; k >= 0 && f.t[j] - f.t[k] < 30; k--) if (Math.abs(((f.track[k] - f.track[j] + 540) % 360) - 180) > 12) return false;
  for (let k = j + 1; k < f.t.length && f.t[k] - f.t[j] < 30; k++) if (Math.abs(((f.track[k] - f.track[j] + 540) % 360) - 180) > 12) return false;
  return true;
};
for (const f of flights) {
  for (let j = 0; j < f.t.length; j++) {
    if (f.t[j] < from + 60 || f.t[j] > to - DURATION - 60 || f.altFt[j] > ALT_FT || f.gs[j] < 60 || !straight(f, j)) continue;
    const y0 = Math.round((f.lat[j] * M_LAT) / CELL);
    const x0 = Math.round((f.lon[j] * mLon) / CELL);
    for (let y = y0 - 2; y <= y0 + 2; y++) {
      for (let x = x0 - 2; x <= x0 + 2; x++) {
        const d = Math.hypot(y * CELL - f.lat[j] * M_LAT, x * CELL - f.lon[j] * mLon);
        if (d > 1500) continue;
        const key = `${y}:${x}`;
        const here = cells.get(key) ?? new Map<string, Pass>();
        const known = here.get(f.hex);
        if (!known || d < known.d) here.set(f.hex, { f, t: f.t[j], d });
        cells.set(key, here);
      }
    }
  }
}
type Found = { passes: Pass[]; lat: number; lon: number; start: number; around: number };
const found: Found[] = [];
for (const [key, here] of cells) {
  const passes = [...here.values()].filter((p) => p.d >= 300).sort((a, b) => a.t - b.t);
  // From each pass, those that follow it at least 35 s apart inside the recording.
  for (const first of passes) {
    const start = Math.round(first.t - 35);
    const inside: Pass[] = [];
    for (const p of passes) {
      if (p.t >= first.t && p.t <= start + DURATION - 35 && (!inside.length || p.t - inside[inside.length - 1].t >= 35)) inside.push(p);
    }
    if (inside.length < 3) continue;
    const [y, x] = key.split(":").map(Number);
    found.push({ passes: inside, lat: (y * CELL) / M_LAT, lon: (x * CELL) / mLon, start, around: here.size });
  }
}
found.sort((a, b) => b.passes.length - a.passes.length || a.around - b.around);
const best = found[pick];
if (!best) throw new Error(`no spot with three passes in that hour (${found.length} found)`);

// The hour around the spot, one aircraft at a time (a run ends with its aircraft): what the search
// reads, small enough to commit.
const writer = new TileWriter(whole.day, whole.lat0, whole.lon0, whole.size);
const pt = new Float64Array(STRIDE);
const heard = new Set(best.passes.map((p) => p.f.hex));
// The scene's aircraft, and every few of the others: enough to choose from, small enough to commit.
const kept = whole.flights.filter((f, i) => heard.has(f.hex) || i % EVERY === 0);
for (const f of kept) {
  const aircraft = { hex: f.hex, kind: f.kind, type: f.type, registration: f.registration };
  writer.last = null;
  for (let j = 0; j < f.t.length; j++) {
    if (f.t[j] < from - MARGIN_S || f.t[j] > to + MARGIN_S || Math.abs(f.lat[j] - best.lat) > BOX || Math.abs(f.lon[j] - best.lon) > BOX) continue;
    [pt[0], pt[1], pt[2], pt[3], pt[4], pt[5], pt[6], pt[7]] = [f.t[j], f.lat[j], f.lon[j], f.altFt[j], f.gs[j], f.track[j], f.vrate[j], f.flags[j]];
    writer.add(aircraft, pt, 0);
  }
}
const content = writer.bytes();
const gz = gzipSync(content, { level: 9 });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const out = new URL(`../e2e/history/${day}/`, import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL(`${tile}.bin.gz`, out), gz);
console.log(`${found.length} spots`);
const small: Manifest = {
  ...manifest,
  filter: `${manifest.filter}; end-to-end fixture: tile ${tile} only, around the test's spot, ${hour}:00 to ${hour + 1}:00 UTC with five minutes each side`,
  tiles: { [tile]: { lat0: writer.lat0, lon0: writer.lon0, size: writer.size, runs: writer.runs, points: writer.points, bytes: gz.length, sha256: sha(gz), content: sha(content) } },
  totals: { tiles: 1, aircraft: writer.aircraft, points: writer.points, bytes: gz.length },
};
writeFileSync(new URL("manifest.json", out), `${JSON.stringify(small, null, 1)}\n`);
writeFileSync(new URL("../days.json", out), `${JSON.stringify([day])}\n`);
const lat = Math.round(best.lat * 1e4) / 1e4;
const lon = Math.round(best.lon * 1e4) / 1e4;
const ground = await groundOf(httpTiles, lat, lon, 1000);
writeFileSync(
  new URL("../scene.json", out),
  `${JSON.stringify({ day, hour, duration: DURATION, lat, lon, elevation: Math.round(ground(lat, lon)), start: best.start, aircraft: best.passes.map((p) => ({ hex: p.f.hex, registration: p.f.registration, type: p.f.type, passes: Math.round(p.t - best.start), metres: Math.round(p.d) })) }, null, 1)}\n`,
);
console.log(`${gz.length} bytes, ${writer.points} points, ${writer.aircraft} aircraft; scene ${best.passes.length} passes at ${best.lat.toFixed(4)}, ${best.lon.toFixed(4)}`);
