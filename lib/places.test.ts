import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildPlaces, gzipFixed, readCities, unzipEntry } from "../scripts/places-build";
import type { Fetcher } from "./history";
import { gazetteer, nameKey, placeLabel, searchPath } from "./places";

type Line = { id: number; name: string; others?: string; lat: number; lon: number; feature?: string; country: string; admin?: string; population: number; zone?: string };

const tsv = (lines: Line[]) => lines.map((l) => [l.id, l.name, l.name, l.others ?? "", l.lat, l.lon, "P", l.feature ?? "PPL", l.country, "", l.admin ?? "", "", "", "", l.population, "", "", l.zone ?? "Etc/UTC", "2024-01-01"].join("\t")).join("\n");

const ADMIN = "US.NY\tNew York\tNew York\t1\nUS.NJ\tNew Jersey\tNew Jersey\t2\nUS.TX\tTexas\tTexas\t3\nFR.11\tÎle-de-France\tIle-de-France\t4\nDE.02\tBavaria\tBavaria\t5\nJP.40\tTokyo\tTokyo\t6\nFJ.03\tNorthern\tNorthern\t7\nFJ.05\tWestern\tWestern\t8\nRU.48\tMoscow\tMoscow\t9";

const WORLD: Line[] = [
  { id: 1, name: "Oyster Bay", lat: 40.86565, lon: -73.53207, country: "US", admin: "NY", population: 6707, zone: "America/New_York" },
  { id: 2, name: "Oyster Bay Cove", lat: 40.87093, lon: -73.51096, country: "US", admin: "NY", population: 2251 },
  { id: 3, name: "Glen Cove", lat: 40.86232, lon: -73.63374, country: "US", admin: "NY", population: 27400 },
  { id: 4, name: "Manhattan", lat: 40.78343, lon: -73.96625, feature: "PPLA2", country: "US", admin: "NY", population: 1487536 },
  { id: 5, name: "Weehawken", lat: 40.76955, lon: -74.02042, country: "US", admin: "NJ", population: 12554 },
  { id: 6, name: "Times Square", lat: 40.75659, lon: -73.98626, feature: "PPLX", country: "US", admin: "NY", population: 17749 },
  { id: 7, name: "New York City", others: "NYC,Nueva York,Нью-Йорк", lat: 40.71427, lon: -74.00597, country: "US", admin: "NY", population: 8804190 },
  { id: 8, name: "Paris", others: "Parigi,Париж,パリ", lat: 48.85341, lon: 2.3488, feature: "PPLC", country: "FR", admin: "11", population: 2138551, zone: "Europe/Paris" },
  { id: 9, name: "Paris", lat: 33.66094, lon: -95.55551, country: "US", admin: "TX", population: 24782 },
  { id: 10, name: "Parisot", lat: 44.26, lon: 1.86, country: "FR", population: 600 },
  { id: 11, name: "Munich", others: "Munchen,München,muenchen,Muenchen", lat: 48.13743, lon: 11.57549, country: "DE", admin: "02", population: 1260391 },
  { id: 12, name: "Münster", lat: 51.96236, lon: 7.62571, country: "DE", population: 315293 },
  { id: 13, name: "Tokyo", others: "東京,Токио", lat: 35.6895, lon: 139.69171, feature: "PPLC", country: "JP", admin: "40", population: 8336599, zone: "Asia/Tokyo" },
  { id: 14, name: "Moscow", others: "Москва,nyrwby,Mo,http://example.org/moscow,12345", lat: 55.75222, lon: 37.61556, feature: "PPLC", country: "RU", admin: "48", population: 10381222 },
  { id: 15, name: "Saint-Étienne", lat: 45.43389, lon: 4.39, country: "FR", population: 172565 },
  { id: 16, name: "L'Aquila", lat: 42.35, lon: 13.4, country: "IT", population: 68503 },
  { id: 17, name: "Labasa", lat: -16.4167, lon: 179.3833, country: "FJ", admin: "03", population: 27949 },
  { id: 18, name: "Taveuni", lat: -16.85, lon: -179.98, country: "FJ", admin: "03", population: 3000 },
  { id: 20, name: "Nuremberg", lat: 49.45421, lon: 11.07752, country: "DE", admin: "02", population: 515543 },
  { id: 19, name: "Old Town", lat: 40.87, lon: -73.53, feature: "PPLH", country: "US", admin: "NY", population: 999999 },
];

