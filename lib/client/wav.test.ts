import { describe, expect, it } from "vitest";
import { wavBlob } from "./wav";

describe("wavBlob", () => {
  it("writes every channel, interleaved, at full scale and the rate given", async () => {
    const left = Float32Array.from([0, 0.5, -1, 2]);
    const right = Float32Array.from([1, -0.5, 0.25, -3]);
    const bytes = new DataView(await wavBlob([left, right], 48_000).arrayBuffer());
    const text = (o: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => bytes.getUint8(o + i)));
    expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(bytes.byteLength).toBe(44 + 4 * 2 * 2);
    expect(bytes.getUint32(4, true)).toBe(bytes.byteLength - 8);
    expect(bytes.getUint16(22, true)).toBe(2);
    expect(bytes.getUint32(24, true)).toBe(48_000);
    expect(bytes.getUint32(28, true)).toBe(48_000 * 4);
    expect(bytes.getUint32(40, true)).toBe(16);
    const samples = Array.from({ length: 8 }, (_, i) => bytes.getInt16(44 + i * 2, true));
    // Levels kept, only clipped: 2 and -3 become full scale.
    expect(samples).toEqual([0, 32767, 16384, -16383, -32767, 8192, 32767, -32767]);
  });
});
