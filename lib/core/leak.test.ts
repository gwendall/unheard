import { describe, expect, it } from "vitest";
import { heardAt, STANDARD_AIR } from "./doppler";
import type { Listener } from "./geo";
import { chunksOf, clean, curveOf, findTones, mergeTones, readerOf, toneOf, type Tone } from "./leak";
import { resample } from "./resample";
import { scrub } from "./scrub";
import { buildStack } from "./spectrogram";
import { flybyFixes, synthesize, type Flyby } from "./synth";
import { findTraces, type Trace } from "./trace";
import { buildTrack } from "./track";

const listener: Listener = { lat: 48.85, lon: 2.35, elevation: 40 };
const START = 1_800_000_000;
const RATE = 8000;

const trackOf = (f: Flyby, duration: number) => buildTrack(flybyFixes(listener, f, START - 60, START + duration + 4, 2), listener)!;

function flyby(duration: number, closest: number, seed: number) {
  const f: Flyby = { closestAt: START + closest, offset: 500, heading: 70, speed: 60, altitude: 640, turnRate: 0.2 };
  const track = trackOf(f, duration);
  const samples = synthesize({ start: START, duration, sampleRate: RATE, air: STANDARD_AIR, sources: [{ track, f0: 110, level: 0.25 }], noise: 1, rumble: 1, hum: [{ freq: 50, level: 0.5 }], seed });
  return { samples, track };
}

/** A tone on the whole file's clock, every 0.25 s from `from` seconds (1.024 s past the frame grid). */
function tone(from: number, freq: number[], confidence = 10): Tone {
  return { times: Float64Array.from(freq, (_, i) => 1.024 + from + i * 0.25), freq: Float32Array.from(freq), confidence };
}

describe("chunksOf", () => {
  it("covers the recording in overlapping chunks that start on the frame grid", () => {
    const length = 7200 * RATE + 123;
    const chunks = chunksOf(length);
    expect(chunks[0].start).toBe(0);
    expect(chunks.at(-1)!.end).toBe(length);
    for (const c of chunks) {
      expect(c.start % 2000).toBe(0);
      expect(c.end - c.start).toBeLessThanOrEqual(180 * RATE);
    }
    for (let i = 1; i < chunks.length; i++) expect(chunks[i - 1].end - chunks[i].start).toBe(60 * RATE);
    // The last one keeps more than the overlap: it is never a sliver already seen.
    expect(chunks.at(-1)!.end - chunks.at(-1)!.start).toBeGreaterThan(60 * RATE);
    expect(chunks.length).toBe(60);
  });

  it("keeps a short recording whole", () => {
    expect(chunksOf(95 * RATE)).toEqual([{ start: 0, end: 95 * RATE }]);
  });
});

describe("toneOf and curveOf", () => {
  it("puts a chunk's trace on the file's clock, and the curve scrub follows along it", () => {
    const K = 400;
    const times = Float64Array.from({ length: K }, (_, k) => 1.024 + k * 0.25);
    const freq = new Float32Array(K).fill(NaN);
    for (let k = 100; k <= 199; k++) freq[k] = 120 - 0.1 * (k - 100);
    const trace: Trace = { from: 100, to: 199, freq, strength: new Float32Array(K), score: 1, confidence: 7, seconds: 25, fall: 1.09 };
    const t = toneOf(trace, times, 120);
    expect(t.times.length).toBe(100);
    expect(t.times[0]).toBeCloseTo(120 + 1.024 + 25, 9);
    expect(t.freq[0]).toBeCloseTo(120, 4);
    expect(t.freq[99]).toBeCloseTo(110.1, 4);
    expect(t.confidence).toBe(7);

    const curve = curveOf(t);
    // The tone's own frames, then 2 s more at either end along its slope.
    expect(curve.times.length).toBe(100 + 16);
    expect(curve.times[0]).toBeCloseTo(t.times[0] - 2, 9);
    expect(curve.times.at(-1)!).toBeCloseTo(t.times[99] + 2, 9);
    expect(curve.freq[8]).toBeCloseTo(120, 4);
    expect(curve.freq[0]).toBeGreaterThan(120);
    expect(curve.freq[0]).toBeLessThan(121);
    expect(curve.freq.at(-1)!).toBeLessThan(110.1);
    expect(curve.freq.at(-1)!).toBeGreaterThan(109);
    for (const f of curve.freq) expect(Number.isFinite(f)).toBe(true);
    for (let i = 1; i < curve.times.length; i++) expect(curve.times[i] - curve.times[i - 1]).toBeCloseTo(0.25, 9);
  });
});

