import { describe, expect, it } from "vitest";
import { fft } from "./fft";

describe("fft", () => {
  it("matches a direct DFT", () => {
    const n = 64;
    const x = Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + ((i * 7919) % 13) / 13);
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    fft(re, im);
    for (let k = 0; k < n; k++) {
      let dr = 0;
      let di = 0;
      for (let t = 0; t < n; t++) {
        dr += x[t] * Math.cos((2 * Math.PI * k * t) / n);
        di -= x[t] * Math.sin((2 * Math.PI * k * t) / n);
      }
      expect(re[k]).toBeCloseTo(dr, 9);
      expect(im[k]).toBeCloseTo(di, 9);
    }
  });

  it("refuses a size that is not a power of two", () => {
    expect(() => fft(new Float64Array(12), new Float64Array(12))).toThrow();
  });
});