const files = (lines = WORLD, cap?: number) => buildPlaces(readCities(tsv(lines), ADMIN), [{ url: "test", sha256: "0", bytes: 0 }], { cap });
const fetcherOf =
  (built: Map<string, Uint8Array>, reads: string[] = []): Fetcher =>
  async (path) => {
    reads.push(path);
    return built.get(path) ?? null;
  };
const world = (reads?: string[], cap?: number) => gazetteer(fetcherOf(files(WORLD, cap), reads));

describe("nameKey", () => {
  it("reads a name the way it is typed", () => {
    expect(nameKey("Zürich")).toBe("zurich");
    expect(nameKey("São Paulo")).toBe("sao paulo");
    expect(nameKey("Saint-Étienne")).toBe("saint etienne");
    expect(nameKey("L'Aquila")).toBe("laquila");
    expect(nameKey("Łódź")).toBe("lodz");
    expect(nameKey("Straße")).toBe("strasse");
    expect(nameKey("  İzmir ")).toBe("izmir");
    expect(nameKey("Москва")).toBe("москва");
  });

  it("keeps the marks that change a letter", () => {
    expect(nameKey("がくえん")).toBe("がくえん");
    expect(nameKey("서울")).toBe("서울");
    expect(nameKey("東京")).toBe("東京");
  });
});

describe("nearest", () => {
  it("names the town a point lies next to, and how far its centre is", async () => {
    const place = await world().nearest(40.8551, -73.5321);
    expect(place).toMatchObject({ name: "Oyster Bay", region: "New York", country: "United States", countryCode: "US", zone: "America/New_York" });
    expect(place!.distance).toBeGreaterThan(1100);
    expect(place!.distance).toBeLessThan(1250);
    expect(placeLabel(place!)).toBe("Oyster Bay, New York");
    expect(placeLabel(place!, true)).toBe("Oyster Bay, New York, United States");
  });

  it("prefers the town to its section, and a large town to a small one about as close", async () => {
    // Times Square itself is a section; Weehawken is a shade nearer than Manhattan's centre.
    expect((await world().nearest(40.758, -73.9855))?.name).toBe("Manhattan");
  });

  it("calls a town's numbered district by the town's name", async () => {
    // GeoNames files them as towns. Issy is closer to the 15th's edge than the centre of Paris is.
    const districts: Line[] = [
      ...WORLD,
      { id: 21, name: "Paris 01 Louvre", lat: 48.8592, lon: 2.3417, country: "FR", admin: "11", population: 15114 },
      { id: 22, name: "Paris 15 Vaugirard", lat: 48.8417, lon: 2.3, country: "FR", admin: "11", population: 229713 },
      { id: 23, name: "Issy-les-Moulineaux", lat: 48.82104, lon: 2.27718, country: "FR", admin: "11", population: 68000 },
    ];
    const near = gazetteer(fetcherOf(files(districts)));
    const louvre = await near.nearest(48.8606, 2.3376);
    expect(louvre).toMatchObject({ name: "Paris", region: "Île-de-France" });
    expect(louvre!.distance).toBeLessThan(400);
    expect((await near.nearest(48.832, 2.289))?.name).toBe("Paris");
    // Its own name still finds it, behind the town.
    expect((await near.search("paris"))[0]).toMatchObject({ name: "Paris", countryCode: "FR" });
    expect((await near.search("paris 01")).map((h) => h.name)).toEqual(["Paris 01 Louvre"]);
  });

  it("leaves a number in a name alone when no larger town has the rest of it", async () => {
    const lines: Line[] = [
      { id: 1, name: "Colonia 5", lat: 19.1, lon: -99.1, country: "MX", population: 2000 },
      { id: 2, name: "Sector 9 Norte", lat: 19.1, lon: -99.2, country: "MX", population: 900 },
      { id: 3, name: "Sector", lat: 19.3, lon: -99.2, country: "ES", population: 90000 },
    ];
    const near = gazetteer(fetcherOf(files(lines)));
    expect((await near.nearest(19.1, -99.1))?.name).toBe("Colonia 5");
    expect((await near.nearest(19.1, -99.2))?.name).toBe("Sector 9 Norte");
  });

  it("never names a place that is gone", async () => {
    expect((await world().nearest(40.8701, -73.5301))?.name).not.toBe("Old Town");
  });

  it("finds a place across the edge of a square", async () => {
    const built = files([{ id: 1, name: "North", lat: 41.001, lon: -73.5, country: "US", population: 1000 }, { id: 2, name: "South", lat: 40.5, lon: -73.5, country: "US", population: 1000 }]);
    const reads: string[] = [];
    const place = await gazetteer(fetcherOf(built, reads)).nearest(40.999, -73.5);
    expect(place?.name).toBe("North");
    expect(reads).toContain("n/41_-74.json.gz");
  });

  it("finds a place across the date line", async () => {
    expect((await world().nearest(-16.85, 179.99))?.name).toBe("Taveuni");
  });

  it("reads one square when that is enough, and only squares that hold places", async () => {
    const reads: string[] = [];
    await world(reads).nearest(48.5, 2.5);
    expect(reads.every((r) => r === "index.json.gz" || r.startsWith("n/"))).toBe(true);
    const missing = files();
    for (const r of reads) if (r !== "index.json.gz") expect(missing.has(r)).toBe(true);
  });

  it("has no name out at sea", async () => {
    expect(await world().nearest(30, -40)).toBeNull();
  });

  it("gives the country in the language asked", async () => {
    expect((await world().nearest(48.86, 2.35, "fr"))?.country).toBe("France");
    expect((await world().nearest(40.8551, -73.5321, "fr"))?.country).toBe("États-Unis");
  });

  it("stays under 50 ms a call once loaded, on the densest square there is", async () => {
    const dense: Line[] = Array.from({ length: 3000 }, (_, i) => ({ id: i + 1, name: `Place ${i}`, lat: 45 + (i % 60) / 60, lon: 9 + Math.floor(i / 60) / 60, country: "IT", population: 500 + i }));
    const g = gazetteer(fetcherOf(files(dense)));
    await g.nearest(45.5, 9.5);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) await g.nearest(45.5 + i / 100, 9.5);
    expect((performance.now() - t0) / 20).toBeLessThan(50);
  });
});

