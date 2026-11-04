import { describe, expect, it } from "vitest";
import { cropStart } from "./where-card";

describe("cropStart", () => {
  it("keeps a central spot central", () => {
    expect(cropStart(100, 200, 0.5)).toBe(-50);
  });

  it("stays inside the picture when the spot is near an edge", () => {
    expect(cropStart(100, 200, 0.1)).toBe(0);
    expect(cropStart(100, 200, 0.9)).toBe(-100);
  });

  it("keeps the spot in the frame wherever it lies", () => {
    for (const spot of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
      const at = cropStart(100, 170, spot) + spot * 170;
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(100);
    }
  });

  it("moves nothing when the picture fits", () => {
    expect(cropStart(100, 100, 0.2)).toBeCloseTo(0);
  });
});
