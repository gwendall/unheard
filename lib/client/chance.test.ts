import { describe, expect, it } from "vitest";
import { audible, outlook } from "./chance";
import type { Nearby } from "./nearby";

const plane = (hex: string, type: string, distance: number, closestIn: number, closestAt: number, category = "A1"): Nearby => ({
  meta: { hex, type, category },
  distance,
  height: 500,
  closestIn,
  closestAt,
});

describe("audible", () => {
  it("hears a propeller that will pass within 5 km, not a jet that far", () => {
    expect(audible(plane("a", "C172", 9000, 120, 1500))).toBe(true);
    expect(audible(plane("b", "B738", 9000, 120, 4000, "A3"))).toBe(false);
    expect(audible(plane("c", "B738", 9000, 120, 2000, "A3"))).toBe(true);
  });

  it("drops what passes too far, too late, or is already gone", () => {
    expect(audible(plane("a", "C172", 9000, 120, 7000))).toBe(false);
    expect(audible(plane("a", "C172", 30000, 900, 500))).toBe(false);
    expect(audible(plane("a", "C172", 8000, -60, 1000))).toBe(false);
    expect(audible(plane("a", "C172", 2000, -20, 1000))).toBe(true);
  });
});

describe("outlook", () => {
  it("says quiet, with the nearest aircraft, when nothing can be heard", () => {
    const o = outlook([plane("far", "A320", 14000, 300, 12000, "A3"), plane("near", "B738", 9000, -30, 9000, "A3")]);
    expect(o.kind).toBe("quiet");
    if (o.kind === "quiet") {
      expect(o.nearest?.meta.hex).toBe("near");
      expect(o.count).toBe(2);
    }
    expect(outlook([])).toEqual({ kind: "quiet", nearest: null, count: 0 });
  });

  it("prefers a close pass later to a far pass now, and a propeller to a jet", () => {
    const o = outlook([plane("far-now", "C172", 4500, 20, 4000), plane("close-later", "DR40", 9000, 180, 800), plane("jet", "A320", 3000, 30, 900, "A3")]);
    expect(o.kind).toBe("coming");
    if (o.kind === "coming") {
      expect(o.best.meta.hex).toBe("close-later");
      expect(o.in).toBe(180);
      expect(o.at).toBe(800);
    }
  });

  it("says passing when the best one is at its closest", () => {
    const o = outlook([plane("h", "EC35", 1200, 5, 1100, "A7")]);
    expect(o.kind).toBe("passing");
  });
});
