// Writes lib/client/where-example.json: the real tracks (adsb.lol, ODbL 1.0) the simulated example of
// /example is made from, cut from the committed flight history of the end-to-end tests. Only the sound
// is made up, in the browser, from these tracks at the spot below: the middle of Longbow Golf Club in
// Mesa (OpenStreetMap: 170 m from its edge), so that the pin the example ends on is nobody's home. Never
// a real recording's position. Whether a spot gets a name is not plain from its distances: check a new
// one with `pnpm where` on the real archive, and on each browser, as this one was (see docs/STATUS.md).
//
//   pnpm exec tsx scripts/make-where-example.ts

import { readFileSync, writeFileSync } from "node:fs";
import { decodeTile, fixesOf, gunzip, mergeFlights } from "../lib/history.ts";

const scene = JSON.parse(readFileSync(new URL("../e2e/history/scene.json", import.meta.url), "utf8")) as { day: string; start: number; duration: number; aircraft: { hex: string }[] };
const SPOT = { lat: 33.4699, lon: -111.7085, elevation: 425 };
/** Where the search looks from: a place some way off, the way a person knows roughly where. */
const ROUGHLY = { lat: 33.57, lon: -111.82 };
/** The sound starts here, and the tracks run this long either side of it, as a phone's clock may be off. */
const MARGIN = 120;
const round = (x: number, digits: number) => Number(x.toFixed(digits));

const dir = new URL(`../e2e/history/${scene.day}/`, import.meta.url);
const names = Object.keys((JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8")) as { tiles: object }).tiles);
const tiles = await Promise.all(names.map(async (name) => decodeTile(await gunzip(new Uint8Array(readFileSync(new URL(`${name}.bin.gz`, dir)))))));
const flights = mergeFlights(tiles);
const tracks = scene.aircraft.map(({ hex }) => {
  const flight = flights.find((f) => f.hex === hex);
  if (!flight) throw new Error(`${hex} is not in the history`);
  return fixesOf(flight, scene.start - MARGIN, scene.start + scene.duration + MARGIN).map((f) => ({
    t: f.t,
    lat: round(f.lat, 5),
    lon: round(f.lon, 5),
    altitude: round(f.altitude, 1),
    velocity: f.velocity.map((v) => round(v, 1)),
  }));
});
const out = { day: scene.day, start: scene.start, duration: scene.duration, spot: SPOT, roughly: ROUGHLY, tracks };
writeFileSync(new URL("../lib/client/where-example.json", import.meta.url), `${JSON.stringify(out)}\n`);
console.log(`${tracks.map((t) => t.length).join(" + ")} fixes`);
