import { describe, expect, it } from "vitest";
import { heardAt, pathSpeed, STANDARD_AIR } from "./doppler";
import { explainLines, FAMILY, flybyFit, flybyLogs, follow, judge, linesOf, maskOf, onLines } from "./explain";
import type { Listener } from "./geo";
import { matchAll, STRONG, verdictOf, type Candidate } from "./match";
import { buildStack } from "./spectrogram";
import { flybyFixes, synthesize, type Flyby } from "./synth";
import type { Trace } from "./trace";
import { buildTrack } from "./track";

const listener: Listener = { lat: 48.85, lon: 2.35, elevation: 40 };
const START = 1_800_000_000;
const DURATION = 90;
const RATE = 8000;
const HOP = 0.25;
const times = Float64Array.from({ length: DURATION / HOP }, (_, k) => k * HOP);

const trackOf = (f: Flyby, from = START - 60) => buildTrack(flybyFixes(listener, f, from, START + DURATION + 4, 2), listener)!;
const factorOf = (f: Flyby) => Array.from(times, (t) => heardAt(trackOf(f), START + t, STANDARD_AIR)?.factor ?? NaN);

/** A trace as findTraces gives it, laid on frames [from, to] of `freq` (Hz per frame). */
function lineOf(freq: ArrayLike<number>, from: number, to: number): Trace {
  const f = new Float32Array(times.length).fill(NaN);
  const s = new Float32Array(times.length).fill(NaN);
  for (let k = from; k <= to; k++) {
    f[k] = freq[k];
    s[k] = 3;
  }
  return { from, to, freq: f, strength: s, score: 0, confidence: 10, seconds: (to - from + 1) * HOP, fall: f[from] / f[to] };
}

const TOL = Math.log1p(0.02);

// A light aircraft passing 500 m to the side, the one heard.
const passing: Flyby = { closestAt: START + 45, offset: 500, heading: 70, speed: 60, altitude: 640, turnRate: 0.2 };

describe("the free flyby", () => {
  it("is the heard / emitted curve of a straight, steady pass", () => {
    // 60 m/s, 892 m away at the closest point, sound at the speed of the air along the path.
    const straight: Flyby = { ...passing, turnRate: 0 };
    const exact = factorOf(straight);
    const c = pathSpeed(STANDARD_AIR, 600);
    const d = Math.hypot(500, 600);
    const model = flybyLogs(times, 60 / c, d / 60, 45, new Float64Array(times.length));
    for (let k = 20; k < times.length - 20; k += 10) expect(Math.abs(model[k] - Math.log(exact[k]))).toBeLessThan(0.001);
  });

  it("follows the whole line of a pass, turning a little", () => {
    const factor = factorOf(passing);
    const line = lineOf(factor.map((x) => 110 * x), 40, 320);
    const fit = flybyFit(line, times, TOL);
    expect(fit.share).toBeGreaterThan(0.95);
    expect(fit.beta).toBeGreaterThan(0.15);
    expect(fit.beta).toBeLessThan(0.22);
  });
});

describe("follow and judge", () => {
  const factor = factorOf(passing);
  const line = lineOf(factor.map((x) => 110 * x), 40, 320);
  const free = flybyFit(line, times, TOL);

  it("the source follows its whole line, at its tone or a harmonic of it", () => {
    const own = follow(line, 110, factor, TOL);
    expect(own.ratio).toBe(1);
    expect(own.count).toBe(281);
    expect(judge(line, times, own, free, TOL).verdict).toBe("explains");
    const half = follow(line, 55, factor, TOL);
    expect(half.ratio).toBe(2);
    expect(half.count).toBe(281);
    expect(FAMILY).toContain(half.ratio);
  });

  it("an aircraft whose curve follows one stretch of a smooth line borrows it", () => {
    // Another pass, far and late: its curve lies on the line for a while, then goes its own way.
    const far: Flyby = { closestAt: START + 75, offset: 2500, heading: 70, speed: 60, altitude: 1500 };
    const other = factorOf(far);
    // Its tone, chosen to sit on the line where the two curves cross.
    const k = 250;
    const f = follow(line, (110 * factor[k]) / other[k], other, TOL);
    expect(f.count).toBeGreaterThan(8);
    expect(f.count).toBeLessThan(200);
    const { verdict, beyond } = judge(line, times, f, free, TOL);
    expect(verdict).toBe("borrows");
    expect(beyond).toBeGreaterThan(60);
  });

  it("a trace that hops to another tone is not held against the aircraft it follows first", () => {
    // The trace follows the pass, then jumps 8 % down to another tone of the engine, which falls on.
    const hopped = Array.from(factor, (x, k) => 110 * x * (k > 200 ? 0.92 - 0.0004 * (k - 200) : 1));
    const trace = lineOf(hopped, 40, 320);
    const own = follow(trace, 110, factor, TOL);
    const fit = flybyFit(trace, times, TOL);
    expect(judge(trace, times, own, fit, TOL).verdict).not.toBe("borrows");
  });

  it("a curve that runs along a line for long is its source, even when it bends off at one end", () => {
    // The track's own error (a turn between fixes): the last 40 s of the curve drift off the line,
    // up to 8 %, while a straight flyby follows the whole line.
    const bent = Array.from(factor, (x, k) => x * (k > 160 ? 1 + 0.0005 * (k - 160) : 1));
    const own = follow(line, 110, bent, TOL);
    expect(own.count * HOP).toBeGreaterThan(45);
    expect(judge(line, times, own, free, TOL).verdict).toBe("explains");
    // Without that, the flyby that follows its stretch follows the rest too.
    expect(judge(line, times, own, free, TOL, { long: Infinity }).verdict).toBe("borrows");
  });

  it("an aircraft far from the line stays apart", () => {
    const f = follow(line, 400, factor, TOL);
    expect(judge(line, times, f, free, TOL).verdict).toBe("apart");
  });
});

