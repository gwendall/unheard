import { describe, expect, it } from "vitest";
import { estimator, stagesOf } from "./progress";

/** A clock the test steps. */
function stepped() {
  let now = 100;
  return { clock: () => now, step: (seconds: number) => (now += seconds) };
}

describe("estimator", () => {
  it("says nothing of the time left before it has something to go on", () => {
    const { clock, step } = stepped();
    expect(estimator(clock)(0.5).secondsLeft).toBeNull();
    const at = estimator(clock);
    step(5);
    expect(at(0.01).secondsLeft).toBeNull();
  });

  it("gives the time left at the pace so far", () => {
    const { clock, step } = stepped();
    const at = estimator(clock);
    step(10);
    const e = at(0.25);
    expect(e.fraction).toBe(0.25);
    expect(e.secondsLeft).toBeCloseTo(30, 9);
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

  it("settles rather than jumps when the pace changes", () => {
    const { clock, step } = stepped();
    const at = estimator(clock);
    step(10);
    const first = at(0.5).secondsLeft!;
    step(1);
    // The pace now says 44 s left: the estimate moves towards it, and does not get there at once.
    const next = at(0.2).secondsLeft;
    expect(first).toBeCloseTo(10, 9);
    expect(next).toBeGreaterThan(first - 3);
    step(1);
    const after = at(0.9).secondsLeft!;
    expect(after).toBeLessThan(first);
    expect(after).toBeGreaterThan((12 * 0.1) / 0.9);
  });

  it("ends at the whole bar with nothing left", () => {
    const { clock } = stepped();
    expect(estimator(clock)(1)).toEqual({ fraction: 1, secondsLeft: 0 });
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
