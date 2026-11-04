import { describe, expect, it } from "vitest";
import { fft, realFft } from "./fft";

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

  it("matches a direct DFT at every size, odd powers of two and even", () => {
    for (const n of [1, 2, 4, 8, 16, 32, 128, 256]) {
      const x = Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + 0.2);
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
    }
  });

  it("gives a real signal's half spectrum as the complex one does", () => {
    for (const n of [2, 4, 8, 64, 512]) {
      const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + ((i * 7919) % 13) / 13);
      const wholeRe = x.slice();
      const wholeIm = new Float64Array(n);
      fft(wholeRe, wholeIm);
      const re = new Float64Array(n);
      const im = new Float64Array(n);
      realFft(x, re, im);
      for (let k = 0; k <= n / 2 && k < n; k++) {
        expect(re[k]).toBeCloseTo(wholeRe[k], 9);
        expect(im[k]).toBeCloseTo(wholeIm[k], 9);
      }
    }
  });

  it("refuses a size that is not a power of two", () => {
    expect(() => fft(new Float64Array(12), new Float64Array(12))).toThrow();
  });
});
