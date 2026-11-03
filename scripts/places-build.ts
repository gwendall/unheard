// Builds the gazetteer (docs/places-format.md) from GeoNames: the same dump gives the same files,
// byte for byte, on any machine running the same Node. With --upload it puts them in the bucket,
// the index last, from a one-shot Fly Machine that holds the bucket's keys.
//
//   pnpm places:build                  downloads to evals/.cache/geonames, writes under
//                                      evals/.cache/history (what DEV_HISTORY_DIR serves)
//   --src <dir>                        the dump's folder: cities500.zip or cities500.txt (the
//                                      end-to-end test's few places, e2e/places-source), and
//                                      admin1CodesASCII.txt
//   --out <dir>                        where places/v1/ goes
//   --upload                           to the bucket (AWS_* and BUCKET_NAME in the environment)

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { nameKey, nameRank, nearPath, PLACES_ATTRIBUTION, PLACES_FORMAT, PLACES_PREFIX, searchPath, type NearFile, type PlacesIndex, type Row, type SearchFile } from "../lib/places.ts";

const DUMP = "https://download.geonames.org/export/dump";
const ARCHIVE = "cities500";
/** Places that were, not places that are: historical, abandoned, destroyed. */
const GONE = new Set(["PPLH", "PPLQ", "PPLW", "PPLCH"]);
/** A search file holds this many names at most, beyond the ones that end at its prefix. */
export const SEARCH_CAP = 256;
const LONGEST_NAME = 64;

/** A section of a town (Bushwick, Jean-Médecin): found by its name, never the name of a spot. */
const SECTION = "PPLX";
/** How much less a section counts than a town of its size, when typed names are ranked. */
const SECTION_SHARE = 0.01;

type City = { id: number; name: string; others: string[]; lat: number; lon: number; country: string; region: string; population: number; zone: string; section: boolean };

/**
 * Whether one of GeoNames' other names is a name someone would type. Addresses and numbers are
 * not, nor the machine transliterations in small letters ("nyrwby" for Nairobi), nor two letters
 * unless they are a code in capitals (NY).
 */
