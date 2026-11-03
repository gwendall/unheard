import { describe, expect, it } from "vitest";
import { rate, wilson } from "./stats";

describe("wilson", () => {
  it("matches the textbook interval", () => {
    // 7 / 10: 0.397 to 0.892 (Wilson, z = 1.96).
    const [lo, hi] = wilson(7, 10);
    expect(lo).toBeCloseTo(0.397, 3);
    expect(hi).toBeCloseTo(0.892, 3);
  });

  it("stays inside 0..1 at the edges", () => {
    expect(wilson(0, 30)[0]).toBe(0);
    expect(wilson(0, 30)[1]).toBeCloseTo(0.1135, 3);
    expect(wilson(30, 30)[1]).toBe(1);
    expect(wilson(30, 30)[0]).toBeCloseTo(0.8865, 3);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });

  it("narrows as n grows", () => {
    const width = (k: number, n: number) => wilson(k, n)[1] - wilson(k, n)[0];
    expect(width(70, 100)).toBeLessThan(width(7, 10));
  });
});

describe("rate", () => {
  it("reads as a count, a share and its interval", () => {
    expect(rate(7, 10)).toBe("7 / 10, 70 % (40 to 89 %)");
    expect(rate(0, 30)).toBe("0 / 30 (at most 11 %)");
    expect(rate(0, 0)).toBe("none");
  });
});
