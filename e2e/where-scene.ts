import type { Page } from "@playwright/test";
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

/** The search's form filled in for the scene. */
/** The file named in a QuickTime box holding a date and a position, as a phone writes them. */
export function phoneVideo(start = scene.start): Buffer {
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const box = (type: string, ...parts: (number[] | Buffer)[]) => {
    const body = Buffer.concat(parts.map((p) => Buffer.from(p)));
    return Buffer.concat([Buffer.from(u32(8 + body.length)), Buffer.from(type, "latin1"), body]);
  };
  const at = Math.round(start) + 2_082_844_800;
  const place = Buffer.from("+33.4727-111.7187/", "latin1");
  return Buffer.concat([
    box("ftyp", Buffer.from("qt  ", "latin1"), u32(512), Buffer.from("qt  ", "latin1")),
    box("moov", box("mvhd", [0, 0, 0, 0], u32(at), u32(at), u32(600), u32(0), new Array<number>(80).fill(0)), box("udta", box("\xa9xyz", [(place.length >> 8) & 0xff, place.length & 0xff, 0x15, 0xc7], place))),
  ]);
}

export async function fillIn(page: Page) {
  await page.getByTestId("where-day").selectOption(scene.day);
  await page.getByTestId("where-time").fill(new Date(scene.start * 1000).toISOString().slice(11, 16));
  await page.getByTestId("where-zone").selectOption("utc");
  // Not the spot itself: a place some way off, the way a person knows roughly where.
  await page.getByTestId("where-place").fill(`${(scene.lat + 0.12).toFixed(2)}, ${(scene.lon - 0.09).toFixed(2)}`);
}

/**
 * How much of the left of a card's picture is not its bare background: a map fills it, the diagram
 * is thin lines, and a blank copy of a WebGL canvas leaves nothing.
 */
export async function cardFilled(page: Page, png: string) {
  const blank = await page.context().newPage();
  try {
    return await blank.evaluate(async (bytes) => {
      const image = new Image();
      image.src = `data:image/png;base64,${bytes}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 400;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 100, 560, 400, 400, 0, 0, 400, 400);
      const { data } = ctx.getImageData(0, 0, 400, 400);
      let on = 0;
      for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - 0x0a) + Math.abs(data[i + 1] - 0x0f) + Math.abs(data[i + 2] - 0x1c) > 12) on++;
      return on / (data.length / 4);
    }, readFileSync(png).toString("base64"));
  } finally {
    await blank.close();
  }
}
