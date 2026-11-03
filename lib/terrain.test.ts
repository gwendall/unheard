import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeTerrarium, groundOf } from "./terrain";

/** A 256 x 256 RGB terrarium PNG of heights h(x, y), its rows filtered in turn none, sub, up, average, Paeth. */
function terrarium(h: (x: number, y: number) => number): Uint8Array {
  const W = 256;
  const stride = W * 3;
  const raw = new Uint8Array(W * stride);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const v = h(x, y) + 32768;
      raw.set([Math.floor(v / 256), Math.floor(v) % 256, Math.round((v % 1) * 256)], y * stride + 3 * x);
    }
  const filtered = new Uint8Array(W * (stride + 1));
  for (let y = 0; y < W; y++) {
    const f = y % 5;
    filtered[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const a = x >= 3 ? raw[y * stride + x - 3] : 0;
      const b = y ? raw[(y - 1) * stride + x] : 0;
      const c = x >= 3 && y ? raw[(y - 1) * stride + x - 3] : 0;
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      filtered[y * (stride + 1) + 1 + x] = (raw[y * stride + x] - pred) & 0xff;
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
    out.set(data, 8);
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, W);
  new DataView(ihdr.buffer).setUint32(4, W);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(filtered)), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (png.set(p, at), at + p.length), 0);
  return png;
}

describe("terrain", () => {
  it("decodes a terrarium tile through every PNG row filter", async () => {
    const h = (x: number, y: number) => 3 * x - 2 * y + 0.5;
    const out = await decodeTerrarium(terrarium(h));
    for (const [x, y] of [[0, 0], [17, 1], [255, 2], [100, 3], [3, 4], [200, 255]]) expect(out[y * 256 + x]).toBeCloseTo(h(x, y), 2);
  });

  it("reads the ground between pixels, and 0 below the sea", async () => {
    const flat = terrarium(() => 153.25);
    const ground = await groundOf(async () => flat, 37.7, -121.8, 10_000);
    expect(ground(37.7, -121.8)).toBeCloseTo(153.25, 2);
    const sea = terrarium(() => -12);
    expect((await groundOf(async () => sea, 40.9, -73.5, 10_000))(40.9, -73.5)).toBe(0);
  });
});
