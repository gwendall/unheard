import type { Prefill } from "./where";

// What the page needs to know of the example, without its tracks: those stay in the worker's chunk
// (lib/client/where-example.ts). lib/client/where-example.test.ts holds this to them.

export const whereExample: { prefill: Prefill; roughly: { lat: number; lon: number } } = {
  /** What the file would have told about its day and hour, in the search's own terms. */
  prefill: { day: "2026-05-16", time: "18:44", zone: "utc" },
  /** Where the search looks from, some way off the spot. */
  roughly: { lat: 33.57, lon: -111.82 },
};
