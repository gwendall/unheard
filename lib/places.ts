// An offline gazetteer: static files in our own bucket, built once from GeoNames by
// scripts/places-build.ts, read here. Nothing about a place goes to anyone else, and the only
// thing the bucket sees is a 1° square (what the flight search already fetches) or the first
// letters of a name. The layout is in docs/places-format.md.

import { gunzip, type Fetcher } from "./history.ts";

/** Where the gazetteer lies under the archive's base. A new build gets a new folder. */
export const PLACES_PREFIX = "places/v1";
export const PLACES_FORMAT = "unheard-places/v1";
export const PLACES_ATTRIBUTION = "GeoNames (geonames.org), CC BY 4.0";

export type Place = {
  name: string;
  /** The state, region or province: "" when GeoNames has none. */
  region: string;
  /** Its country, in the language asked for. */
  country: string;
  countryCode: string;
  lat: number;
  lon: number;
  /** IANA time zone: "America/New_York". */
  zone: string;
};

/** The place nearest a point, and how far from it, in metres. */
export type NearPlace = Place & { distance: number };

/** A place found by name. `matched` is the name that was typed when it is not the usual one (東京, München). */
export type PlaceHit = Place & { matched?: string };

/**
 * One place on the wire: name, region and zone (indices in the file's strings), country code,
 * position in 1e-4 degrees, how much it counts (its population, a section of a town far less than
 * the town), and for a search the other name that matched.
 */
export type Row = [name: string, region: number, country: string, lat: number, lon: number, weight: number, zone: number, other?: string];

/** A square of nearby places: n/<lat>_<lon>.json.gz. */
export type NearFile = { strings: string[]; places: Row[] };

/**
 * All the names under a prefix of letters (s/<prefix>.json.gz), or when there are too many the
 * largest places and the names that end here, with `next` listing the letters that go deeper.
 */
export type SearchFile = { strings: string[]; places: Row[]; next?: string };

export type PlacesIndex = {
  format: string;
  build: string;
  licence: string;
  attribution: string;
  source: { url: string; sha256: string; bytes: number }[];
  /** Base64 of a bit per 1° square that holds places: row 0 is 90° S, column 0 is 180° W. */
  squares: string;
  totals: { places: number; names: number; nearFiles: number; searchFiles: number };
};

/** How much a name counts in a search: another name of a place far less than its usual one. */
export const nameRank = (weight: number, usual: boolean) => (usual ? weight : weight / 100);

export const nearPath = (square: { lat: number; lon: number }) => `n/${square.lat}_${square.lon}.json.gz`;

/** A prefix as a file name: letters and digits as they are, anything else by its code point. */
export function searchPath(prefix: string): string {
  let name = "";
  for (const c of prefix) name += /[a-z0-9]/.test(c) ? c : `_${c.codePointAt(0)!.toString(16)}_`;
  return `s/${name}.json.gz`;
}

const FOLDS: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", đ: "d", ð: "d", þ: "th", ł: "l", ı: "i", ħ: "h", ŋ: "n" };

/**
 * What a name is searched by: lower case, without the accents people leave out, hyphens and the
 * like as one space. Marks stay on the scripts where they change the letter (kana, Hangul,
 * Devanagari); the same function reads the names and what is typed, so both land alike.
 */
export function nameKey(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}])\p{Mn}+/gu, "$1")
    .normalize("NFC")
    .replace(/[ßæœøđðþłıħŋ]/g, (c) => FOLDS[c])
    .replace(/['’ʻʼ`´]/g, "")
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}

/** "Oyster Bay, New York", with the country on request, and no part said twice. */
export function placeLabel(place: Pick<Place, "name" | "region" | "country"> & { matched?: string }, withCountry = false): string {
  const parts = [place.matched ?? place.name, place.region, withCountry ? place.country : ""];
  return parts.filter((part, i) => part && parts.indexOf(part) === i).join(", ");
}

/** Metres between two points on the sphere. */
export function metres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const METRES_PER_DEGREE = 111_195;
/** Squares looked through around the point: beyond three or so, a name would say nothing. */
const MAX_RING = 3;
/**
 * What "nearest" means to a person: a place ten times larger counts as 1.6 times closer, and being
 * within 100 m of a dot on a map is no closer than that. Times Square is in Manhattan (3.3 km),
 * not in Weehawken (3.1 km, across the river).
 */
const pull = (population: number) => Math.max(1, population) ** 0.2;
const nearness = (distance: number, population: number) => (distance + 100) / pull(population);
/** The pull of the largest city: nothing beyond a ring can beat `nearness * MOST_PULL` metres. */
const MOST_PULL = pull(40_000_000);
/** Files kept once read: a session reads a few, this is only a ceiling. */
const KEPT = 128;
const RESULTS = 5;

export type Gazetteer = {
  nearest(lat: number, lon: number, locale?: string): Promise<NearPlace | null>;
  search(query: string, options?: { locale?: string; limit?: number }): Promise<PlaceHit[]>;
};

const countryNames = new Map<string, Intl.DisplayNames | null>();

/** A country's name in a language, from the browser's own tables: no list to download. */
function countryName(code: string, locale: string): string {
  if (!countryNames.has(locale)) {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: "region" });
    } catch {}
    countryNames.set(locale, names);
  }
  try {
    return countryNames.get(locale)?.of(code) ?? code;
  } catch {
    return code;
  }
}

function placeOf(row: Row, strings: string[], locale: string): Place {
  return {
    name: row[0],
    region: strings[row[1]],
    country: countryName(row[2], locale),
    countryCode: row[2],
    lat: row[3] / 1e4,
    lon: row[4] / 1e4,
    zone: strings[row[6]],
  };
}

