import { describe, expect, it } from "vitest";
import { pathSpeed } from "./doppler";
import { findSegments, findSegmentsWith, flybyOf, flybyOfTone, flybys, shapeOf, stretchOf, type StretchRunner } from "./flyby";
import { toneOf } from "./leak";
import { STANDARD_AIR } from "./doppler";
import { flybyFixes, synthesize } from "./synth";
import { buildTrack } from "./track";

const c = pathSpeed({ groundTempC: 15 }, 300);

/** A straight, steady pass: log of the tone heard every second, closest point emitted at `tc`. */
function pass(f0: number, v: number, d: number, tc: number, seconds: number): { t: Float64Array; y: Float64Array } {
  const t = Float64Array.from({ length: seconds }, (_, i) => i);
  const y = t.map((tr) => {
    let te = tr;
    for (let i = 0; i < 50; i++) te = tr - Math.hypot(v * (te - tc), d) / c;
    const along = v * (te - tc);
    const approach = (-v * along) / Math.hypot(along, d);
    return Math.log((f0 * c) / (c - approach));
  });
  return { t, y };
}

describe("flyby", () => {
  it("reads a straight pass's speed, distance, closest moment and tone", () => {
    const { t, y } = pass(92, 60, 500, 40, 80);
    const f = flybyOf(shapeOf(t, y, c));
    expect(f.speeds[0]).toBeLessThanOrEqual(60);
    expect(f.speeds[1]).toBeGreaterThanOrEqual(60);
    expect(f.speeds[1]).toBeLessThanOrEqual(1.6 * f.speeds[0]);
    expect(f.distances[0]).toBeLessThanOrEqual(500);
    expect(f.distances[1]).toBeGreaterThanOrEqual(500);
    // Heard when the closest point's sound arrives.
    expect(Math.abs(f.closest - (40 + 500 / c))).toBeLessThan(1);
    expect(Math.abs(f.f0 / 92 - 1)).toBeLessThan(0.005);
  });

  it("leaves the speed open on a stretch too short and flat to pin it", () => {
    const { t, y } = pass(92, 60, 3000, 100, 20);
    const f = flybyOf(shapeOf(t, y, c));
    expect(f.speeds[1]).toBeGreaterThan(1.6 * f.speeds[0]);
  });
});

describe("a long recording's stretches over workers", () => {
  const listener = { lat: 48.85, lon: 2.35, elevation: 40 };
  const START = 1_800_000_000;
  const RATE = 8000;
  const DURATION = 130;
  const track = buildTrack(flybyFixes(listener, { closestAt: START + 65, offset: 500, heading: 70, speed: 60, altitude: 640, turnRate: 0.2 }, START - 60, START + DURATION + 4, 2), listener)!;
  const samples = synthesize({ start: START, duration: DURATION, sampleRate: RATE, air: STANDARD_AIR, sources: [{ track, f0: 110, level: 0.25 }], noise: 1, rumble: 1, hum: [{ freq: 50, level: 0.5 }], seed: 31 });
  /** Stretches that finish the sooner the later they start, as workers may. */
  function backwards(): StretchRunner {
    let started = 0;
    return {
      size: 3,
      stretch: async (part, rate, onShare) => {
        const out = stretchOf(part, rate, onShare);
        await new Promise((go) => setTimeout(go, 12 - 4 * (started++ % 3)));
        return out;
      },
    };
  }
  const summary = (segments: Awaited<ReturnType<typeof findSegmentsWith>>["segments"]) => segments.map((g) => ({ offset: g.offset, traces: g.traces.map((t) => ({ from: t.from, to: t.to, score: t.score, confidence: t.confidence, freq: Array.from(t.freq) })) }));

  it("reads a tone as it reads the trace it came from", () => {
    const { segments } = findSegments(samples, RATE, 60, 40);
    const tones = segments.flatMap((g) => g.traces.map((t) => toneOf(t, g.stack.base.times, g.offset)));
    expect(tones.length).toBeGreaterThan(0);
    expect(tones.map((tone) => flybyOfTone(tone))).toEqual(flybys(segments));
  }, 120_000);

  it("finds the same segments, told in order", async () => {
    const whole = findSegments(samples, RATE, 60, 40);
    const told: number[] = [];
    const shares: number[] = [];
    const over = await findSegmentsWith(backwards(), samples, RATE, 60, 40, { onSegment: (g) => told.push(g.offset), onProgress: (s) => shares.push(s) });
    expect(summary(over.segments)).toEqual(summary(whole.segments));
    expect(whole.segments.length).toBeGreaterThan(1);
    expect(over.searched).toEqual(whole.searched);
    expect(told).toEqual(whole.segments.map((g) => g.offset));
    expect(shares.at(-1)).toBeCloseTo(1, 9);
  }, 120_000);
});
