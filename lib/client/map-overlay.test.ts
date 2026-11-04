import { layers } from "@protomaps/basemaps";
import { describe, expect, it } from "vitest";
import { metresApart } from "./where";
import { boundsOf, overlayOf, type OverlayFeature, type OverlayLabels } from "./map-overlay";
import { FLAVOR, MAP_FILE, scaled, styleOf } from "./map-style";
import type { Guess } from "./where.worker";

const guess: Guess = {
  lat: 40.8748,
  lon: -73.5249,
  start: 0,
  mirror: { lat: 40.8886, lon: -73.5041 },
  planes: [{ hex: "a1b2c3", registration: "N172OB", type: "C172", metres: 1400, at: 0, tone: 90 }],
  paths: [
    { hex: "a1b2c3", points: [[-9000, -5200], [0, 1400], [8000, 6300]], closest: [0, 1400] },
    { hex: "c0ffee", points: [[7000, -8200], [-2500, 9100]], closest: [1000, -2000] },
  ],
};
const labels: OverlayLabels = { guess: "Guess", mirror: "Mirror", other: (n) => `Answer ${n}`, plane: (hex) => (hex === "a1b2c3" ? "N172OB" : undefined) };
const others = [{ lat: 40.83, lon: -73.58 }];
const features = overlayOf(guess, others, labels).features;
const ofKind = (kind: OverlayFeature["properties"]["kind"]) => features.filter((f) => f.properties.kind === kind);
const point = (f: OverlayFeature) => {
  if (f.geometry.type !== "Point") throw new Error("not a point");
  const [lon, lat] = f.geometry.coordinates;
  return { lat, lon };
};

describe("the answer on the map", () => {
  it("draws what the diagram draws: the guess, its mirror, the tracks and their closest points", () => {
    expect(point(ofKind("guess")[0])).toEqual({ lat: 40.8748, lon: -73.5249 });
    expect(ofKind("guess")[0].properties.label).toBe("Guess");
    expect(point(ofKind("mirror")[0])).toEqual(guess.mirror);
    expect(ofKind("track")).toHaveLength(2);
    expect(ofKind("closest")).toHaveLength(2);
    expect(ofKind("closest").map((f) => f.properties.label)).toEqual(["N172OB", undefined]);
    expect(ofKind("other").map((f) => f.properties.label)).toEqual(["Answer 2"]);
  });

  it("puts a track's closest point where the metres say", () => {
    expect(metresApart(guess, point(ofKind("closest")[0]))).toBeCloseTo(1400, -1);
  });

  it("gives no mirror mark when there is none", () => {
    expect(overlayOf({ ...guess, mirror: null }, [], labels).features.some((f) => f.properties.kind === "mirror")).toBe(false);
  });

  it("keeps the rings to what was close, each a true circle with its distance", () => {
    expect(ofKind("ring-label").map((f) => f.properties.label)).toEqual(["1 km", "2 km"]);
    const near = overlayOf({ ...guess, mirror: null, paths: [{ hex: "x", points: [[0, 0], [1, 1]], closest: [0, 300] }] }, [], labels).features;
    expect(near.filter((f) => f.properties.kind === "ring")).toHaveLength(2);
    const [first] = ofKind("ring");
    if (first.geometry.type !== "LineString") throw new Error("not a line");
    for (const [lon, lat] of first.geometry.coordinates) expect(metresApart(guess, { lat, lon })).toBeCloseTo(1000, -1);
  });

  it("frames the guess, the mirror and the whole tracks", () => {
    const [[west, south], [east, north]] = boundsOf(guess);
    for (const f of [...ofKind("guess"), ...ofKind("mirror"), ...ofKind("closest")]) {
      const { lat, lon } = point(f);
      expect(lat >= south && lat <= north && lon >= west && lon <= east).toBe(true);
    }
    for (const f of ofKind("track")) {
      if (f.geometry.type !== "LineString") throw new Error("not a line");
      for (const [lon, lat] of f.geometry.coordinates) expect(lat >= south && lat <= north && lon >= west && lon <= east).toBe(true);
    }
    expect(north - south).toBeGreaterThan(0.1);
  });

  it("takes in another answer close enough to belong, and not one far away", () => {
    const [[, ], [eastAlone]] = boundsOf(guess);
    const near = { lat: guess.lat, lon: eastAlone + 0.01 };
    expect(boundsOf(guess, [near])[1][0]).toBe(near.lon);
    expect(boundsOf(guess, [{ lat: guess.lat, lon: guess.lon + 5 }])[1][0]).toBe(eastAlone);
  });

  it("stands around a guess alone", () => {
    expect(boundsOf({ ...guess, mirror: null, paths: [] })).toEqual([
      [guess.lon, guess.lat],
      [guess.lon, guess.lat],
    ]);
  });
});

