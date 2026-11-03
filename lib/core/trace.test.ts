import { describe, expect, it } from "vitest";
import { heardAt, STANDARD_AIR } from "./doppler";
import type { Listener } from "./geo";
import { buildStack } from "./spectrogram";
import { flybyFixes, synthesize, type Flyby, type Source } from "./synth";
import { findTraces, traceFit, type Trace } from "./trace";
import { buildTrack } from "./track";

const listener: Listener = { lat: 48.85, lon: 2.35, elevation: 40 };
const START = 1_800_000_000;
const DURATION = 90;
const RATE = 8000;

const trackOf = (f: Flyby) => buildTrack(flybyFixes(listener, f, START - 60, START + DURATION + 4, 2), listener)!;

function stackOf(sources: Source[], seed: number) {
  const samples = synthesize({
    start: START,
    duration: DURATION,
    sampleRate: RATE,
    air: STANDARD_AIR,
    sources,
    noise: 1,
    rumble: 1,
    hum: [{ freq: 50, level: 0.5 }],
    chirps: [{ at: 20, duration: 4, from: 300, to: 240, level: 0.05 }],
    seed,
  });
  return buildStack(samples, RATE);
}

/** Heard / emitted per base frame along the true track. */
const factorOf = (stack: ReturnType<typeof stackOf>, f: Flyby) => Array.from(stack.base.times, (t) => heardAt(trackOf(f), START + t, STANDARD_AIR)?.factor ?? NaN);

/** The trace among `traces` that follows `factor` times some tone, with its fit. */
function following(traces: Trace[], factor: number[]) {
  return traces.map((t) => ({ t, fit: traceFit(t, factor) })).find((x) => x.fit.misfit < 0.004 && x.fit.covered > 0.9);
}

const propeller: Flyby = { closestAt: START + 45, offset: 500, heading: 70, speed: 60, altitude: 640, turnRate: 0.2 };
const helicopter: Flyby = { closestAt: START + 35, offset: -900, heading: 200, speed: 45, altitude: 400 };

describe("findTraces", () => {
  it("follows a propeller's falling tone with no flight data", () => {
    const stack = stackOf([{ track: trackOf(propeller), f0: 110, level: 0.25 }], 3);
    const { traces } = findTraces(stack);
    const hit = following(traces, factorOf(stack, propeller));
    expect(hit, `traces ${traces.map((t) => `${t.freq[t.from].toFixed(0)}->${t.freq[t.to].toFixed(0)} c=${t.confidence.toFixed(1)}`).join(", ")}`).toBeDefined();
    // The closed-form tone is the emitted one (or a harmonic of it).
    const ratio = hit!.fit.f0 / 110;
    expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(0.005);
    // It spans the closest approach, where the pitch falls fastest.
    const cpa = Math.round((propeller.closestAt - START) / (stack.base.times[1] - stack.base.times[0]));
    expect(hit!.t.from).toBeLessThan(cpa - 20);
    expect(hit!.t.to).toBeGreaterThan(cpa + 20);
    expect(hit!.t.fall).toBeGreaterThan(1.1);
  });

  it("finds two aircraft heard at once", () => {
    const stack = stackOf(
      [
        { track: trackOf(propeller), f0: 110, level: 0.25 },
        { track: trackOf(helicopter), f0: 75, harmonics: [1, 0.7, 0.5], level: 0.3 },
      ],
      4,
    );
    const { traces } = findTraces(stack);
    expect(following(traces, factorOf(stack, propeller))).toBeDefined();
    expect(following(traces, factorOf(stack, helicopter))).toBeDefined();
  });

  it("finds nothing in noise, hum and a passing car", () => {
    for (const seed of [11, 12, 13]) {
      const { traces, null: nul } = findTraces(stackOf([], seed));
      expect(traces.map((t) => t.confidence), `seed ${seed}, null ${nul.mid.toFixed(1)}`).toEqual([]);
    }
  });
});

describe("traceFit", () => {
  it("recovers the tone in closed form from an exact curve", () => {
    const stack = stackOf([], 1);
    const factor = factorOf(stack, propeller);
    const freq = new Float32Array(factor.length).fill(NaN);
    for (let k = 40; k < 300; k++) freq[k] = 2 * 96 * factor[k];
    const trace: Trace = { from: 40, to: 299, freq, strength: new Float32Array(factor.length), score: 1, confidence: 1, seconds: 65, fall: 1 };
    const fit = traceFit(trace, factor);
    expect(fit.f0).toBeCloseTo(192, 1);
    expect(fit.misfit).toBeLessThan(1e-6);
    expect(fit.covered).toBe(1);
  });
});
