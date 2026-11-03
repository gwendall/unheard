// What the where-and-when eval reads from the cache: the flight history tiles written by
// scripts/history-index.ts (evals/.cache/history/<day>/), and the ground's height from open
// terrain tiles (evals/.cache/terrain/).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadFlights, type Fetcher } from "../../lib/history";
import { groundOf, httpTiles, type TileFetcher } from "../../lib/terrain";

export const HISTORY = new URL("../.cache/history/", import.meta.url);

/** Days indexed in the cache. */
export const indexedDays = () => new Set(existsSync(HISTORY) ? readdirSync(HISTORY).filter((d) => existsSync(new URL(`${d}/manifest.json`, HISTORY))) : []);

/** The history's files under a local folder (or null when absent): the page's fetcher, on disk. */
export const fileFetcher =
  (root: URL = HISTORY): Fetcher =>
  async (path) => {
    const file = new URL(path, root);
    return existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
  };

/** The flights of one day around a square, from the local history. */
export const historyAround = (days: string[], lat: number, lon: number, side: number) => loadFlights(fileFetcher(), days, { lat, lon, side });

const TERRAIN = new URL("../.cache/terrain/", import.meta.url);

/** Terrain tiles fetched once into evals/.cache/terrain/ (or `dir`), then read from there. */
export const cachedTiles =
  (dir: URL = TERRAIN): TileFetcher =>
  async (z, x, y) => {
    const file = new URL(`${z}-${x}-${y}.png`, dir);
    if (!existsSync(file)) {
      const png = await httpTiles(z, x, y);
      if (!png) return null;
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, png);
    }
    return new Uint8Array(readFileSync(file));
  };

/** The ground's height around a square, from the cached terrain tiles. */
export const groundAround = (lat: number, lon: number, side: number) => groundOf(cachedTiles(), lat, lon, side);