/** Whether what follows the comma in "Paris, Texas" fits: a region, a country or its code. */
function fitsRest(rest: string, place: Place): boolean {
  if (!rest) return true;
  return [place.region, place.country, place.countryCode].some((part) => nameKey(part).startsWith(rest));
}

/** The gazetteer over its files: anything that reads a path under the prefix. */
export function gazetteer(fetcher: Fetcher): Gazetteer {
  const kept = new Map<string, Promise<unknown>>();

  /** A file as JSON, or null. Read once; a failure is not kept, so the next call tries again. */
  const read = <T>(path: string): Promise<T | null> => {
    const known = kept.get(path) as Promise<T | null> | undefined;
    if (known) return known;
    const loading = (async () => {
      const bytes = await fetcher(path);
      if (!bytes) return null;
      return JSON.parse(new TextDecoder().decode(await gunzip(bytes))) as T;
    })();
    kept.set(path, loading);
    if (kept.size > KEPT) kept.delete(kept.keys().next().value!);
    loading.catch(() => kept.delete(path));
    return loading;
  };

  const squares = async () => {
    const index = await read<PlacesIndex>("index.json.gz");
    if (!index || index.format !== PLACES_FORMAT) return null;
    return Uint8Array.from(atob(index.squares), (c) => c.charCodeAt(0));
  };

  return {
    async nearest(lat, lon, locale = "en") {
      const bits = await squares();
      if (!bits) return null;
      const row0 = Math.min(89, Math.floor(lat));
      const col0 = Math.min(179, Math.floor(lon));
      let best: { row: Row; strings: string[]; distance: number; score: number } | null = null;

      for (let ring = 0; ring <= MAX_RING; ring++) {
        const squaresOfRing: { lat: number; lon: number }[] = [];
        for (let a = row0 - ring; a <= row0 + ring; a++) {
          if (a < -90 || a > 89) continue;
          for (let o = col0 - ring; o <= col0 + ring; o++) {
            if (Math.max(Math.abs(a - row0), Math.abs(o - col0)) !== ring) continue;
            const wrapped = ((o + 180 + 360) % 360) - 180;
            const bit = (a + 90) * 360 + (wrapped + 180);
            if (bits[bit >> 3] & (1 << (bit & 7))) squaresOfRing.push({ lat: a, lon: wrapped });
          }
        }
        const files = await Promise.all(squaresOfRing.map((square) => read<NearFile>(nearPath(square))));
        for (const file of files) {
          if (!file) continue;
          for (const row of file.places) {
            const distance = metres(lat, lon, row[3] / 1e4, row[4] / 1e4);
            const score = nearness(distance, row[5]);
            if (!best || score < best.score) best = { row, strings: file.strings, distance, score };
          }
        }
        // Nothing beyond this ring can beat what is found once its edge is far enough.
        if (best) {
          const south = lat - (row0 - ring);
          const north = row0 + ring + 1 - lat;
          const east = col0 + ring + 1 - lon;
          const west = lon - (col0 - ring);
          const narrow = Math.cos((Math.min(89.9, Math.abs(lat) + ring + 1) * Math.PI) / 180);
          const edge = Math.min(south * METRES_PER_DEGREE, north * METRES_PER_DEGREE, east * METRES_PER_DEGREE * narrow, west * METRES_PER_DEGREE * narrow);
          if (best.score * MOST_PULL <= edge) break;
        }
      }
      return best && { ...placeOf(best.row, best.strings, locale), distance: Math.round(best.distance) };
    },

    async search(query, { locale = "en", limit = RESULTS } = {}) {
      const [head, ...tail] = query.split(",");
      const key = nameKey(head);
      const rest = nameKey(tail.join(" "));
      if (!key) return [];

      // Down the letters, from the first, until a file holds every name under the prefix.
      let file: SearchFile | null = null;
      let prefix = "";
      const letters = [...key];
      for (let i = 0; i < letters.length; i++) {
        prefix += letters[i];
        const here: SearchFile | null = await read<SearchFile>(searchPath(prefix));
        if (!here) break;
        file = here;
        if (!here.next || i === letters.length - 1 || !here.next.includes(letters[i + 1])) break;
      }
      if (!file) return [];

      // The same place by two names counts once, by its best: the usual name, or the exact one.
      const found = new Map<string, { row: Row; usual: boolean; exact: boolean }>();
      for (const row of file.places) {
        const usual = nameKey(row[0]).startsWith(key);
        const other = row[7] !== undefined && nameKey(row[7]).startsWith(key);
        if (!usual && !other) continue;
        const exact = nameKey(usual ? row[0] : row[7]!) === key;
        const id = `${row[0]}|${row[3]}|${row[4]}`;
        const was = found.get(id);
        if (!was || (usual && !was.usual) || (exact && !was.exact)) found.set(id, { row, usual, exact });
      }
      // An exact name first, then the largest: "Paris" before "Parisot", "London" before "London, Ohio".
      const rank = (f: { row: Row; usual: boolean }) => nameRank(f.row[5], f.usual);
      const ranked = [...found.values()].sort((a, b) => Number(b.exact) - Number(a.exact) || rank(b) - rank(a) || (a.row[0] < b.row[0] ? -1 : a.row[0] > b.row[0] ? 1 : 0));
      const hits: PlaceHit[] = [];
      for (const { row, usual } of ranked) {
        const place = placeOf(row, file.strings, locale);
        if (!fitsRest(rest, place)) continue;
        // A code people type (NYC) finds the place, and the place keeps its name.
        hits.push(usual || /^\p{Lu}+$/u.test(row[7]!) ? place : { ...place, matched: row[7] });
        if (hits.length === limit) break;
      }
      return hits;
    },
  };
}
