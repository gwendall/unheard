// The end-to-end test's ground: one flat tile at the height of the scene's spot, addressed for every
// tile around it, in the same kind of file as the real one (scripts/terrain-job.ts). A few KB, and
// no test goes to the network for its ground.
//   node scripts/make-terrain-fixture.ts

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { planArchive, type TileIn } from "./pmtiles-write.ts";
import { TERRAIN_KEY } from "./terrain-job.ts";

const SIZE = 256;
const AROUND = 12;
const OUT = new URL("../e2e/history/", import.meta.url);
const scene = JSON.parse(readFileSync(new URL("scene.json", OUT), "utf8")) as { lat: number; lon: number; elevation: number };

/** A terrarium PNG of one height: height = R * 256 + G + B / 256 - 32768. */
export function flatTile(height: number): Uint8Array {
  const value = Math.round((height + 32768) * 256);
  const [r, g, b] = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  const raw = new Uint8Array((SIZE * 3 + 1) * SIZE);
  for (let i = 0; i < raw.length; i++) {
    const at = i % (SIZE * 3 + 1);
    if (at) raw[i] = [r, g, b][(at - 1) % 3];
  }
  const chunk = (type: string, body: Uint8Array) => {
    const name = Buffer.from(type, "latin1");
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    name.copy(out, 4);
    Buffer.from(body).copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([name, Buffer.from(body)])), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array())]);
}

const png = flatTile(scene.elevation);
const n = 2 ** 10;
const column = Math.floor(((scene.lon + 180) / 360) * n);
const rad = (scene.lat * Math.PI) / 180;
const row = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
const tiles: TileIn[] = [];
for (let x = column - AROUND; x <= column + AROUND; x++) for (let y = row - AROUND; y <= row + AROUND; y++) tiles.push({ z: 10, x, y, length: png.length, content: "flat" });
const plan = planArchive(tiles, { name: "The e2e scene's flat ground" });
const file = new URL(TERRAIN_KEY, OUT);
mkdirSync(new URL(".", file), { recursive: true });
writeFileSync(file, Buffer.concat([plan.head, png]));
console.log(`${plan.addressed} tiles, ${plan.entries} entries, ${plan.size} bytes`);