function isName(name: string): boolean {
  if (!name || name.length > LONGEST_NAME || name.startsWith("http") || /^\d+$/.test(name)) return false;
  if (/^[a-z][a-z' -]*$/.test(name)) return false;
  return !/^[A-Za-z]{1,2}$/.test(name) || /^[A-Z]{2}$/.test(name);
}

/** A row of cities500.txt and admin1CodesASCII.txt as the places of the gazetteer. */
export function readCities(citiesTsv: string, admin1Tsv: string): City[] {
  const regions = new Map<string, string>();
  for (const line of admin1Tsv.split("\n")) {
    const [code, name] = line.split("\t");
    if (code && name) regions.set(code, name);
  }
  const cities: City[] = [];
  for (const line of citiesTsv.split("\n")) {
    const c = line.split("\t");
    if (c.length < 18 || GONE.has(c[7])) continue;
    cities.push({
      id: Number(c[0]),
      name: c[1],
      others: c[3] ? c[3].split(",").filter(isName) : [],
      lat: Number(c[4]),
      lon: Number(c[5]),
      country: c[8],
      region: regions.get(`${c[8]}.${c[10]}`) ?? "",
      population: Number(c[14]) || 0,
      zone: c[17],
      section: c[7] === SECTION,
    });
  }
  // The file's own order changes between dumps; nothing here should.
  return cities.sort((a, b) => a.id - b.id);
}

const weightOf = (c: City) => Math.round(c.section ? c.population * SECTION_SHARE : c.population);
/** Largest first, then by name and id: a total order, so that files come out the same. */
const byRank = (a: City, b: City) => weightOf(b) - weightOf(a) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.id - b.id;

/** The strings of one file, each once. */
function table() {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const of = (s: string) => {
    let i = index.get(s);
    if (i === undefined) {
      i = strings.push(s) - 1;
      index.set(s, i);
    }
    return i;
  };
  return { strings, of };
}

const rowOf = (c: City, of: (s: string) => number, other?: string): Row => {
  const row: Row = [c.name, of(c.region), c.country, Math.round(c.lat * 1e4), Math.round(c.lon * 1e4), weightOf(c), of(c.zone)];
  if (other !== undefined) row.push(other);
  return row;
};

type Name = { key: string; city: City; other?: string };

/** Every name of a place worth a line: the usual one, and those that read differently. */
function namesOf(cities: City[]): Name[] {
  const names: Name[] = [];
  for (const city of cities) {
    const usual = nameKey(city.name);
    if (usual) names.push({ key: usual, city });
    // Of the spellings that read alike, the fullest: München over Munchen, NYC over Nyc.
    const accents = (s: string) => s.length - s.replace(/[^\x00-\x7f]/g, "").length;
    const spellings = [...city.others].sort((a, b) => accents(b) - accents(a) || (a < b ? -1 : a > b ? 1 : 0));
    const seen = new Set([usual]);
    for (const other of spellings) {
      const key = nameKey(other);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      names.push({ key, city, other });
    }
  }
  return names;
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** The tree of search files under a prefix: `depth` letters of each key are the prefix. */
function searchFiles(names: Name[], prefix: string, depth: number, files: Map<string, Uint8Array>, cap: number): void {
  const rank = (n: Name) => nameRank(weightOf(n.city), n.other === undefined);
  const ranked = [...names].sort((a, b) => rank(b) - rank(a) || byRank(a.city, b.city) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const letterAt = new Map<Name, string | undefined>();
  for (const name of ranked) letterAt.set(name, [...name.key][depth]);
  const ending = ranked.filter((n) => letterAt.get(n) === undefined);
  const going = ranked.filter((n) => letterAt.get(n) !== undefined);
  const leaf = ranked.length <= cap;
  const shown = leaf ? ranked : [...ending, ...going.slice(0, Math.max(0, cap - ending.length))];
  const { strings, of } = table();
  const places = shown.map((n) => rowOf(n.city, of, n.other));
  const file: SearchFile = { strings, places };
  if (leaf) {
    files.set(searchPath(prefix), json(file));
    return;
  }
  const deeper = new Map<string, Name[]>();
  for (const name of going) {
    const letter = letterAt.get(name)!;
    const list = deeper.get(letter);
    if (list) list.push(name);
    else deeper.set(letter, [name]);
  }
  file.next = [...deeper.keys()].sort().join("");
  files.set(searchPath(prefix), json(file));
  for (const letter of [...deeper.keys()].sort()) searchFiles(deeper.get(letter)!, prefix + letter, depth + 1, files, cap);
}

/** The gazetteer's files, by path under the prefix, before gzip. */
export function buildPlaces(cities: City[], source: PlacesIndex["source"], { build = "1", cap = SEARCH_CAP }: { build?: string; cap?: number } = {}): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const bits = new Uint8Array((180 * 360) / 8);

  const bySquare = new Map<string, { lat: number; lon: number; cities: City[] }>();
  for (const city of cities) {
    if (city.section) continue;
    const lat = Math.min(89, Math.floor(city.lat));
    const lon = Math.min(179, Math.floor(city.lon));
    const key = `${lat}_${lon}`;
    const square = bySquare.get(key);
    if (square) square.cities.push(city);
    else bySquare.set(key, { lat, lon, cities: [city] });
  }
  for (const square of [...bySquare.values()].sort((a, b) => a.lat - b.lat || a.lon - b.lon)) {
    const bit = (square.lat + 90) * 360 + (square.lon + 180);
    bits[bit >> 3] |= 1 << (bit & 7);
    const { strings, of } = table();
    const places = [...square.cities].sort(byRank).map((c) => rowOf(c, of));
    files.set(nearPath(square), json({ strings, places } satisfies NearFile));
  }
  const nearFiles = files.size;

  const names = namesOf(cities);
  const byFirst = new Map<string, Name[]>();
  for (const name of names) {
    const first = [...name.key][0];
    const list = byFirst.get(first);
    if (list) list.push(name);
    else byFirst.set(first, [name]);
  }
  for (const first of [...byFirst.keys()].sort()) searchFiles(byFirst.get(first)!, first, 1, files, cap);

  const index: PlacesIndex = {
    format: PLACES_FORMAT,
    build,
    licence: "CC BY 4.0",
    attribution: PLACES_ATTRIBUTION,
    source,
    squares: Buffer.from(bits).toString("base64"),
    totals: { places: cities.length, names: names.length, nearFiles, searchFiles: files.size - nearFiles },
  };
  files.set("index.json.gz", json(index));
  return files;
}

/** Gzip with a fixed header, as the flight tiles: same bytes in, same file out, same Node. */
export function gzipFixed(bytes: Uint8Array): Uint8Array {
  const body = deflateRawSync(bytes, { level: 9 });
  const out = new Uint8Array(10 + body.length + 8);
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);
  out.set(body, 10);
  const view = new DataView(out.buffer);
  view.setUint32(10 + body.length, crc32(bytes), true);
  view.setUint32(14 + body.length, bytes.length >>> 0, true);
  return out;
}

/** One file out of a zip, read from its central directory. */
export function unzipEntry(zip: Buffer, name: string): Buffer {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip");
  let p = zip.readUInt32LE(end + 16);
  for (let n = zip.readUInt16LE(end + 10); n > 0; n--) {
    const nameLength = zip.readUInt16LE(p + 28);
    if (zip.toString("utf8", p + 46, p + 46 + nameLength) === name) {
      const at = zip.readUInt32LE(p + 42);
      const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
      const data = zip.subarray(start, start + zip.readUInt32LE(p + 20));
      return zip.readUInt16LE(p + 10) === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nameLength + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  throw new Error(`${name} is not in the zip`);
}

async function fetched(dir: string, name: string): Promise<{ url: string; bytes: Buffer }> {
  const url = `${DUMP}/${name}`;
  const file = join(dir, name);
  if (!existsSync(file)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return { url, bytes: readFileSync(file) };
}

const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const src = flag("src", join(root, "evals/.cache/geonames"));
  const out = flag("out", join(root, "evals/.cache/history"));
  const plain = existsSync(join(src, `${ARCHIVE}.txt`));
  const dump = await fetched(src, `${ARCHIVE}.${plain ? "txt" : "zip"}`);
  const admin1 = await fetched(src, "admin1CodesASCII.txt");
  const tsv = plain ? dump.bytes : unzipEntry(dump.bytes, `${ARCHIVE}.txt`);
  const cities = readCities(tsv.toString("utf8"), admin1.bytes.toString("utf8"));
  const files = buildPlaces(cities, [dump, admin1].map((f) => ({ url: f.url, sha256: sha256(f.bytes), bytes: f.bytes.length })));

  const gz = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) gz.set(path, gzipFixed(bytes));
  const hash = createHash("sha256");
  const paths = [...gz.keys()].sort();
  for (const path of paths) hash.update(path).update(gz.get(path)!);
  const sizes = (part: string) => paths.filter((p) => p.startsWith(part)).map((p) => gz.get(p)!.length);
  const tally = (part: string) => {
    const list = sizes(part);
    return { files: list.length, kb: Math.round(list.reduce((a, b) => a + b, 0) / 1024), largestKb: Math.round(Math.max(...list) / 102.4) / 10 };
  };
  console.log(JSON.stringify({ places: cities.length, near: tally("n/"), search: tally("s/"), indexKb: Math.round(gz.get("index.json.gz")!.length / 102.4) / 10, sha256: hash.digest("hex") }));

  if (process.argv.includes("--upload")) {
    const { s3Store, IMMUTABLE } = await import("./history-job.ts");
    const store = s3Store(process.env);
    const others = paths.filter((p) => p !== "index.json.gz");
    let next = 0;
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        while (next < others.length) {
          const path = others[next++];
          await store.put(`${PLACES_PREFIX}/${path}`, gz.get(path)!, "application/gzip", IMMUTABLE);
        }
      }),
    );
    await store.put(`${PLACES_PREFIX}/index.json.gz`, gz.get("index.json.gz")!, "application/gzip", IMMUTABLE);
    console.log(`uploaded ${paths.length} files under ${PLACES_PREFIX}/`);
    return;
  }
  for (const path of paths) {
    const file = join(out, PLACES_PREFIX, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, gz.get(path)!);
  }
  console.log(`wrote ${paths.length} files under ${join(out, PLACES_PREFIX)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
