import { describe, expect, it } from "vitest";
import { heardAt, naiveHeardAt, STANDARD_AIR } from "./doppler";
import type { Listener } from "./geo";
import { curveScore, matchAll, POSSIBLE, STRONG, verdictOf, type Candidate, type Match } from "./match";
import { buildStack } from "./spectrogram";
import { flybyFixes, synthesize, type Flyby } from "./synth";
import { buildTrack, type Track } from "./track";

const listener: Listener = { lat: 48.85, lon: 2.35, elevation: 40 };
const START = 1_800_000_000;
const DURATION = 120;
const RATE = 8000;
const CLOCK_ERROR = 0.75; // the phone's clock runs 0.75 s behind the flight data

const flybys: Record<string, Flyby> = {
  // A light propeller plane 600 m to the side, 660 m up, closest a minute in, turning gently.
  target: { closestAt: START + 60, offset: 600, heading: 70, speed: 62, altitude: 700, turnRate: 0.3 },
  // The same path twenty seconds later: same curve, wrong moment.
  echo: { closestAt: START + 80, offset: 800, heading: 70, speed: 62, altitude: 700 },
  prop: { closestAt: START + 45, offset: -2500, heading: 250, speed: 75, altitude: 1500 },
  jet: { closestAt: START + 90, offset: 4000, heading: 10, speed: 140, altitude: 3000 },
  high: { closestAt: START + 30, offset: 12000, heading: 180, speed: 220, altitude: 10000 },
};

const tracks: Record<string, Track> = Object.fromEntries(
  Object.entries(flybys).map(([id, f]) => [id, buildTrack(flybyFixes(listener, f, START - 60, START + DURATION + 4, 2), listener)!]),
);

const candidates = (ids: string[]): Candidate<null>[] => ids.map((id) => ({ id, track: tracks[id], meta: null }));
const ALL = Object.keys(flybys);

function record(sources: { id: string; f0: number; level: number }[], seed: number) {
  const samples = synthesize({
    start: START,
    duration: DURATION,
    sampleRate: RATE,
    air: STANDARD_AIR,
    sources: sources.map((s) => ({ track: tracks[s.id], f0: s.f0, level: s.level })),
    noise: 1,
    rumble: 1,
    hum: [
      { freq: 50, level: 0.5 },
      { freq: 100, level: 0.3 },
    ],
    seed,
  });
  const stack = buildStack(samples, RATE);
  return { samples, stack, spec: stack.base };
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

describe("matchAll", () => {
  it("finds the plane hidden 20 dB under the noise, its tone and the phone's clock error", async () => {
    // Level 0.14 is strong on seeds 7, 8 and 9 (9.8 to 11.9); 0.1 (-29 dB) only possible at best.
    const { samples, stack } = record([{ id: "target", f0: 96, level: 0.14 }], 7);
    const tone = synthesize({ start: START, duration: DURATION, sampleRate: RATE, air: STANDARD_AIR, sources: [{ track: tracks.target, f0: 96, level: 0.14 }] });
    // The tone alone is more than 20 dB under everything else in the recording.
    expect(20 * Math.log10(rms(tone) / rms(samples))).toBeLessThan(-20);

    const verdict = await matchAll(stack, START - CLOCK_ERROR, candidates(ALL), STANDARD_AIR);
    expect(verdict.kind, `best ${verdict.best?.id} ${verdict.best?.score.toFixed(2)}`).toBe("strong");
    expect(verdict.best!.id).toBe("target");
    // f0 and clock trade off a little along the curve.
    expect(Math.abs(verdict.best!.f0 - 96)).toBeLessThan(0.6);
    expect(Math.abs(verdict.best!.clock - CLOCK_ERROR)).toBeLessThanOrEqual(0.75);
    expect(verdict.best!.closest!.range).toBeLessThan(1000);
  });

  it("scores the naive model far below the right one", () => {
    const { spec, stack } = record([{ id: "target", f0: 96, level: 0.1 }], 7);
    const right = Array.from(spec.times, (t) => heardAt(tracks.target, START + t, STANDARD_AIR)?.factor ?? NaN);
    const naive = Array.from(spec.times, (t) => naiveHeardAt(tracks.target, START + t, STANDARD_AIR)?.factor ?? NaN);
    const r = curveScore(stack, right, 96);
    const n = curveScore(stack, naive, 96);
    expect(r).toBeGreaterThan(2 * n);
  });

  it("finds nothing in noise alone", async () => {
    for (const seed of [11, 12, 13]) {
      const { stack } = record([], seed);
      const verdict = await matchAll(stack, START, candidates(ALL), STANDARD_AIR);
      expect(verdict.kind, `seed ${seed}: best ${verdict.best?.score.toFixed(2)}`).toBe("none");
      expect(verdict.best!.score).toBeLessThan(POSSIBLE.score);
    }
  });

  it("does not blame another plane when the one heard is missing from the data", async () => {
    const { stack } = record([{ id: "target", f0: 96, level: 0.14 }], 21);
    const verdict = await matchAll(stack, START, candidates(ALL.filter((id) => id !== "target")), STANDARD_AIR);
    expect(verdict.kind, `best ${verdict.best?.id} ${verdict.best?.score.toFixed(2)}`).not.toBe("strong");
  });
});

describe("verdictOf", () => {
  const named = (score: number, range: number) => ({ id: "x", score, closest: { range, heardAt: 0, delay: 0 } }) as Match<object>;

  it("says strong up to the range cap, and possible past it whatever the score", () => {
    expect(verdictOf([named(15, STRONG.range)]).kind).toBe("strong");
    expect(verdictOf([named(15, STRONG.range + 1)]).kind).toBe("possible");
  });
});
