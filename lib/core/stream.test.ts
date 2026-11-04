import { describe, expect, it } from "vitest";
import { STANDARD_AIR } from "./doppler";
import { chunksOf, cleanOut, curvesOf, findChunk, findTones, findTonesWith, inline, readerOf, takeOutChannels, takeOutOf, type Audio, type Pieces } from "./leak";
import { ANALYSIS_RATE } from "./pipeline";
import { scrub, type Curve } from "./scrub";
import { computeSpectrogram } from "./spectrogram";
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
    const { left } = await cleanOut(storedSound(store, length), tones, { onRound: (_, t) => rounds.push(curvesOf(t)) });
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
    await cleanOut(storedSound(store, length), tones, { onRound: (_, t) => rounds.push(curvesOf(t)) });

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

describe("the same work over pieces", () => {
  // Pieces as workers run them: on a copy of what they are given, the ones asked last done first.
  const backToFront = (size: number): Pieces => {
    let asked = 0;
    const turn = async () => {
      for (let wait = 2 * (size - asked++ % size); wait > 0; wait--) await null;
    };
    return {
      size,
      chunk: async (samples, start, rate, options, onShare) => {
        const given = structuredClone({ samples, options });
        await turn();
        return structuredClone(findChunk(given.samples, start, rate, given.options, onShare));
      },
      takeOut: async (job, onShare) => {
        const given = structuredClone(job);
        await turn();
        return structuredClone(takeOutOf(given, onShare));
      },
    };
  };

  const rate = ANALYSIS_RATE;
  const seconds = 90;

  /** The whole check: what it finds, what it takes out, the store, and the sound that comes out. */
  async function check(file: Audio, pieces: Pieces | undefined) {
    const source = memorySource(file);
    const store = memoryStore();
    const { length } = await readInto(source, store);
    const chunks = chunksOf(length, ANALYSIS_RATE, 60, 20);
    const tones = pieces ? await findTonesWith(pieces, store.read, chunks) : findTones(store.read, chunks);
    const rounds: ReturnType<typeof curvesOf>[] = [];
    const { cleaned } = await cleanOut(storedSound(store, length, ANALYSIS_RATE, pieces), tones, { pieces, rounds: 2, onRound: (_, t) => rounds.push(curvesOf(t)) });
    const blocks: Float32Array[][] = [];
    const still = await takeOutOfFile(source, rounds, store, length, (block) => void blocks.push(block.map((ch) => ch.slice())), { pieces });
    return { chunks: chunks.length, tones, cleaned, rounds, still, store: store.read(0, length), out: file.channels.map((_, c) => concat(blocks.map((b) => b[c]))) };
  }

  it("finds, takes out and writes what one thread does, to the last sample, whatever the order", async () => {
    const left = flyby(seconds, rate, 21);
    const file: Audio = { channels: [left, Float32Array.from(left, (x, i) => 0.5 * x + 0.5 * (left[i + 1] ?? 0))], sampleRate: rate };
    const one = await check(file, undefined);
    expect(one.chunks).toBeGreaterThan(1);
    expect(one.tones.length).toBeGreaterThan(0);
    expect(one.rounds.length).toBeGreaterThan(0);
    const many = await check(file, backToFront(3));
    expect(many.tones).toEqual(one.tones);
    expect(many.cleaned).toEqual(one.cleaned);
    expect(many.rounds).toEqual(one.rounds);
    expect(many.still).toEqual(one.still);
    expect(many.store).toEqual(one.store);
    expect(many.out).toEqual(one.out);
  }, 300_000);

  it("reads the sound as it was: a piece's result is written once the next one has read", async () => {
    const piece = 60 * ANALYSIS_RATE;
    const margin = 4 * ANALYSIS_RATE;
    const store = memoryStore();
    const log: string[] = [];
    const watched = { read: (a: number, n: number) => (log.push(`read ${a}`), store.read(a, n)), write: (a: number, s: Float32Array) => (log.push(`write ${a}`), store.write(a, s)) };
    const nothingDone: Pieces = { size: 2, chunk: async () => ({ found: [], wide: [] }), takeOut: async (job) => job.channels };
    await storedSound(watched, 4 * piece, ANALYSIS_RATE, nothingDone).clean([{ times: Float64Array.of(0, 240), freq: Float64Array.of(100, 100) }], {});
    expect(log.filter((e) => e.startsWith("write")).length).toBe(4);
    for (const k of [1, 2, 3]) expect(log.indexOf(`read ${k * piece - margin}`)).toBeLessThan(log.indexOf(`write ${(k - 1) * piece}`));
    // At most its size at work, and one just read.
    expect(log.slice(0, 3)).toEqual(["read 0", `read ${piece - margin}`, `read ${2 * piece - margin}`]);
    expect(log[3]).toBe("write 0");
  });
});