describe("search", () => {
  const names = (hits: { name: string }[]) => hits.map((h) => h.name);

  it("finds a place with or without its accents", async () => {
    const g = world();
    expect(names(await g.search("saint etienne"))).toEqual(["Saint-Étienne"]);
    expect(names(await g.search("Saint-Étienne"))).toEqual(["Saint-Étienne"]);
    expect(names(await g.search("laquila"))).toEqual(["L'Aquila"]);
    expect(names(await g.search("l'aq"))).toEqual(["L'Aquila"]);
  });

  it("finds a place by its native name, and says the name that was typed", async () => {
    const g = world();
    expect(await g.search("東京")).toEqual([expect.objectContaining({ name: "Tokyo", matched: "東京", lat: 35.6895, lon: 139.6917 })]);
    const [moscow] = await g.search("москв");
    expect(moscow).toMatchObject({ name: "Moscow", matched: "Москва" });
    expect(placeLabel(moscow)).toBe("Москва, Moscow");
    const [munich] = await g.search("münchen");
    expect(munich).toMatchObject({ name: "Munich", matched: "München" });
    expect((await g.search("munchen"))[0].matched).toBe("München");
  });

  it("keeps its usual name for a code", async () => {
    const [nyc] = await world().search("nyc");
    expect(nyc.name).toBe("New York City");
    expect(nyc.matched).toBeUndefined();
  });

  it("leaves out what is not a name", async () => {
    const g = world();
    for (const junk of ["nyrwby", "http", "12345"]) expect(names(await g.search(junk))).not.toContain("Moscow");
  });

  it("puts an exact name first, then the largest", async () => {
    const g = world();
    expect(names(await g.search("paris"))).toEqual(["Paris", "Paris", "Parisot"]);
    expect((await g.search("paris"))[0].countryCode).toBe("FR");
    expect(names(await g.search("oyster bay"))).toEqual(["Oyster Bay", "Oyster Bay Cove"]);
  });

  it("prefers a usual name to another name of a much larger place until it is typed in full", async () => {
    const g = world();
    expect(names(await g.search("nu"))).toEqual(["Nuremberg", "New York City"]);
    expect(await g.search("nueva york")).toEqual([expect.objectContaining({ name: "New York City", matched: "Nueva York" })]);
  });

  it("reads what follows a comma", async () => {
    const g = world();
    expect((await g.search("Paris, Texas")).map((h) => h.region)).toEqual(["Texas"]);
    expect((await g.search("Paris, fr")).map((h) => h.countryCode)).toEqual(["FR", "FR"]);
    expect(names(await g.search("Oyster Bay, New York"))).toEqual(["Oyster Bay", "Oyster Bay Cove"]);
  });

  it("finds a section of a town by its name", async () => {
    expect(names(await world().search("times sq"))).toEqual(["Times Square"]);
  });

  it("counts a place once under two names", async () => {
    expect(names(await world().search("mu"))).toEqual(["Munich", "Münster"]);
  });

  it("walks down the letters when a prefix holds too many names", async () => {
    const many: Line[] = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: `Pa${String.fromCharCode(97 + (i % 3))}${String.fromCharCode(97 + i % 26)} ${i}`, lat: 10, lon: i, country: "US", population: 1000 + i }));
    many.push({ id: 100, name: "Pa", lat: 10, lon: 1, country: "US", population: 1 });
    const built = files(many, 10);
    expect(built.has(searchPath("p"))).toBe(true);
    expect(built.has(searchPath("pa"))).toBe(true);
    expect(built.has(searchPath("paa"))).toBe(true);

    const reads: string[] = [];
    const g = gazetteer(fetcherOf(built, reads));
    const top = await g.search("p", { limit: 3 });
    expect(top.map((h) => h.name)).toEqual(["Paan 39", "Pacm 38", "Pabl 37"]);
    expect(names(await g.search("pa", { limit: 1 }))).toEqual(["Pa"]);
    reads.length = 0;
    // Every name under the prefix is reachable, not only the largest.
    expect(names(await g.search("paaa", { limit: 40 }))).toEqual(["Paaa 0"]);
    expect(reads).toEqual(["s/paa.json.gz", "s/paaa.json.gz"]);
  });

  it("gives nothing, and asks nothing, for an empty name", async () => {
    const reads: string[] = [];
    expect(await world(reads).search("  ,  ")).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("has a file name for any prefix", () => {
    expect(searchPath("pa")).toBe("s/pa.json.gz");
    expect(searchPath("new y")).toBe("s/new_20_y.json.gz");
    expect(searchPath("東")).toBe("s/_6771_.json.gz");
  });
});