describe("the style", () => {
  const base = "https://bucket.example";
  const style = styleOf(base, "en");

  it("reads tiles, fonts and sprite from the base given, and names no other host", () => {
    expect(style.sources.protomaps).toEqual({ type: "vector", url: `pmtiles://${base}/${MAP_FILE}` });
    expect(style.glyphs).toBe(`${base}/map/fonts/{fontstack}/{range}.pbf`);
    expect(style.sprite).toBe(`${base}/map/sprites/v4/dark`);
    const hosts = new Set([...JSON.stringify(style).matchAll(/https?:\/\/([^/"]+)/g)].map((m) => m[1]));
    expect([...hosts]).toEqual(["bucket.example"]);
  });

  it("is not a default map", () => {
    expect(FLAVOR.water).toBe("#05070d");
    expect(JSON.stringify(style)).not.toContain("#1f1f1f");
  });

  it("draws the answer's lines under the names of places, and its marks over them", () => {
    const ids = style.layers.map((l) => l.id);
    const names = ids.indexOf("places_locality");
    expect(ids.indexOf("answer-track")).toBeLessThan(ids.indexOf("roads_labels_minor"));
    expect(ids.indexOf("answer-track")).toBeGreaterThan(ids.indexOf("buildings"));
    expect(ids.indexOf("answer-guess")).toBeGreaterThan(names);
    expect(ids.indexOf("answer-guess-label")).toBeGreaterThan(ids.indexOf("answer-mirror-label"));
  });

  it("keeps the answer the only thing in colour", () => {
    expect(new Set(Object.values(FLAVOR.pois!)).size).toBe(1);
    const pois = style.layers.find((l) => l.id === "pois");
    expect(pois?.layout).toMatchObject({ "icon-image": "" });
  });

  it("keeps the map's names off the marks and the tracks: the last layers hold room", () => {
    const ids = style.layers.map((l) => l.id);
    expect(ids.slice(-4)).toEqual(["answer-room-tracks", "answer-room-edges", "answer-room-dots", "answer-room-guess"]);
    expect(style.layers.at(-1)?.paint).toEqual({ "text-opacity": 0 });
  });

  it("shows the answer's words where the placer put them, whatever else is there", () => {
    for (const id of ["answer-guess-label", "answer-mirror-label", "answer-other-labels", "answer-closest-labels", "answer-ring-labels"]) {
      const layer = style.layers.find((l) => l.id === id);
      expect(layer).toMatchObject({ source: "answer-words", layout: { "text-allow-overlap": true, "text-anchor": "center" } });
    }
  });

  it("makes the land clearly lighter than the water, with an edge between them", () => {
    const luminance = (hex: string) => [1, 3, 5].reduce((sum, i, n) => sum + parseInt(hex.slice(i, i + 2), 16) * [0.2126, 0.7152, 0.0722][n], 0);
    expect(luminance(FLAVOR.earth)).toBeGreaterThan(luminance(FLAVOR.water) * 3);
    const ids = style.layers.map((l) => l.id);
    expect(ids.indexOf("coastline")).toBe(ids.indexOf("water") + 1);
  });

  it("draws towns larger than Protomaps does", () => {
    const town = style.layers.find((l) => l.id === "places_locality") as { layout: Record<string, unknown> };
    expect(JSON.stringify(town.layout["text-size"])).not.toBe(JSON.stringify((layers("protomaps", FLAVOR, { lang: "en" }).find((l) => l.id === "places_locality") as { layout: Record<string, unknown> }).layout["text-size"]));
    expect(scaled(["interpolate", ["linear"], ["zoom"], 2, 10, 8, ["case", ["<", ["get", "r"], 3], 8, 12]], 2)).toEqual(["interpolate", ["linear"], ["zoom"], 2, 20, 8, ["case", ["<", ["get", "r"], 3], 16, 24]]);
  });

  it("names places in the page's language", () => {
    expect(JSON.stringify(styleOf(base, "fr"))).toContain("name:fr");
  });
});
