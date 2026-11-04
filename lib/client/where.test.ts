import { describe, expect, it } from "vitest";
import { clockOf, coordinates, daysOf, distinctAnswers, metresApart, offsetAt, osmLink, parseCoordinates, passesOf, prefillOf, windowOf, partsOf } from "./where";

const at = (iso: string) => Date.parse(iso) / 1000;

describe("the answers shown", () => {
  const best = { lat: 40, lon: -73, start: 1000, mirror: { lat: 40.01, lon: -73 } };
  const plain = (lat: number, lon: number, start: number) => ({ lat, lon, start, mirror: null });

  it("measures how far apart two spots are", () => {
    expect(metresApart({ lat: 40, lon: -73 }, { lat: 40.01, lon: -73 })).toBeCloseTo(1112, 0);
    expect(metresApart({ lat: 40, lon: -73 }, { lat: 40, lon: -72.99 })).toBeCloseTo(852, 0);
  });
  it("leaves out the best answer's mirror, which it already names", () => {
    const twin = plain(40.0101, -73, 1005);
    const next = plain(40.3, -73, 1000);
    expect(distinctAnswers([best, twin, next], 3)).toEqual([best, next]);
  });
  it("keeps the mirror's spot at another start, and every answer when there is no mirror", () => {
    const later = plain(40.01, -73, 1100);
    expect(distinctAnswers([best, later], 3)).toEqual([best, later]);
    const lone = plain(40, -73, 1000);
    const near = plain(40.0001, -73, 1000);
    expect(distinctAnswers([lone, near], 3)).toEqual([lone, near]);
  });
  it("shows no more than asked, and nothing from nothing", () => {
    expect(distinctAnswers([best, plain(41, -73, 0), plain(42, -73, 0)], 2)).toHaveLength(2);
    expect(distinctAnswers([], 3)).toEqual([]);
  });
});

describe("what a file's date fills in", () => {
  it("shows an absolute date in UTC", () => {
    expect(prefillOf({ createdAt: { utc: at("2026-05-16T18:03:44Z"), source: "mvhd", precision: "second" } })).toEqual({ day: "2026-05-16", time: "18:03", zone: "utc", from: "utc", source: "mvhd" });
    expect(prefillOf({ createdAt: { utc: at("2026-05-16T23:30:00Z"), offsetMinutes: 120, source: "©day", precision: "minute" } }).from).toBe("zoned");
  });
  it("shows a clock with no zone as it reads, as local time", () => {
    expect(prefillOf({ createdAt: { utc: at("2026-05-16T18:03:00Z"), source: "ICRD", precision: "minute" } })).toEqual({ day: "2026-05-16", time: "18:03", zone: "local", from: "clock", source: "ICRD" });
  });
  it("gives no hour from a date alone, and nothing from a year or a month", () => {
    expect(prefillOf({ createdAt: { utc: at("2026-05-16T00:00:00Z"), source: "TDRC", precision: "day" } })).toEqual({ day: "2026-05-16", zone: "local", from: "day", source: "TDRC" });
    expect(prefillOf({ createdAt: { utc: at("2026-01-01T00:00:00Z"), source: "TYER", precision: "year" } })).toEqual({ zone: "local" });
    expect(prefillOf({})).toEqual({ zone: "local" });
  });
});

describe("typed coordinates", () => {
  it("reads the ways people type them", () => {
    expect(parseCoordinates("48.85, 2.35")).toEqual({ lat: 48.85, lon: 2.35 });
    expect(parseCoordinates(" 48.85 -2.35 ")).toEqual({ lat: 48.85, lon: -2.35 });
    expect(parseCoordinates("48,85 2,35")).toEqual({ lat: 48.85, lon: 2.35 });
  });
  it("refuses names and what is off the globe", () => {
    expect(parseCoordinates("Nice")).toBeNull();
    expect(parseCoordinates("91, 2")).toBeNull();
    expect(parseCoordinates("48, 181")).toBeNull();
  });
  it("writes them back", () => {
    expect(coordinates({ lat: 48.85661, lon: 2.35222 })).toBe("48.8566, 2.3522");
    expect(osmLink({ lat: 48.85661, lon: 2.35222 })).toBe("https://www.openstreetmap.org/?mlat=48.85661&mlon=2.35222#map=14/48.85661/2.35222");
  });
});