describe("mergeTones", () => {
  const falling = (from: number, n: number, f0: number) => Array.from({ length: n }, (_, i) => f0 * Math.exp(-0.002 * (from * 4 + i)));

  it("joins the pieces of one tone found in two chunks", () => {
    // Frames 0 to 79 in one chunk, 40 to 159 in the next: 40 frames shared, a hair apart.
    const a = tone(0, falling(0, 80, 100), 12);
    const b = tone(10, falling(10, 120, 100.2), 8);
    const [joined, ...rest] = mergeTones([b, a]);
    expect(rest).toEqual([]);
    expect(joined.times.length).toBe(160);
    expect(joined.times[0]).toBeCloseTo(a.times[0], 9);
    expect(joined.times[159]).toBeCloseTo(b.times[119], 9);
    // Where both have it, the surer piece's frequency.
    expect(joined.freq[50]).toBeCloseTo(a.freq[50], 4);
    expect(joined.freq[100]).toBeCloseTo(b.freq[60], 4);
    expect(joined.confidence).toBe(12);
  });

  it("keeps apart tones at other pitches, and pieces that do not meet", () => {
    const a = tone(0, falling(0, 80, 100), 9);
    const harmonic = tone(5, falling(5, 80, 200), 12);
    const later = tone(30, falling(30, 80, 100), 5);
    const out = mergeTones([a, harmonic, later]);
    expect(out.map((t) => t.confidence)).toEqual([12, 9, 5]);
  });
});

describe("findTones", () => {
  it("follows a flyby across the seam of two chunks as one tone", () => {
    // 150 s in chunks of 60 s sharing 20 s: the plane is closest at 70 s, on the first seam.
    const duration = 150;
    const { samples, track } = flyby(duration, 70, 5);
    const { read, length } = readerOf({ channels: [samples], sampleRate: RATE });
    const chunks = chunksOf(length, RATE, 60, 20);
    expect(chunks.length).toBe(4);
    const tones = findTones(read, chunks);
    expect(tones.length).toBeGreaterThanOrEqual(1);
    const t = tones[0];
    // One tone that spans the seam at 40 to 60 s and the closest approach.
    expect(t.times[0]).toBeLessThan(45);
    expect(t.times.at(-1)!).toBeGreaterThan(85);
    // It follows the true curve times a tone in closed form, the way traceFit reads it.
    const r = Array.from(t.times, (time, i) => Math.log(t.freq[i] / heardAt(track, START + time, STANDARD_AIR)!.factor)).sort((x, y) => x - y);
    const mid = r[r.length >> 1];
    const misfit = r.map((x) => Math.abs(x - mid)).sort((x, y) => x - y)[r.length >> 1];
    expect(misfit).toBeLessThan(0.005);
    // The same search on the whole file at once finds it too.
    const whole = findTraces(buildStack(samples, RATE)).traces;
    expect(whole.length).toBeGreaterThanOrEqual(1);
  });
});

describe("readerOf", () => {
  it("reads any piece of a stereo file as the whole file mixed down and resampled", () => {
    const from = 48_000;
    const n = from * 3;
    const left = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 110 * i) / from) + 0.3 * Math.sin((2 * Math.PI * 7000 * i) / from));
    const right = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 233 * i) / from));
    const mono = Float32Array.from(left, (v, i) => (v + right[i]) / 2);
    const whole = resample(mono, from, RATE);
    const { read, length } = readerOf({ channels: [left, right], sampleRate: from });
    expect(length).toBe(whole.length);
    const piece = read(9000, 6000);
    let worst = 0;
    for (let i = 0; i < piece.length; i++) worst = Math.max(worst, Math.abs(piece[i] - whole[9000 + i]));
    expect(worst).toBeLessThan(1e-5);
  });
});

describe("clean", () => {
  it("cleans window by window as scrub does the whole file at once", () => {
    const duration = 40;
    const { samples, track } = flyby(duration, 20, 9);
    const times: number[] = [];
    const freq: number[] = [];
    for (let t = 3; t <= 33; t += 0.25) {
      times.push(t);
      freq.push(110 * heardAt(track, START + t, STANDARD_AIR)!.factor + 0.4);
    }
    const curve = { times, freq };
    const whole = scrub(samples, RATE, [curve]);
    const channels = [samples.slice(), samples.slice()];
    clean({ channels, sampleRate: RATE }, [curve], { window: 5, margin: 4 });
    let worst = 0;
    let peak = 0;
    for (let i = 0; i < whole.length; i++) {
      worst = Math.max(worst, Math.abs(channels[0][i] - whole[i]), Math.abs(channels[1][i] - whole[i]));
      peak = Math.max(peak, Math.abs(whole[i]));
    }
    expect(worst / peak).toBeLessThan(1e-4);
    // Outside the curve, not a sample moved.
    expect(Array.from(channels[0].subarray(0, 2 * RATE))).toEqual(Array.from(samples.subarray(0, 2 * RATE)));
  });
});
