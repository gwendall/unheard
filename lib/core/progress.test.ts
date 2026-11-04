import { describe, expect, it } from "vitest";
import { estimator, stagesOf } from "./progress";

/** A clock the test steps. */
function stepped() {
  let now = 100;
  return { clock: () => now, step: (seconds: number) => (now += seconds) };
}

describe("estimator", () => {
  it("tells no time before the last stage, whatever went by", () => {
    const { clock, step } = stepped();
    const at = estimator(clock, 0.5);
    for (const fraction of [0.1, 0.3, 0.49]) {
      step(30);
      expect(at(fraction)).toEqual({ fraction, secondsLeft: null });
    }
  });

  it("tells none early in the last stage either", () => {
    const { clock, step } = stepped();
    const at = estimator(clock, 0.5);
    at(0.5);
    step(30);
    expect(at(0.55).secondsLeft).toBeNull();
    const short = estimator(clock, 0.5);
    short(0.5);
    step(0.5);
    expect(short(0.9).secondsLeft).toBeNull();
  });

  it("goes by the last stage's own pace, not by the job's", () => {
    const { clock, step } = stepped();
    const at = estimator(clock, 0.5);
    // Half of the job in 400 s, then half of the last stage in 10 s.
    step(400);
    at(0.5);
    step(10);
    // 10 s left at that pace, stretched, and a little for what comes after.
    expect(at(0.75).secondsLeft).toBeCloseTo(1.25 * 10 + 3, 9);
  });

  it("is the same whatever share the stages were given", () => {
    const times = (lastStage: number) => {
      const { clock, step } = stepped();
      const at = estimator(clock, lastStage);
      at(lastStage);
      step(20);
      return at(lastStage + (1 - lastStage) * 0.5).secondsLeft;
    };
    expect(times(0.2)).toBeCloseTo(times(0.9)!, 6);
  });

  it("never lets the bar go back", () => {
    const { clock, step } = stepped();
    const at = estimator(clock);
    step(10);
    expect(at(0.5).fraction).toBe(0.5);
    step(1);
    expect(at(0.33).fraction).toBe(0.5);
    step(1);
    expect(at(0.6).fraction).toBe(0.6);
  });

  it("never rises: past a time told, it tells none until the pace is back under it", () => {
    const { clock, step } = stepped();
    const at = estimator(clock);
    at(0);
    step(10);
    const first = at(0.5).secondsLeft!;
    // The next stretch is ten times slower: the pace now says more than was told.
    step(100);
    expect(at(0.55).secondsLeft).toBeNull();
    // It picks up.
    step(5);
    const next = at(0.98).secondsLeft!;
    expect(next).toBeLessThan(first);
  });

  it("holds on the real hour's shape: never up, and never less than what is left", () => {
    // Built around what production showed on 04/11: slow at first, and 92 % of the bar 60 s from the end.
    // The last stage starts at 78 % on an hour (`partsOf`); the other times are made up to fit.
    const lastStage = 0.78;
    const end = 367;
    const events: [number, number][] = [[10, 0.03], [103, 0.2], [150, 0.3], [180, 0.5], [200, 0.78]];
    for (let i = 1; i <= 12; i++) events.push([200 + (i * 167) / 12, 0.78 + (0.22 * i) / 12]);
    let now = 0;
    const at = estimator(() => now, lastStage);
    let previous = Infinity;
    for (const [time, fraction] of events) {
      now = time;
      const { secondsLeft } = at(fraction);
      if (fraction < lastStage) expect(secondsLeft).toBeNull();
      if (secondsLeft === null) continue;
      expect(secondsLeft).toBeLessThanOrEqual(previous);
      expect(secondsLeft).toBeGreaterThanOrEqual(end - time);
      previous = secondsLeft;
    }
    expect(previous).toBeLessThan(60);
  });

  it("tells none once the bar is whole: what comes after it is not counted", () => {
    const { clock } = stepped();
    expect(estimator(clock)(1)).toEqual({ fraction: 1, secondsLeft: null });
  });
});

describe("stagesOf", () => {
  it("adds up the stages in order, whatever their shares sum to", () => {
    const at = stagesOf([["a", 1], ["b", 3]] as const);
    expect(at("a", 0)).toBe(0);
    expect(at("a", 1)).toBe(0.25);
    expect(at("b", 0)).toBe(0.25);
    expect(at("b", 0.5)).toBeCloseTo(0.625, 12);
    expect(at("b", 1)).toBe(1);
    expect(at("b", 2)).toBe(1);
  });
});
