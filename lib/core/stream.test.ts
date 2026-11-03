import { describe, expect, it } from "vitest";
import { STANDARD_AIR } from "./doppler";
import { chunksOf, cleanOut, curvesOf, findTones, readerOf, type Audio } from "./leak";
import { ANALYSIS_RATE } from "./pipeline";
import { analysisWriter, BLOCK_SECONDS, cleanedBlocks, memorySource, memoryStore, readInto, storedSound, takeOutOfFile } from "./stream";
import { flybyFixes, synthesize, type Flyby } from "./synth";
import { buildTrack } from "./track";

// A plane passing in noise, as the page opens one: every channel at the file's own rate.
const listener = { lat: 48.85, lon: 2.35, elevation: 40 };
const START = 1_800_000_000;
function flyby(seconds: number, rate: number, seed = 7): Float32Array {
  const flight: Flyby = { closestAt: START + seconds / 2, offset: 500, heading: 70, speed: 60, altitude: 640, turnRate: 0.2 };
  const track = buildTrack(flybyFixes(listener, flight, START - 60, START + seconds + 4, 2), listener)!;
  return synthesize({ start: START, duration: seconds, sampleRate: rate, air: STANDARD_AIR, sources: [{ track, f0: 110, level: 0.25 }], noise: 1, rumble: 1, hum: [{ freq: 50, level: 0.5 }], seed });
}

const concat = (parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe("the sound at the analysis rate, read a block at a time", () => {
  it("is what reading the whole recording gives, sample for sample", async () => {
    const rate = 48_000;
    const left = flyby(25, rate);
    const right = left.map((x) => 0.5 * x);
    const audio: Audio = { channels: [left, right], sampleRate: rate };
    const store = memoryStore();
    const { length, frames } = await readInto(memorySource(audio), store);
    const whole = readerOf(audio);
    expect(frames).toBe(left.length);
    expect(length).toBe(whole.length);
    const a = store.read(0, length);
    const b = whole.read(0, length);
    let worst = 0;
    for (let i = 0; i < length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    expect(worst).toBeLessThan(1e-5);
  });

  it("copies when the file is already at that rate, however its blocks fall", async () => {
    const samples = Float32Array.from({ length: 5000 }, (_, i) => Math.sin(i / 7));
    const store = memoryStore();
    const writer = analysisWriter(store, ANALYSIS_RATE);
    writer.add([samples.subarray(0, 10)]);
    writer.add([samples.subarray(10, 3000)]);
    writer.add([samples.subarray(3000)]);
    expect(writer.end()).toBe(5000);
    expect(Array.from(store.read(0, 5000))).toEqual(Array.from(samples));
  });

  it("reads as silence past what was written, and across its pages", () => {
    const store = memoryStore();
    const start = (1 << 20) - 2;
    store.write(start, Float32Array.of(1, 2, 3, 4));
    expect(Array.from(store.read(start - 1, 6))).toEqual([0, 1, 2, 3, 4, 0]);
  });
});

describe("take out and look again, on a stored recording", () => {
  it("finds the tone, takes it out, and finds nothing after", async () => {
    const rate = 16_000;
    const audio: Audio = { channels: [flyby(120, rate)], sampleRate: rate };
    const store = memoryStore();
    const { length } = await readInto(memorySource(audio), store);
    const tones = findTones(store.read, chunksOf(length));
    expect(tones.length).toBeGreaterThan(0);
    const rounds: ReturnType<typeof curvesOf>[] = [];
    const { left } = cleanOut(storedSound(store, length), tones, { onRound: (_, t) => rounds.push(curvesOf(t)) });
    expect(left).toEqual([]);
    expect(rounds.length).toBeGreaterThan(0);
    expect(findTones(store.read, chunksOf(length))).toEqual([]);
  });
});

describe("the file's own sound with the rounds taken out", () => {
  it("comes out whole, the same length, and clean across the blocks' joins", async () => {
    const rate = 16_000;
    const seconds = 2.5 * BLOCK_SECONDS + 70;
    const samples = flyby(seconds, rate);
    const source = memorySource({ channels: [samples], sampleRate: rate });
    const store = memoryStore();
    const { length } = await readInto(source, store);
    const tones = findTones(store.read, chunksOf(length));
    expect(tones.length).toBeGreaterThan(0);
    const rounds: ReturnType<typeof curvesOf>[] = [];
    cleanOut(storedSound(store, length), tones, { onRound: (_, t) => rounds.push(curvesOf(t)) });

    const blocks: Float32Array[] = [];
    const left = await takeOutOfFile(source, rounds, store, length, (block) => void blocks.push(block[0].slice()));
    // What comes out holds no tone, and the store now reads what came out.
    expect(left).toEqual([]);
    const out = concat(blocks);
    expect(out.length).toBe(samples.length);
    const { read } = readerOf({ channels: [out], sampleRate: rate });
    expect(findTones(read, chunksOf(length))).toEqual([]);
    const fromStore = store.read(0, length);
    const fromOut = read(0, length);
    let worst = 0;
    for (let i = 0; i < length; i++) worst = Math.max(worst, Math.abs(fromStore[i] - fromOut[i]));
    expect(worst).toBeLessThan(1e-4);
    // Where no curve is known, the sound is exactly as it came in.
    const span = rounds.flat().map((c) => ({ start: (c.times as Float64Array)[0], end: (c.times as Float64Array).at(-1)! }));
    const free = (i: number) => span.every((s) => i / rate < s.start - 10 || i / rate > s.end + 10);
    let changed = 0;
    for (let i = 0; i < out.length; i++) if (free(i) && out[i] !== samples[i]) changed++;
    expect(changed).toBe(0);
  });

  it("leaves nothing of a tone that crosses every block's join", async () => {
    const rate = 8000;
    const seconds = 2 * BLOCK_SECONDS + 10;
    const samples = Float32Array.from({ length: seconds * rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 200 * i) / rate));
    const times = Float64Array.from({ length: seconds * 4 + 1 }, (_, i) => i / 4);
    const freq = new Float64Array(times.length).fill(200);
    const blocks: Float32Array[] = [];
    for await (const b of cleanedBlocks(memorySource({ channels: [samples], sampleRate: rate }), [[{ times, freq }]], { scrub: { fill: false } })) blocks.push(b[0].slice());
    const out = concat(blocks);
    expect(out.length).toBe(samples.length);
    let peak = 0;
    for (let i = rate; i < out.length - rate; i++) peak = Math.max(peak, Math.abs(out[i]));
    expect(peak).toBeLessThan(0.005);
  });
});

describe("a source that stops early", () => {
  it("closes the blocks it was reading", async () => {
    let closed = false;
    const source = {
      sampleRate: 8000,
      channels: 1,
      length: 1 << 18,
      async *blocks() {
        try {
          for (;;) yield [new Float32Array(1 << 16)];
        } finally {
          closed = true;
        }
      },
    };
    const it = cleanedBlocks(source, [])[Symbol.asyncIterator]();
    await it.next();
    await it.return?.(undefined);
    expect(closed).toBe(true);
  });
});