describe("time at a place", () => {
  it("reads the zone, summer time included", () => {
    expect(offsetAt({ lon: 2, zone: "Europe/Paris" }, at("2026-07-01T12:00:00Z"))).toBe(120);
    expect(offsetAt({ lon: 2, zone: "Europe/Paris" }, at("2026-01-01T12:00:00Z"))).toBe(60);
    expect(offsetAt({ lon: -112, zone: "America/Phoenix" }, at("2026-05-16T18:00:00Z"))).toBe(-420);
  });
  it("falls back on the longitude", () => {
    expect(offsetAt({ lon: -111.7 }, 0)).toBe(-420);
    expect(offsetAt({ lon: 7.3 }, 0)).toBe(0);
  });
  it("writes a clock", () => {
    expect(clockOf(at("2026-05-16T18:03:44Z"))).toBe("18:03:44");
    expect(clockOf(at("2026-05-16T18:03:44Z"), -420)).toBe("11:03:44");
  });
});

describe("the window searched", () => {
  const phoenix = { lon: -111.7, zone: "America/Phoenix" };
  it("is the half hour either side of an hour", () => {
    expect(windowOf({ day: "2026-05-16", time: "18:30", zone: "utc" }, phoenix)).toEqual([at("2026-05-16T18:00:00Z"), at("2026-05-16T19:00:00Z")]);
    expect(windowOf({ day: "2026-05-16", time: "11:30", zone: "local" }, phoenix)).toEqual([at("2026-05-16T18:00:00Z"), at("2026-05-16T19:00:00Z")]);
  });
  it("is the whole day without an hour", () => {
    expect(windowOf({ day: "2026-05-16", zone: "utc" }, phoenix)).toEqual([at("2026-05-16T00:00:00Z"), at("2026-05-17T00:00:00Z")]);
    expect(windowOf({ day: "2026-05-16", zone: "local" }, phoenix)).toEqual([at("2026-05-16T07:00:00Z"), at("2026-05-17T07:00:00Z")]);
  });
  it("crosses a change of the clocks", () => {
    expect(windowOf({ day: "2026-03-29", time: "12:00", zone: "local" }, { lon: 2, zone: "Europe/Paris" })[0]).toBe(at("2026-03-29T09:30:00Z"));
  });
  it("names every UTC day of flights it reaches", () => {
    expect(daysOf([at("2026-05-16T18:00:00Z"), at("2026-05-16T19:00:00Z")], 170)).toEqual(["2026-05-16"]);
    expect(daysOf([at("2026-05-16T23:30:00Z"), at("2026-05-16T23:59:00Z")], 3600)).toEqual(["2026-05-16", "2026-05-17"]);
    expect(daysOf([at("2026-05-16T07:00:00Z"), at("2026-05-17T07:00:00Z")], 60)).toEqual(["2026-05-16", "2026-05-17"]);
  });
});

describe("passes", () => {
  it("counts tones heard together as one pass", () => {
    expect(passesOf([])).toBe(0);
    expect(passesOf([40, 45, 60])).toBe(1);
    expect(passesOf([40, 45, 120])).toBe(2);
    expect(passesOf([37, 63, 77])).toBe(2);
  });
});

describe("partsOf", () => {
  it("shares the whole job out, finding tones more of it the longer the file", () => {
    const sum = (seconds: number) => partsOf(seconds).reduce((a, [, share]) => a + share, 0);
    expect(sum(60)).toBeCloseTo(1, 12);
    expect(sum(3600)).toBeCloseTo(1, 12);
    const find = (seconds: number) => partsOf(seconds).find(([part]) => part === "find")![1];
    expect(find(60)).toBeLessThan(0.05);
    expect(find(3600)).toBeGreaterThan(0.5);
  });
});
