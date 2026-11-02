import { describe, expect, it } from "vitest";
import { heardAt, naiveHeardAt, pathSpeed, STANDARD_AIR } from "./doppler";
import type { Listener } from "./geo";
import { flybyFixes } from "./synth";
import { buildTrack } from "./track";

const listener: Listener = { lat: 48.85, lon: 2.35, elevation: 40 };
const T = 1_800_000_000;
// Straight over the listener's head, 1 km up, 60 m/s, closest at T.
const track = buildTrack(flybyFixes(listener, { closestAt: T, offset: 0, heading: 90, speed: 60, altitude: 1040 }, T - 300, T + 300, 2), listener)!;

describe("heardAt", () => {
  it("hears the closest point late, unshifted", () => {
    const c = pathSpeed(STANDARD_AIR, 1000);
    const heard = heardAt(track, T + 1000 / c, STANDARD_AIR)!;
    expect(heard.emitted).toBeCloseTo(T, 2);
    expect(heard.range).toBeCloseTo(1000, 0);
    expect(heard.factor).toBeCloseTo(1, 3);
  });

  it("is higher while the aircraft comes and lower once it goes", () => {
    const before = heardAt(track, T - 120, STANDARD_AIR)!;
    const after = heardAt(track, T + 120, STANDARD_AIR)!;
    expect(before.factor).toBeGreaterThan(1.1);
    expect(after.factor).toBeLessThan(0.9);
    const c = pathSpeed(STANDARD_AIR, 1000);
    // Far away the aircraft comes almost straight at us: c / (c - v cos θ).
    expect(before.factor).toBeLessThan(c / (c - 60));
  });

  it("solves the travel time exactly", () => {
    for (const t of [T - 200, T - 30, T, T + 45, T + 200]) {
      const h = heardAt(track, t, STANDARD_AIR)!;
      const c = pathSpeed(STANDARD_AIR, 1000);
      expect(t - h.emitted).toBeCloseTo(h.range / c, 2);
    }
  });

  it("differs from the naive model, which hears the aircraft already leaving", () => {
    const c = pathSpeed(STANDARD_AIR, 1000);
    const t = T + 1000 / c;
    expect(naiveHeardAt(track, t, STANDARD_AIR)!.factor).toBeLessThan(0.975);
    expect(heardAt(track, t, STANDARD_AIR)!.factor).toBeCloseTo(1, 3);
  });

  it("knows nothing far outside the track", () => {
    expect(heardAt(track, T + 2000, STANDARD_AIR)).toBeNull();
  });
});
