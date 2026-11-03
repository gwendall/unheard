import { describe, expect, it } from "vitest";
import { pathSpeed } from "./doppler";
import { flybyOf, shapeOf } from "./flyby";

const c = pathSpeed({ groundTempC: 15 }, 300);

/** A straight, steady pass: log of the tone heard every second, closest point emitted at `tc`. */
function pass(f0: number, v: number, d: number, tc: number, seconds: number): { t: Float64Array; y: Float64Array } {
  const t = Float64Array.from({ length: seconds }, (_, i) => i);
  const y = t.map((tr) => {
    let te = tr;
    for (let i = 0; i < 50; i++) te = tr - Math.hypot(v * (te - tc), d) / c;
    const along = v * (te - tc);
    const approach = (-v * along) / Math.hypot(along, d);
    return Math.log((f0 * c) / (c - approach));
  });
  return { t, y };
}

describe("flyby", () => {
  it("reads a straight pass's speed, distance, closest moment and tone", () => {
    const { t, y } = pass(92, 60, 500, 40, 80);
    const f = flybyOf(shapeOf(t, y, c));
    expect(f.speeds[0]).toBeLessThanOrEqual(60);
    expect(f.speeds[1]).toBeGreaterThanOrEqual(60);
    expect(f.speeds[1]).toBeLessThanOrEqual(1.6 * f.speeds[0]);
    expect(f.distances[0]).toBeLessThanOrEqual(500);
    expect(f.distances[1]).toBeGreaterThanOrEqual(500);
    // Heard when the closest point's sound arrives.
    expect(Math.abs(f.closest - (40 + 500 / c))).toBeLessThan(1);
    expect(Math.abs(f.f0 / 92 - 1)).toBeLessThan(0.005);
  });

  it("leaves the speed open on a stretch too short and flat to pin it", () => {
    const { t, y } = pass(92, 60, 3000, 100, 20);
    const f = flybyOf(shapeOf(t, y, c));
    expect(f.speeds[1]).toBeGreaterThan(1.6 * f.speeds[0]);
  });
});
