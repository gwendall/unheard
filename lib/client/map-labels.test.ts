import { describe, expect, it } from "vitest";
import { crosses, edgesOf, placeWords, ringsToShow, type Rect, type Word } from "./map-labels";
import type { Overlay, OverlayFeature } from "./map-overlay";

/** The tests' map: a position is its own pixel. */
const project = ([x, y]: [number, number]) => ({ x, y });
const measure = (label: string, size: number) => label.length * size * 0.6;
const scene = { width: 390, height: 360, keepOut: [{ left: 322, top: 12, right: 378, bottom: 144 }] };

const point = (kind: OverlayFeature["properties"]["kind"], x: number, y: number, label?: string, radius?: number): OverlayFeature => ({
  type: "Feature",
  properties: { kind, label, radius },
  geometry: { type: "Point", coordinates: [x, y] },
});
const track = (...coordinates: [number, number][]): OverlayFeature => ({ type: "Feature", properties: { kind: "track" }, geometry: { type: "LineString", coordinates } });
const overlay = (...features: OverlayFeature[]): Overlay => ({ type: "FeatureCollection", features });
const named = (words: Word[], label: string) => words.find((w) => w.label === label);
const hit = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function expectClean(words: Word[], { width, height, keepOut } = scene) {
  for (const w of words) {
    expect(w.box.left, `${w.label} left`).toBeGreaterThanOrEqual(0);
    expect(w.box.top, `${w.label} top`).toBeGreaterThanOrEqual(0);
    expect(w.box.right, `${w.label} right`).toBeLessThanOrEqual(width);
    expect(w.box.bottom, `${w.label} bottom`).toBeLessThanOrEqual(height);
    for (const k of keepOut) expect(hit(w.box, k), `${w.label} under the buttons`).toBe(false);
    for (const other of words) if (other !== w) expect(hit(w.box, other.box), `${w.label} on ${other.label}`).toBe(false);
  }
}

