// A PMTiles v3 file planned from what is known of its tiles before reading one: their sizes and a
// name for their content. So the header and the directories come first and the file can be written
// straight through, with no disk, whatever its size (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
// Tiles with the same content are stored once. Used by scripts/terrain-job.ts and the e2e fixture.

import { gzipSync } from "node:zlib";
import { zxyToTileId } from "pmtiles";

export type TileIn = { z: number; x: number; y: number; length: number; content: string };
export type Entry = { tileId: number; offset: number; length: number; runLength: number };
/** A tile stored in the file: `offset` counts from the start of the tile data. */
export type Stored = { tile: TileIn; offset: number };
export type Plan = { head: Uint8Array; stored: Stored[]; tileData: number; size: number; entries: number; addressed: number };

const HEADER = 127;
/** The header and the root directory are read in one request of this size. */
const FIRST_READ = 16_384;
const TILE_NONE = 1;
const GZIP = 2;
const PNG = 2;

/** One directory, as the spec lays it out: columns of varints, gzipped. */
export function directoryBytes(entries: Entry[]): Uint8Array {
  const out: number[] = [];
  const varint = (value: number) => {
    let n = value;
    while (n >= 128) {
      out.push((n % 128) | 128);
      n = Math.floor(n / 128);
    }
    out.push(n);
  };
  varint(entries.length);
  let last = 0;
  for (const e of entries) {
    varint(e.tileId - last);
    last = e.tileId;
  }
  for (const e of entries) varint(e.runLength);
  for (const e of entries) varint(e.length);
  entries.forEach((e, i) => varint(i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length ? 0 : e.offset + 1));
  return gzipSync(Uint8Array.from(out), { level: 9 });
}

/** The root directory and the leaves it points to: all in the root when they fit in the first read. */
function directoriesOf(entries: Entry[], leafEntries: number): { root: Uint8Array; leaves: Uint8Array } {
  const whole = directoryBytes(entries);
  if (HEADER + whole.length <= FIRST_READ) return { root: whole, leaves: new Uint8Array() };
  for (let size = leafEntries; ; size *= 2) {
    const pointers: Entry[] = [];
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += size) {
      const leaf = directoryBytes(entries.slice(i, i + size));
      pointers.push({ tileId: entries[i].tileId, offset, length: leaf.length, runLength: 0 });
      parts.push(leaf);
      offset += leaf.length;
    }
    const root = directoryBytes(pointers);
    if (HEADER + root.length <= FIRST_READ) return { root, leaves: Buffer.concat(parts) };
  }
}

const E7 = 10_000_000;

export function planArchive(tiles: TileIn[], metadata: object, { leafEntries = 1024 }: { leafEntries?: number } = {}): Plan {
  const sorted = tiles.map((tile) => ({ tile, id: zxyToTileId(tile.z, tile.x, tile.y) })).sort((a, b) => a.id - b.id);
  const where = new Map<string, number>();
  const stored: Stored[] = [];
  const entries: Entry[] = [];
  let tileData = 0;
  for (const { tile, id } of sorted) {
    let offset = where.get(tile.content);
    if (offset === undefined) {
      offset = tileData;
      where.set(tile.content, offset);
      stored.push({ tile, offset });
      tileData += tile.length;
    }
    const last = entries.at(-1);
    if (last && last.offset === offset && last.tileId + last.runLength === id) last.runLength++;
    else entries.push({ tileId: id, offset, length: tile.length, runLength: 1 });
  }

  const { root, leaves } = directoriesOf(entries, leafEntries);
  const meta = gzipSync(Buffer.from(JSON.stringify(metadata)), { level: 9 });
  const metaAt = HEADER + root.length;
  const leavesAt = metaAt + meta.length;
  const dataAt = leavesAt + leaves.length;
  const head = new Uint8Array(dataAt);
  const view = new DataView(head.buffer);
  head.set(Buffer.from("PMTiles"), 0);
  head[7] = 3;
  const sizes = [HEADER, root.length, metaAt, meta.length, leavesAt, leaves.length, dataAt, tileData, tiles.length, entries.length, stored.length];
  sizes.forEach((n, i) => view.setBigUint64(8 + i * 8, BigInt(n), true));
  head[96] = 1; // clustered: the tile data is in the order of the tile ids
  head[97] = GZIP;
  head[98] = TILE_NONE;
  head[99] = PNG;
  const zooms = sorted.map((t) => t.tile.z);
  const minZoom = zooms.length ? Math.min(...new Set(zooms)) : 0;
  head[100] = minZoom;
  head[101] = zooms.length ? Math.max(...new Set(zooms)) : 0;
  view.setInt32(102, -180 * E7, true);
  view.setInt32(106, Math.round(-85.0511 * E7), true);
  view.setInt32(110, 180 * E7, true);
  view.setInt32(114, Math.round(85.0511 * E7), true);
  head[118] = minZoom;
  head.set(root, HEADER);
  head.set(meta, metaAt);
  head.set(leaves, leavesAt);
  return { head, stored, tileData, size: dataAt + tileData, entries: entries.length, addressed: tiles.length };
}

/** The tiles of a plan that overlap bytes [from, to) of the tile data, from a sorted list. */
export function storedBetween(stored: Stored[], from: number, to: number): Stored[] {
  let low = 0;
  let high = stored.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (stored[middle].offset + stored[middle].tile.length <= from) low = middle + 1;
    else high = middle;
  }
  const out: Stored[] = [];
  for (let i = low; i < stored.length && stored[i].offset < to; i++) out.push(stored[i]);
  return out;
}
