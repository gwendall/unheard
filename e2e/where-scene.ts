import { readFileSync } from "node:fs";
import { encodeWav } from "../lib/bundle";
import { STANDARD_AIR } from "../lib/core/doppler";
import { synthesize, type Source } from "../lib/core/synth";
import { buildTrack } from "../lib/core/track";
import { decodeTile, fixesOf, gunzip, mergeFlights } from "../lib/history";

// The where page's test scene (scripts/make-where-fixture.ts): a recording made up from the real
// tracks of the committed history tile, at a spot of the ground the script picked. No real sound.

export type Scene = { day: string; hour: number; duration: number; lat: number; lon: number; elevation: number; start: number; aircraft: { hex: string; registration: string; type: string; passes: number; metres: number }[] };

export const scene = JSON.parse(readFileSync(new URL("./history/scene.json", import.meta.url), "utf8")) as Scene;

const RATE = 16_000;
/** Each aircraft its own tone, so no two curves cross. */
const TONES = [92, 118, 147, 171, 203];

/** The scene as a WAV, or only its first seconds (fewer planes, so a weaker answer). */
export async function sceneWav(seconds = scene.duration): Promise<Uint8Array> {
  const dir = new URL(`./history/${scene.day}/`, import.meta.url);
  const names = Object.keys((JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8")) as { tiles: object }).tiles);
  const tiles = await Promise.all(names.map(async (name) => decodeTile(await gunzip(new Uint8Array(readFileSync(new URL(`${name}.bin.gz`, dir)))))));
  const flights = mergeFlights(tiles);
  const listener = { lat: scene.lat, lon: scene.lon, elevation: scene.elevation };
  const sources: Source[] = [];
  scene.aircraft.forEach((a, i) => {
    const flight = flights.find((f) => f.hex === a.hex);
    const track = flight && buildTrack(fixesOf(flight, scene.start - 120, scene.start + scene.duration + 120), listener);
    if (!track) throw new Error(`${a.hex} has no track in the fixture`);
    sources.push({ track, f0: TONES[i % TONES.length], level: 0.2 });
  });
  const samples = synthesize({ start: scene.start, duration: seconds, sampleRate: RATE, air: STANDARD_AIR, sources, noise: 0.5, rumble: 0.5, seed: 11 });
  return encodeWav(samples, RATE);
}
