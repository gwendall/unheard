// The source of the terrain file (scripts/terrain-job.ts), for the evals and the scripts that build
// fixtures. Never from the page: its tiles come from our own file, and Amazon's host sees no visitor.

import type { TileFetcher } from "./terrain";

export const terrainUrl = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

/** Tiles over HTTP. */
export const httpTiles: TileFetcher = async (z, x, y) => {
  const res = await fetch(terrainUrl(z, x, y));
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
};
