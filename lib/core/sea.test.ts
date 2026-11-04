import { describe, expect, it } from "vitest";
import { keepBest, seaOf, SHORE } from "./sea";

const LAT = 40;
const LON = -70;
const area = { lat: LAT, lon: LON, side: 100_000 };
const east = (metres: number) => LON + metres / (111_195 * Math.cos((LAT * Math.PI) / 180));
/** A coast along a meridian: 20 m of land to the west, the sea (0, as lib/terrain.ts reads it) to the east. */
const coast = (_: number, lon: number) => (lon < LON ? 20 : 0);

describe("seaOf", () => {
  const sea = seaOf(coast, area);

  it("calls a spot well off the coast at sea, and land land", () => {
    expect(sea(LAT, east(10_000))).toBe(true);
    expect(sea(LAT, east(-10_000))).toBe(false);
  });

  it("counts a margin around land as land: a pier, a beach, a pixel of terrain", () => {
    expect(sea(LAT, east(SHORE - 200))).toBe(false);
    expect(sea(LAT, east(SHORE + 200))).toBe(true);
  });

  it("says nothing when the terrain says nothing: no ground above 0 in the whole square", () => {
    expect(seaOf(() => 0, area)(LAT, LON)).toBe(false);
  });

  it("never calls land below sea level the sea, where the terrain reads 0 for miles around", () => {
    const places = [
      [36.2306, -116.7675], // Badwater, Death Valley
      [31.8611, 35.4617], // Jericho
      [52.5, 5.55], // Flevoland
      [51.95, 4.56], // Rotterdam
      [32.9787, -115.5303], // Brawley
      [46.35, 48.04], // Astrakhan
      [42.7, 89.3], // Turpan
      [38.08, -121.56], // the Sacramento delta
      [45.44, 12.33], // Venice
    ];
    for (const [lat, lon] of places) {
      // Land far off in the square, 0 around the place: what the terrain reads there.
      const ground = (la: number) => (la > lat + 0.3 ? 100 : 0);
      expect(seaOf(ground, { lat, lon, side: 100_000 })(lat, lon)).toBe(false);
    }
  });
});

describe("keepBest", () => {
  const heard = (x: number) => x;

  it("brings the best by the sound alone back to second", () => {
    const list = [5, 4, 3, 9, 2];
    keepBest(list, heard);
    expect(list).toEqual([5, 9, 4, 3, 2]);
  });

  it("leaves it where it is when it is first or second", () => {
    const first = [9, 5, 4];
    keepBest(first, heard);
    expect(first).toEqual([9, 5, 4]);
    const second = [5, 9, 4];
    keepBest(second, heard);
    expect(second).toEqual([5, 9, 4]);
  });
});
