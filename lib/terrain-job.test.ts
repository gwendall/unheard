import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PMTiles, type RangeResponse, type Source } from "pmtiles";
import { directoryBytes, planArchive, storedBetween, type TileIn } from "../scripts/pmtiles-write";
import { partBytes, readListing, TERRAIN_KEY } from "../scripts/terrain-job";
import { TERRAIN_FILE } from "./terrain";

/** Made-up tile contents: a tile's bytes follow from its name. */
const bytesOf = (tile: TileIn) => Uint8Array.from({ length: tile.length }, (_, i) => (i * 7 + tile.content.charCodeAt(0)) & 0xff);
const tileAt = (x: number, y: number, length = 100 + ((x * 31 + y * 17) % 400), content = `c${x}-${y}`): TileIn => ({ z: 10, x, y, length, content });

/** The planned file, whole, as a reader would see it through range requests. */
async function fileOf(tiles: TileIn[], leafEntries?: number) {
  const plan = planArchive(tiles, { name: "test" }, { leafEntries });
  const bytes = await partBytes(plan, 0, plan.size - 1, async (tile) => bytesOf(tile));
  const ranges: number[] = [];
  const source: Source = {
    getKey: () => "test",
    getBytes: async (offset, length): Promise<RangeResponse> => {
      ranges.push(length);
      return { data: bytes.slice(offset, offset + length).buffer as ArrayBuffer };
    },
  };
  return { plan, bytes, ranges, file: new PMTiles(source) };
}

describe("the terrain file", () => {
  it("is named the same by the job and by the page", () => {
    expect(TERRAIN_KEY).toBe(TERRAIN_FILE);
  });

  it("gives every tile back byte for byte, and nothing for a tile it does not have", async () => {
    const tiles = [tileAt(163, 395), tileAt(164, 395), tileAt(163, 396), tileAt(900, 12), tileAt(0, 0), tileAt(1023, 1023)];
    const { file } = await fileOf(tiles);
    for (const tile of tiles) {
      const got = await file.getZxy(10, tile.x, tile.y);
      expect(new Uint8Array(got!.data)).toEqual(bytesOf(tile));
    }
    expect(await file.getZxy(10, 500, 500)).toBeUndefined();
  });

  it("reads like a planet: leaves when the root would not fit in the first read", async () => {
    const tiles: TileIn[] = [];
    // Lengths that do not compress, as real ones: so many entries would not fit in the first read.
    const lengthAt = (x: number, y: number) => 50 + Math.floor(Math.abs(Math.sin(x * 12.9898 + y * 78.233)) * 43_758.5453) % 1009;
    for (let x = 0; x < 120; x++) for (let y = 0; y < 120; y++) tiles.push(tileAt(x, y, lengthAt(x, y)));
    const { file, plan, ranges } = await fileOf(tiles, 256);
    expect(plan.entries).toBe(14_400);
    const header = await file.getHeader();
    expect(header.leafDirectoryLength).toBeGreaterThan(0);
    expect(header.rootDirectoryOffset + header.rootDirectoryLength).toBeLessThanOrEqual(16_384);
    expect(header.numAddressedTiles).toBe(14_400);
    expect(header.clustered).toBe(true);
    expect(header.minZoom).toBe(10);
    expect(header.maxZoom).toBe(10);
    for (const [x, y] of [[0, 0], [119, 119], [60, 7], [7, 60]]) {
      const tile = tileAt(x, y, lengthAt(x, y));
      expect(new Uint8Array((await file.getZxy(10, x, y))!.data)).toEqual(bytesOf(tile));
    }
    expect(await file.getZxy(10, 120, 0)).toBeUndefined();
    // The first read, a leaf or two, then only the tiles.
    expect(ranges[0]).toBe(16_384);
    expect(ranges.length).toBeLessThanOrEqual(1 + 5 + 4);
  });

  it("stores the same content once, and a run of it as one entry", async () => {
    const same = (x: number, y: number) => tileAt(x, y, 300, "sea");
    const tiles = [same(0, 0), same(0, 1), same(1, 1), same(1, 0), tileAt(2, 0), same(500, 500)];
    const { file, plan } = await fileOf(tiles);
    expect(plan.addressed).toBe(6);
    expect(plan.stored).toHaveLength(2);
    expect(plan.entries).toBe(3);
    for (const t of tiles) expect(new Uint8Array((await file.getZxy(10, t.x, t.y))!.data)).toEqual(bytesOf(t));
  });

  it("cuts into parts anywhere: a tile across two parts comes out whole", async () => {
    const tiles = Array.from({ length: 40 }, (_, i) => tileAt(i, i % 3, 1000 + i));
    const plan = planArchive(tiles, { name: "test" });
    const read = async (tile: TileIn) => bytesOf(tile);
    const whole = await partBytes(plan, 0, plan.size - 1, read);
    const cut = 2000;
    const pieces: Uint8Array[] = [];
    for (let start = 0; start < plan.size; start += cut) pieces.push(await partBytes(plan, start, Math.min(plan.size, start + cut) - 1, read));
    expect(Buffer.concat(pieces).equals(Buffer.from(whole))).toBe(true);
  });

  it("finds the tiles between two offsets", () => {
    const plan = planArchive([tileAt(0, 0, 100, "a"), tileAt(0, 1, 100, "b"), tileAt(1, 1, 100, "c")], {});
    const [first, second] = plan.stored.map((s) => s.tile.content);
    expect(storedBetween(plan.stored, 0, 1).map((s) => s.tile.content)).toEqual([first]);
    expect(storedBetween(plan.stored, 99, 101).map((s) => s.tile.content)).toEqual([first, second]);
    expect(storedBetween(plan.stored, 300, 400)).toEqual([]);
  });

  it("keeps an offset past 4 GB whole in a directory", () => {
    const raw = gunzipSync(directoryBytes([{ tileId: 349_525, offset: 80_000_000_000, length: 151_919, runLength: 1 }]));
    let at = 0;
    const varint = () => {
      let value = 0;
      for (let scale = 1; ; scale *= 128) {
        const byte = raw[at++];
        value += (byte & 127) * scale;
        if (byte < 128) return value;
      }
    };
    expect([varint(), varint(), varint(), varint(), varint()]).toEqual([1, 349_525, 1, 151_919, 80_000_000_001]);
  });

  it("reads the source's listing", () => {
    const xml = `<ListBucketResult><NextContinuationToken>abc+/=</NextContinuationToken><Contents><Key>terrarium/10/512/0.png</Key><LastModified>2017</LastModified><ETag>&quot;49d0c12b65f613f5e22ae270663f1e61&quot;</ETag><Size>1234</Size></Contents></ListBucketResult>`;
    expect(readListing(xml)).toEqual({ tiles: [{ z: 10, x: 512, y: 0, length: 1234, content: "49d0c12b65f613f5e22ae270663f1e61" }], next: "abc+/=" });
    expect(() => readListing(`<Contents><Key>terrarium/10/1/2.png</Key><ETag>"abc-2"</ETag><Size>1</Size></Contents>`)).toThrow(/no MD5/);
  });
});
