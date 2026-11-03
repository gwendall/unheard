import { describe, expect, it } from "vitest";
import { normalize, speedFor } from "./reveal";

describe("reveal", () => {
  it("speeds a light aircraft's hum up two octaves, a jet's not at all", () => {
    expect(speedFor(80, 110)).toBe(4);
    expect(speedFor(40, 60)).toBe(8);
    expect(speedFor(180, 230)).toBe(2);
    expect(speedFor(900, 1900)).toBe(1);
  });

  it("brings the loudest sample to the peak asked for", () => {
    const out = normalize(new Float32Array([0.1, -0.2, 0.05]), 0.8);
    expect(Math.max(...out.map(Math.abs))).toBeCloseTo(0.8);
    expect(normalize(new Float32Array(3))).toEqual(new Float32Array(3));
  });
});