describe("placeWords", () => {
  it("keeps a word at the right edge inside the frame", () => {
    const { words } = placeWords(overlay(point("guess", 150, 200, "Guess"), point("other", 380, 300, "Answer 2")), project, scene, measure);
    expect(named(words, "Answer 2")).toBeDefined();
    expect(named(words, "Answer 2")!.box.right).toBeLessThanOrEqual(384);
    expectClean(words);
  });

  it("keeps a word at the left edge inside the frame, on its other side", () => {
    const { words } = placeWords(overlay(point("guess", 300, 200, "Guess"), point("other", 8, 300, "Answer 2")), project, scene, measure);
    expect(named(words, "Answer 2")!.box.left).toBeGreaterThanOrEqual(6);
    expectClean(words);
  });

  it("never puts a word under the buttons", () => {
    const { words } = placeWords(overlay(point("guess", 100, 300, "Guess"), point("other", 300, 60, "Answer 3")), project, scene, measure);
    expect(named(words, "Answer 3")).toBeDefined();
    expectClean(words);
  });

  it("gives the guess and the mirror each their word when they nearly touch", () => {
    const { words } = placeWords(overlay(point("mirror", 190, 170, "Mirror"), point("guess", 170, 190, "Guess")), project, scene, measure);
    expect(words.map((w) => w.label).sort()).toEqual(["Guess", "Mirror"]);
    expectClean(words);
  });

  it("takes a side that no track crosses", () => {
    // A track right where the guess's word would go first.
    const { words } = placeWords(overlay(track([190, 100], [190, 300]), point("guess", 170, 200, "Guess")), project, scene, measure);
    const box = named(words, "Guess")!.box;
    expect(crosses([190, 100, 190, 300], box)).toBe(false);
  });

  it("finds the guess and mirror spots free of tracks in a crowded crossing", () => {
    const features = [
      track([40, 320], [340, 60]),
      track([120, 40], [300, 340]),
      point("guess", 180, 200, "Guess"),
      point("mirror", 210, 170, "Mirror"),
      point("closest", 196, 184, "N172OB"),
      point("closest", 205, 180, "N4521K"),
    ];
    const { words } = placeWords(overlay(...features), project, scene, measure);
    expectClean(words);
    for (const label of ["Guess", "Mirror"]) {
      const box = named(words, label)!.box;
      expect(crosses([40, 320, 340, 60], box), label).toBe(false);
      expect(crosses([120, 40, 300, 340], box), label).toBe(false);
    }
  });

  it("keeps a word off every dot", () => {
    const dots = [point("guess", 200, 180, "Guess"), point("closest", 230, 180), point("closest", 170, 180), point("closest", 200, 150), point("closest", 200, 210)];
    const { words } = placeWords(overlay(...dots), project, scene, measure);
    const box = named(words, "Guess")!.box;
    for (const [x, y] of [[230, 180], [170, 180], [200, 150], [200, 210]]) expect(hit(box, { left: x - 6, top: y - 6, right: x + 6, bottom: y + 6 })).toBe(false);
  });

  it("always names the guess and the mirror, even across a line, and leaves out a detail with no clean spot", () => {
    const lines = Array.from({ length: 40 }, (_, i) => track([0, i * 9], [390, i * 9]));
    const { words } = placeWords(overlay(...lines, point("guess", 100, 180, "Guess"), point("mirror", 260, 180, "Mirror"), point("other", 100, 300, "Answer 2")), project, scene, measure);
    expect(named(words, "Guess")).toBeDefined();
    expect(named(words, "Mirror")).toBeDefined();
    expect(named(words, "Answer 2")).toBeUndefined();
  });

  it("says nothing of a mark outside the frame", () => {
    const { words } = placeWords(overlay(point("guess", 100, 100, "Guess"), point("other", 500, 100, "Answer 2"), point("mirror", 100, 400, "Mirror")), project, scene, measure);
    expect(words.map((w) => w.label)).toEqual(["Guess"]);
  });

  it("gives the guess its spot before anything else, whatever the order of the data", () => {
    const { words } = placeWords(overlay(point("closest", 230, 200, "N1"), point("other", 250, 215, "Answer 2"), point("guess", 200, 200, "Guess")), project, scene, measure);
    expect(words[0].label).toBe("Guess");
    expectClean(words);
  });

  it("offsets a word in ems of its own size", () => {
    const { words } = placeWords(overlay(point("guess", 100, 200, "Guess")), project, scene, measure);
    const [w] = words;
    expect(w.offset[0] * w.size).toBeCloseTo((w.box.left + w.box.right) / 2 - 100, 5);
    expect(w.offset[1] * w.size).toBeCloseTo((w.box.top + w.box.bottom) / 2 - 200, 5);
  });

  it("draws a ring only when it can be read, and names it where there is room", () => {
    const features = [point("guess", 150, 200, "Guess"), point("ring-label", 150 + 21, 200 - 21, "1 km", 1000), point("ring-label", 150 + 71, 200 - 71, "2 km", 2000), point("ring-label", 150 + 700, 200 - 700, "20 km", 20_000)];
    const { words, rings } = placeWords(overlay(...features), project, scene, measure);
    expect(rings).toEqual([2000]);
    expect(words.map((w) => w.label)).toEqual(["Guess", "2 km"]);
    expectClean(words);
  });
});

describe("edgesOf", () => {
  it("outlines the frame and what lies over the map", () => {
    const edges = edgesOf(scene, (x, y) => [x, y]);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toEqual([[0, 0], [390, 0], [390, 360], [0, 360], [0, 0]]);
    expect(edges[1][0]).toEqual([322, 12]);
  });
});

describe("ringsToShow", () => {
  it("leaves out a ring too small to read or larger than the picture", () => {
    expect(ringsToShow([{ radius: 1, pixels: 12 }, { radius: 2, pixels: 40 }, { radius: 5, pixels: 200 }, { radius: 10, pixels: 400 }], 390, 360)).toEqual([2, 5]);
  });
});

describe("crosses", () => {
  const box = { left: 10, top: 10, right: 20, bottom: 20 };
  it("sees a segment through, into or beside a box", () => {
    expect(crosses([0, 15, 30, 15], box)).toBe(true);
    expect(crosses([15, 15, 40, 40], box)).toBe(true);
    expect(crosses([0, 0, 30, 5], box)).toBe(false);
    expect(crosses([25, 0, 25, 30], box)).toBe(false);
  });
});
