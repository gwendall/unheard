// Place names on the page, with no third party: the gazetteer in our own bucket (lib/places.ts),
// next to the flight archive. Loaded on the first call, a few KB at a time, and kept. These calls
// never throw: no answer is null or an empty list, and the page keeps its coordinates.

import { ARCHIVE_URL } from "../archive";
import { httpFetcher } from "../history";
import { gazetteer, PLACES_PREFIX, type Gazetteer, type NearPlace, type PlaceHit } from "../places";

export { placeLabel, PLACES_ATTRIBUTION, type NearPlace, type PlaceHit } from "../places";

let shared: Gazetteer | null = null;

function open(): Gazetteer | null {
  if (!shared && ARCHIVE_URL) shared = gazetteer(httpFetcher(new URL(`${ARCHIVE_URL}/${PLACES_PREFIX}/`, window.location.href).href));
  return shared;
}

/**
 * The town a point lies in or next to: "Oyster Bay", "New York", "United States", 1179 m from its
 * centre. A section of a town is never the answer, and a large place wins over a much smaller one
 * about as close. Null out at sea, or when the files cannot be read. Reads a 1° square around the
 * point, what the flight search reads.
 */
export async function nearestPlace(lat: number, lon: number, options?: { locale?: string }): Promise<NearPlace | null> {
  try {
    return (await open()?.nearest(lat, lon, options?.locale)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Places by the start of a name, accents or not, in any script: "zurich", "Zürich", "東京", "Москва",
 * "Paris, Texas". Exact names first, then the largest. A hit reached by another name than the usual
 * one carries it in `matched`, and `placeLabel` shows it. Reads a few KB per letters typed, and only
 * the first letters reach the bucket.
 */
export async function searchPlaces(query: string, options?: { locale?: string; limit?: number }): Promise<PlaceHit[]> {
  try {
    return (await open()?.search(query, options)) ?? [];
  } catch {
    return [];
  }
}