describe("a stereo file, loud then quiet", () => {
  const rate = ANALYSIS_RATE;

  /** Noise and rumble, with the plane and the hum if asked, 40 dB lower after `loud` seconds: a clip with its end left silent. */
  function shaped(seconds: number, loud: number, seed: number, heard: boolean): Float32Array {
    const track = buildTrack(flybyFixes(listener, { closestAt: START + 45, offset: 500, heading: 70, speed: 60, altitude: 640 }, START - 60, START + seconds + 4, 2), listener)!;
    const sources = heard ? [{ track, f0: 92, level: 0.37 }] : [];
    const hum = heard ? [{ freq: 50, level: 1 }] : [];
    const x = synthesize({ start: START, duration: seconds, sampleRate: rate, air: STANDARD_AIR, sources, noise: 1, rumble: 1, hum, seed });
    for (let i = loud * rate; i < x.length; i++) x[i] *= 0.01;
    return x;
  }

  /** The two channels of a phone: the same sound, with a little of each channel's own. */
  function twoChannels(mid: Float32Array, seed: number): Audio {
    const own = synthesize({ start: START, duration: mid.length / rate, sampleRate: rate, air: STANDARD_AIR, sources: [], noise: 0.05, seed });
    return { channels: [mid.map((v, i) => v + own[i]), mid.map((v, i) => v - own[i])], sampleRate: rate };
  }

  async function checked(file: Audio) {
    const source = memorySource(file);
    const store = memoryStore();
    const { length } = await readInto(source, store);
    const tones = findTones(store.read, chunksOf(length));
    const rounds: Curve[][] = [];
    const { cleaned, left } = await cleanOut(storedSound(store, length), tones, { onRound: (_, t) => rounds.push(curvesOf(t)) });
    const blocks: Float32Array[][] = [];
    const still = await takeOutOfFile(source, rounds, store, length, (block) => void blocks.push(block.map((ch) => ch.slice())));
    return { tones, cleaned, left, still, out: file.channels.map((_, c) => concat(blocks.map((b) => b[c]))) };
  }

  it("finds no line in plain noise that stops: its level is no tone", () => {
    // Each frequency compared with itself across both stretches drew stripes in the loud one: lines up to confidence 40 in 4 files of 6.
    for (const seed of [6, 11]) {
      const x = shaped(180, 85, seed, false);
      expect(findTones((a, n) => x.slice(a, a + n), chunksOf(x.length)).map((t) => t.confidence)).toEqual([]);
    }
  }, 120_000);

  it("still sees a plane falling slowly through the minute it was louder: a level that stops takes no tone with it", () => {
    // Each stretch's own median per frequency holds a line this slow, and made it vanish: it stands at confidence 173 to 361 here.
    const x = synthesize({ start: START, duration: 180, sampleRate: rate, air: STANDARD_AIR, sources: [], noise: 1, rumble: 1, seed: 3 });
    const phase = [0, 0, 0];
    for (let i = 0; i < x.length; i++) {
      const t = i / rate;
      if (t < 60 || t >= 120) {
        x[i] *= 0.1;
        continue;
      }
      const f = 110 - 0.05 * (t - 60) + 0.3 * Math.sin((2 * Math.PI * t) / 23);
      phase.forEach((_, k) => {
        phase[k] += (2 * Math.PI * f * (k + 1)) / rate;
        x[i] += (0.5 / (k + 1)) * Math.sin(phase[k]);
      });
    }
    const [tone] = findTones((a, n) => x.slice(a, a + n), chunksOf(x.length));
    expect(tone.confidence).toBeGreaterThan(50);
    expect(tone.times[0]).toBeGreaterThan(55);
    expect(tone.times[tone.times.length - 1]).toBeLessThan(125);
    expect(tone.freq[0]).toBeGreaterThan(108);
    expect(tone.freq[tone.freq.length - 1]).toBeLessThan(108);
  }, 120_000);

  it("takes the plane out and leaves no line behind it, the same every time", async () => {
    // Before the level groups and the fill in time and frequency, this came out with lines at confidence 265 and 98.
    const file = twoChannels(shaped(180, 85, 8, true), 9);
    const a = await checked(file);
    expect(a.tones.length).toBeGreaterThan(0);
    expect(a.still.map((t) => t.confidence)).toEqual([]);
    // The look again goes lower than what is reported: nothing under a tone's confidence reaches the page.
    for (const t of [...a.cleaned, ...a.left]) expect(t.confidence).toBeGreaterThanOrEqual(4);
    const { read, length } = readerOf({ channels: a.out, sampleRate: rate });
    expect(findTones(read, chunksOf(length)).map((t) => t.confidence)).toEqual([]);
    const b = await checked(file);
    expect(b.out).toEqual(a.out);
  }, 300_000);

  /** Mean power of `x` around `f` (`half` Hz either side), through a 1 s window, from `from` to `to` seconds. */
  function power(x: Float32Array, f: number, half: number, from: number, to: number): number {
    const spec = computeSpectrogram(x.subarray(from * rate, to * rate), rate, { windowSeconds: 1, hopSeconds: 0.25, minHz: 20, maxHz: 1000 });
    const [b0, b1] = [f - half, f + half].map((v) => Math.round((v - spec.minHz) / spec.binHz));
    let sum = 0;
    for (let k = 0; k < spec.frames; k++) for (let b = b0; b <= b1; b++) sum += 10 ** (spec.db[k * spec.bins + b] / 10);
    return 10 * Math.log10(sum);
  }

  const steady: Curve = { times: [0, 40], freq: [200, 200] };

  it("keeps the level of the mix in the band: noise of its own in each channel would add up 3 dB low", async () => {
    const mid = shaped(40, 40, 5, false);
    const file = twoChannels(mid, 6);
    const [l, r] = await takeOutChannels(inline, { channels: file.channels.map((c) => c.slice()), rate, rounds: [[steady]], scrub: { harmonics: 1 } });
    const mix = l.map((v, i) => (v + r[i]) / 2);
    expect(Math.abs(power(mix, 200, 3, 4, 36) - power(mid, 200, 3, 4, 36))).toBeLessThan(1);
    // Each channel keeps its level too.
    expect(Math.abs(power(l, 200, 3, 4, 36) - power(file.channels[0], 200, 3, 4, 36))).toBeLessThan(1);
  });

  it("leaves a silent channel silent, and a channel beside it as a channel alone", async () => {
    const left = shaped(40, 40, 5, false);
    const silent = new Float32Array(left.length);
    const [l, r] = await takeOutChannels(inline, { channels: [left.slice(), silent], rate, rounds: [[steady]], scrub: { harmonics: 1 } });
    expect(r.every((v) => v === 0)).toBe(true);
    expect(l).toEqual(scrub(left, rate, [steady], { harmonics: 1 }));
  });

  it("gives every sample nothing touched back exactly", async () => {
    const file = twoChannels(shaped(60, 60, 5, false), 6);
    const short: Curve = { times: [10, 20], freq: [200, 190] };
    const [l, r] = await takeOutChannels(inline, { channels: file.channels.map((c) => c.slice()), rate, rounds: [[short]] });
    expect(l.subarray(30 * rate)).toEqual(file.channels[0].subarray(30 * rate));
    expect(r.subarray(30 * rate)).toEqual(file.channels[1].subarray(30 * rate));
  });
});