describe("maskOf", () => {
  it("takes out the line's band and its harmonics, merged and in order, only where the line is", () => {
    const line = lineOf(Array.from(times, () => 100), 40, 80);
    const mask = maskOf([line], times.length, 0);
    expect(mask[10].length).toBe(0);
    const bands = mask[60];
    for (let i = 2; i < bands.length; i += 2) expect(bands[i]).toBeGreaterThan(bands[i - 1]);
    const inside = (f: number) => {
      for (let i = 0; i < bands.length; i += 2) if (f >= bands[i] && f <= bands[i + 1]) return true;
      return false;
    };
    for (const f of [100, 101.5, 50, 200, 300, 150, 600, 33.4]) expect(inside(f), `${f} Hz`).toBe(true);
    for (const f of [90, 120, 270, 700]) expect(inside(f), `${f} Hz`).toBe(false);
  });
});

describe("onLines", () => {
  it("tells a trace that runs on a line, or on its harmonic, from one beside it", () => {
    const base = lineOf(Array.from(times, (_, k) => 120 - 0.1 * k), 40, 300);
    const on = new Uint8Array(201).fill(1);
    const same = lineOf(Array.from(times, (_, k) => 120.4 - 0.1 * k), 100, 300);
    const double = lineOf(Array.from(times, (_, k) => 2 * (120 - 0.1 * k)), 100, 300);
    const beside = lineOf(Array.from(times, (_, k) => 1.08 * (120 - 0.1 * k)), 100, 300);
    expect(onLines(same, on, [base], times.length)).toBe(1);
    expect(onLines(double, on, [base], times.length)).toBe(1);
    expect(onLines(beside, on, [base], times.length)).toBe(0);
    expect(onLines(same, on, [], times.length)).toBe(0);
  });
});

describe("explainLines", () => {
  // A loud pass from an aircraft that is not in the flight data, and four aircraft that are: far
  // jets and light aircraft whose curves cross its line. The matcher alone names one of them
  // strongly; the line's whole span shows none of them made it.
  const decoys: Record<string, Flyby> = {
    d35: { closestAt: START + 34, offset: 7208, heading: 207, speed: 165, altitude: 3180 },
    d31: { closestAt: START + 115, offset: 1321, heading: 260, speed: 102, altitude: 3917 },
    d10: { closestAt: START + 136, offset: -5043, heading: 350, speed: 66, altitude: 5158 },
    d1: { closestAt: START + 20, offset: -3000, heading: 120, speed: 200, altitude: 9000 },
  };
  const loud = synthesize({ start: START, duration: DURATION, sampleRate: RATE, air: STANDARD_AIR, sources: [{ track: trackOf(passing), f0: 110, level: 0.4 }], noise: 1, rumble: 1, hum: [{ freq: 50, level: 0.5 }], seed: 5 });
  const stack = buildStack(loud, RATE);
  const lines = linesOf(stack);
  const others: Candidate<null>[] = Object.entries(decoys).map(([id, f]) => ({ id, track: trackOf(f, START - 6), meta: null }));

  it("does not name an aircraft of the data for a loud line it only borrows", async () => {
    const first = await matchAll(stack, START, others, STANDARD_AIR);
    // The bug: alone, the matcher is sure of a plane that was never heard.
    expect(first.kind).toBe("strong");
    const { ranked, unexplained, lines: judged } = await explainLines(stack, START, others, STANDARD_AIR, first.ranked, lines);
    const verdict = verdictOf(ranked);
    expect(verdict.kind, `best ${verdict.best?.id} ${verdict.best?.score.toFixed(2)}`).not.toBe("strong");
    expect(verdict.best!.score).toBeLessThan(STRONG.score);
    expect(verdict.best!.borrowed).toBeGreaterThan(STRONG.score);
    // The line is heard, no aircraft of the data explains it.
    expect(unexplained.length).toBeGreaterThan(0);
    expect(judged.every((l) => !l.by.length)).toBe(true);
  }, 120_000);

  it("keeps the aircraft that made the line, and takes the borrowed evidence from the others", async () => {
    const all = [{ id: "heard", track: trackOf(passing), meta: null }, ...others];
    const first = await matchAll(stack, START, all, STANDARD_AIR);
    const { ranked, unexplained, lines: judged } = await explainLines(stack, START, all, STANDARD_AIR, first.ranked, lines);
    const verdict = verdictOf(ranked);
    expect(verdict.kind).toBe("strong");
    expect(verdict.best!.id).toBe("heard");
    expect(verdict.best!.borrowed).toBeUndefined();
    expect(unexplained).toEqual([]);
    expect(judged.some((l) => l.by.includes("heard"))).toBe(true);
    // The runner-up lost what it borrowed: the lead grew.
    const lead = (r: typeof ranked) => r[0].score - r[1].score;
    expect(lead(ranked)).toBeGreaterThan(lead(first.ranked));
  }, 120_000);
});
