// Tiles kept on this device, so a second search does not go back to the network: the flights of a
// past day and the shape of the ground do not change. Cache Storage, in the page's origin; nothing
// about the file goes in it, only what any visitor could fetch. Where it is missing or refused (a
// private window, no room), the same bytes simply come from the network every time.

import { PMTiles } from "pmtiles";
import type { Fetcher } from "../history";
import { TERRAIN_FILE, type TileFetcher } from "../terrain";

const NAME = "unheard-tiles-1";
/** A day of history can be indexed again, rarely: read it again after a week. */
const MAX_AGE = 7 * 86_400_000;
/** The oldest go past this many (a day's tile runs to a few MB, and the browser may evict the rest). */
const MAX_TILES = 300;
const SAVED_AT = "x-saved-at";

/** What is used of a cache, and of the world: a test brings its own. */
export type Keep = {
  open: () => Promise<Pick<Cache, "match" | "put" | "keys" | "delete"> | null>;
  fetch: (url: string) => Promise<Response>;
  /** Milliseconds. */
  now: () => number;
};

const onDevice: Keep = {
  open: async () => {
    try {
      return typeof caches === "undefined" ? null : await caches.open(NAME);
    } catch {
      return null;
    }
  },
  fetch: (url) => fetch(url),
  now: () => Date.now(),
};

/** The bytes at a URL, from this device when it holds them; null when the server has none. */
export async function cachedBytes(url: string, keep: Keep = onDevice): Promise<Uint8Array | null> {
  const store = await keep.open();
  try {
    const hit = await store?.match(url);
    if (hit && keep.now() - Number(hit.headers.get(SAVED_AT) ?? 0) < MAX_AGE) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    // Unreadable: the network has it.
  }
  const res = await keep.fetch(url);
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (store) {
    try {
      await store.put(url, new Response(bytes as BlobPart, { headers: { [SAVED_AT]: String(keep.now()) } }));
      const keys = await store.keys();
      for (const old of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await store.delete(old);
    } catch {
      // No room: it simply will not be there next time.
    }
  }
  return bytes;
}

/** Files under a base URL, kept on this device: `httpFetcher` for the page. */
export const cachedFetcher =
  (base: string): Fetcher =>
  (path) =>
    cachedBytes(new URL(path, base.endsWith("/") ? base : `${base}/`).href);

/** The ground's tiles from our own file, by range requests under the archive's base, kept on this device. */
export function cachedTiles(base: string, keep: Keep = onDevice): TileFetcher {
  const url = new URL(TERRAIN_FILE, base.endsWith("/") ? base : `${base}/`).href;
  const file = new PMTiles(url);
  return (z, x, y) =>
    cachedBytes(`${url}/${z}/${x}/${y}.png`, {
      ...keep,
      fetch: async () => {
        const tile = await file.getZxy(z, x, y);
        return tile ? new Response(tile.data) : new Response(null, { status: 404 });
      },
    });
}
