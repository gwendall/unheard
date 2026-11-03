import { describe, expect, it } from "vitest";
import { heardAt, STANDARD_AIR } from "./doppler";
import type { Listener } from "./geo";
import { chunksOf, clean, curveOf, findTones, mergeTones, readerOf, ridgesOf, toneOf, type Tone } from "./leak";
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

    const c = curveOf(t);
    const curve = { times: Array.from(c.times), freq: Array.from(c.freq) };
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

  it("keeps a ridge that runs beside a louder one with it: a near pitch or a harmonic, parallel", () => {
    const loud = tone(0, falling(0, 120, 100), 40);
    const leak = tone(2, falling(2, 100, 103), 9);
    const harmonic = tone(5, falling(5, 80, 200), 12);
    const [one, ...rest] = mergeTones([leak, loud, harmonic]);
    expect(rest).toEqual([]);
    expect(one.confidence).toBe(40);
    expect(one.beside?.map((t) => t.confidence)).toEqual([12, 9]);
  });

  it("keeps apart other pitches, crossing tones and pieces that do not meet", () => {
    const a = tone(0, falling(0, 80, 100), 9);
    const other = tone(5, falling(5, 80, 130), 12);
    // About as high, but rising while the other falls: another source.
    const crossing = tone(0, Array.from({ length: 80 }, (_, i) => 98 * Math.exp(0.001 * i)), 7);
    const later = tone(30, falling(30, 80, 100), 5);
    const out = mergeTones([a, other, crossing, later]);
    expect(out.map((t) => t.confidence)).toEqual([12, 9, 7, 5]);
    expect(out.every((t) => !t.beside)).toBe(true);
  });
});

describe("findTones", () => {
  it("follows a flyby across the seam of two chunks as one tone", () => {
    // 150 s in chunks of 30 s sharing 10 s: the plane is closest at 70 s, on a seam (60 to 70 s).
    const duration = 150;
    const { samples, track } = flyby(duration, 70, 5);
    const { read, length } = readerOf({ channels: [samples], sampleRate: RATE });
    const chunks = chunksOf(length, RATE, 30, 10);
    expect(chunks.length).toBe(7);
    const tones = findTones(read, chunks);
    expect(tones.length).toBeGreaterThanOrEqual(1);
    const t = tones[0];
    // One tone across the seams at 60 to 70 s and 80 to 90 s, around the closest approach.
    expect(t.times[0]).toBeLessThan(60);
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

describe("findTones, lines taken along", () => {
  // A plane heard at 110 Hz and at 13.5 times that, 1485 Hz: out of the 40 to 400 Hz search even
  // as a second or third harmonic, and no harmonic of 110. One aircraft, one Doppler factor.
  const duration = 60;
  const f: Flyby = { closestAt: START + 30, offset: 500, heading: 70, speed: 60, altitude: 640 };
  const track = trackOf(f, duration);
  const samples = synthesize({ start: START, duration, sampleRate: RATE, air: STANDARD_AIR, sources: [{ track, f0: 110, level: 0.25 }, { track, f0: 1485, level: 0.25, harmonics: [1] }], noise: 1, rumble: 1, seed: 11 });
  const { read, length } = readerOf({ channels: [samples], sampleRate: RATE });
  const near = (t: Tone, ratio: number) =>
    ridgesOf(t).some((r) => {
      const k = Math.round((r.times[0] - t.times[0]) / 0.25);
      const i = Math.max(0, -k);
      return Math.abs(r.freq[i] / t.freq[i + k] - ratio) < 0.05 * ratio;
    });

  it("takes a line far above 400 Hz with the tone it runs parallel to, without reporting it", () => {
    const tones = findTones(read, chunksOf(length));
    // Reported: what lies below 400 Hz, the 110 Hz tone (132 Hz as the plane comes in) first.
    expect(tones.every((t) => Math.max(...t.freq) < 400)).toBe(true);
    expect(tones[0].freq[0]).toBeGreaterThan(120);
    expect(tones[0].freq[0]).toBeLessThan(140);
    expect(near(tones[0], 13.5)).toBe(true);
  });

  it("leaves it out when asked not to look along", () => {
    const tones = findTones(read, chunksOf(length), RATE, { along: null });
    expect(tones.some((t) => near(t, 13.5))).toBe(false);
  });

  it("takes a line up there that runs with no tone too, without reporting it", () => {
    // Heard at 1485 Hz only, passing 25 s earlier than the plane at 110 Hz: parallel to nothing.
    const other = trackOf({ ...f, closestAt: START + 5, offset: 300 }, duration);
    const both = synthesize({ start: START, duration, sampleRate: RATE, air: STANDARD_AIR, sources: [{ track, f0: 110, level: 0.25 }, { track: other, f0: 1485, level: 0.25, harmonics: [1] }], noise: 0.05, seed: 8 });
    const r = readerOf({ channels: [both], sampleRate: RATE });
    const tones = findTones(r.read, chunksOf(r.length));
    expect(tones.every((t) => Math.max(...t.freq) < 400)).toBe(true);
    expect(tones.flatMap(ridgesOf).some((t) => Math.max(...t.freq) > 1000)).toBe(true);
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
    // Without the fill, whose noise is new in every window.
    const whole = scrub(samples, RATE, [curve], { fill: false });
    const channels = [samples.slice(), samples.slice()];
    clean({ channels, sampleRate: RATE }, [curve], { window: 5, margin: 4, scrub: { fill: false } });
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