describe("the files", () => {
  it("come out the same whatever the order of the dump", () => {
    const shuffled = [...WORLD].reverse();
    const a = files(WORLD);
    const b = files(shuffled);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [path, bytes] of a) expect(Buffer.from(b.get(path)!).equals(Buffer.from(bytes))).toBe(true);
    for (const [path, bytes] of a) expect(Buffer.from(gzipFixed(bytes)).equals(Buffer.from(gzipFixed(b.get(path)!)))).toBe(true);
  });

  it("read back through gzip", async () => {
    const gz = new Map([...files()].map(([path, bytes]) => [path, gzipFixed(bytes)]));
    expect((await gazetteer(fetcherOf(gz)).nearest(40.8551, -73.5321))?.name).toBe("Oyster Bay");
  });

  it("carry their licence", () => {
    const index = JSON.parse(new TextDecoder().decode(files().get("index.json.gz")));
    expect(index).toMatchObject({ format: "unheard-places/v1", licence: "CC BY 4.0", totals: { places: 19 } });
    expect(index.attribution).toContain("GeoNames");
  });

  it("try again after a failed read", async () => {
    const built = files();
    let fail = true;
    const g = gazetteer(async (path) => {
      if (fail && path.startsWith("n/")) {
        fail = false;
        throw new Error("network");
      }
      return built.get(path) ?? null;
    });
    await expect(g.nearest(40.8551, -73.5321)).rejects.toThrow("network");
    expect((await g.nearest(40.8551, -73.5321))?.name).toBe("Oyster Bay");
  });
});

describe("unzipEntry", () => {
  it("reads a file out of a zip", () => {
    const body = Buffer.from("hello\tworld\n");
    const packed = deflateRawSync(body);
    const name = Buffer.from("cities500.txt");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    const offset = local.length + name.length + packed.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(offset, 16);
    const zip = Buffer.concat([local, name, packed, central, name, end]);
    expect(unzipEntry(zip, "cities500.txt").toString()).toBe("hello\tworld\n");
    expect(() => unzipEntry(zip, "other.txt")).toThrow("not in the zip");
  });
});
