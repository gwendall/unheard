import { describe, expect, it } from "vitest";
import { decodeTile, fixesOf, gunzip, kindOfDescription, KIND, loadFlights, mergeFlights, readDays, STRIDE, tileOf, tilesAround, TileWriter, type Aircraft, type Manifest } from "./history";

const day = Date.parse("2026-05-16T00:00:00Z") / 1000;

function points(rows: number[][]): Float64Array {
  return Float64Array.from(rows.flat());
}

describe("history tiles", () => {
  it("round-trips runs of points within their quantisation", () => {
    const cessna: Aircraft = { hex: "a1b2c3", kind: KIND.piston, type: "C172", registration: "N12345" };
    const tis: Aircraft = { hex: "~0c0ffe", kind: KIND.unknown, type: "", registration: "" };
    const w = new TileWriter(day, 37, -122);
    const a = points([
      [day + 3600.04, 37.5, -121.75, 1500, 95.3, 359.99, -640, 0],
      [day + 3604.51, 37.5012, -121.7501, 1475, 95.1, 0.5, -704, 0],
      [day + 3609.0, 37.5024, -121.7502, 1450, 94.8, 1.2, -768, 2],
    ]);
    for (let i = 0; i < 3; i++) w.add(cessna, a, i);
    const b = points([[day + 50, 37.01, -121.02, -200, 0, 180, 32000, 1]]);
    w.add(tis, b, 0);
    expect(w.points).toBe(4);
    const tile = decodeTile(w.bytes());
    expect(tile.day).toBe(day);
    expect([tile.lat0, tile.lon0]).toEqual([37, -122]);
    const [f, g] = tile.flights;
    expect([f.hex, f.kind, f.type, f.registration]).toEqual(["a1b2c3", KIND.piston, "C172", "N12345"]);
    expect([g.hex, g.altFt[0], g.vrate[0], g.flags[0]]).toEqual(["~0c0ffe", -200, 32000, 1]);
    for (let i = 0; i < 3; i++) {
      const o = i * STRIDE;
      expect(f.t[i]).toBeCloseTo(a[o], 1);
      expect(Math.abs(f.lat[i] - a[o + 1])).toBeLessThan(1e-5);
      expect(Math.abs(f.lon[i] - a[o + 2])).toBeLessThan(1e-5);
      expect(f.altFt[i]).toBe(a[o + 3]);
      expect(f.gs[i]).toBeCloseTo(a[o + 4], 1);
      expect(f.track[i]).toBeCloseTo(a[o + 5], 2);
      expect(f.vrate[i]).toBe(a[o + 6]);
      expect(f.flags[i]).toBe(a[o + 7]);
    }
    // The same points in another order give the same bytes.
    const again = new TileWriter(day, 37, -122);
    again.add(tis, b, 0);
    for (let i = 0; i < 3; i++) again.add(cessna, a, i);
    expect(again.bytes()).toEqual(w.bytes());
    // Cut in four, the same points.
    const parts = w.quarters();
    expect(parts.map((q) => [q.lat0, q.lon0, q.size, q.points])).toEqual([
      [37, -121.5, 0.5, 1],
      [37.5, -122, 0.5, 3],
    ]);
    expect(Math.abs(decodeTile(parts[1].bytes()).flights[0].lat[2] - 37.5024)).toBeLessThan(1e-5);
    // Only the propellers and rotors, as a lighter store would keep them.
    expect(decodeTile(w.bytes((x) => x.kind === KIND.piston)).flights.map((x) => x.hex)).toEqual(["a1b2c3"]);
  });

  it("merges an aircraft's runs across tiles in time order and gives fixes", () => {
    const c: Aircraft = { hex: "abcdef", kind: KIND.rotor, type: "R44", registration: "N1" };
    const west = new TileWriter(day, 37, -122);
    const east = new TileWriter(day, 37, -121);
    west.add(c, points([[day + 10, 37.5, -121.001, 1000, 100, 90, 0, 0]]), 0);
    east.add(c, points([[day + 5, 37.5, -120.999, 1000, 100, 270, 0, 0]]), 0);
    west.add(c, points([[day + 20, 37.5, -121.01, 1000, 100, 270, 0, 0]]), 0);
    const [m] = mergeFlights([decodeTile(west.bytes()), decodeTile(east.bytes())]);
    expect(Array.from(m.t, (t) => Math.round(t - day))).toEqual([5, 10, 20]);
    const fix = fixesOf(m, day + 9, day + 11)[0];
    expect(fix.altitude).toBeCloseTo(304.8, 1);
    expect(fix.velocity[0]).toBeCloseTo((100 * 1852) / 3600, 3);
  });

  it("names kinds and tiles", () => {
    expect(kindOfDescription("L1P")).toBe(KIND.piston);
    expect(kindOfDescription("L2T")).toBe(KIND.turboprop);
    expect(kindOfDescription("H2T")).toBe(KIND.rotor);
    expect(kindOfDescription("L2J")).toBe(KIND.jet);
    expect(kindOfDescription(undefined, "A7")).toBe(KIND.rotor);
    expect(tileOf(37.7, -121.8)).toBe("37_-122");
    const tile = { runs: 1, points: 1, bytes: 1, sha256: "", content: "" };
    const manifest = { tiles: { "37_-123": { ...tile, lat0: 37, lon0: -123, size: 1 }, "37_-122": { ...tile, lat0: 37, lon0: -122, size: 1 }, "38_-122": { ...tile, lat0: 38, lon0: -122, size: 1 }, "40.5_-75": { ...tile, lat0: 40.5, lon0: -75, size: 0.5 } } } as unknown as Manifest;
    expect(tilesAround(manifest, 37.7, -122.2, 100_000)).toEqual(["37_-122", "37_-123", "38_-122"]);
    expect(tilesAround(manifest, 40.6, -74.9, 1000)).toEqual(["40.5_-75"]);
  });

  it("loads the tiles of a day through any fetcher", async () => {
    const w = new TileWriter(day, 37, -122);
    w.add({ hex: "a1b2c3", kind: KIND.piston, type: "C172", registration: "N1" }, points([[day + 10, 37.5, -121.5, 1000, 100, 90, 0, 0]]), 0);
    const raw = w.bytes();
    const gz = new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    expect(await gunzip(gz)).toEqual(raw);
    const files: Record<string, Uint8Array> = {
      "2026-05-16/manifest.json": new TextEncoder().encode(JSON.stringify({ tiles: { "37_-122": { lat0: 37, lon0: -122, size: 1 } } })),
      "2026-05-16/37_-122.bin.gz": gz,
    };
    const got = await loadFlights(async (path) => files[path] ?? null, ["2026-05-16", "2026-05-17"], { lat: 37.6, lon: -121.6, side: 20_000 });
    expect(got.flights.map((f) => f.hex)).toEqual(["a1b2c3"]);
    expect(got.missing).toEqual(["2026-05-17"]);
  });
});

describe("the days an archive holds", () => {
  const serving = (text: string | null) => async () => (text === null ? null : new TextEncoder().encode(text));

  it("reads a list of days, in order, once each", async () => {
    expect(await readDays(serving('["2026-09-08","2026-05-16","2026-09-08"]'))).toEqual(["2026-05-16", "2026-09-08"]);
    expect(await readDays(serving('{"days":["2026-09-08"]}'))).toEqual(["2026-09-08"]);
    expect(await readDays(serving('{"days":[{"day":"2026-09-08","tiles":3000}]}'))).toEqual(["2026-09-08"]);
    expect(await readDays(serving("[]"))).toEqual([]);
  });

  it("leaves out what is not a day", async () => {
    expect(await readDays(serving('["2026-09-08","soon",7,null]'))).toEqual(["2026-09-08"]);
  });

  it("says nothing when there is no list, or a broken one", async () => {
    expect(await readDays(serving(null))).toBeNull();
    expect(await readDays(serving("<Error>"))).toBeNull();
    expect(await readDays(serving('{"tiles":1}'))).toBeNull();
    expect(
      await readDays(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).toBeNull();
  });
});
