import { describe, expect, it } from "vitest";
import { heardAt, STANDARD_AIR } from "./doppler";
import type { Listener } from "./geo";
import { matchAll, POSSIBLE } from "./match";
import { scrub, type Curve } from "./scrub";
import { buildStack } from "./spectrogram";
import { flybyFixes, synthesize } from "./synth";
import { buildTrack } from "./track";

const listener: Listener = { lat: 48.85, lon: 2.35, elevation: 40 };
const START = 1_800_000_000;
const DURATION = 90;
const RATE = 8000;
const F0 = 92;

// A light propeller plane 700 m to the side, closest 45 s in, loud enough to be named for sure.
const track = buildTrack(flybyFixes(listener, { closestAt: START + 45, offset: 700, heading: 70, speed: 60, altitude: 640 }, START - 60, START + DURATION + 4, 2), listener)!;

function recording(extra: { tone?: number } = {}) {
  return synthesize({
    start: START,
    duration: DURATION,
    sampleRate: RATE,
    air: STANDARD_AIR,
    sources: [{ track, f0: F0, harmonics: [1, 0.6, 0.4], level: 1.2 }],
    noise: 1,
    rumble: 1,
    hum: extra.tone ? [{ freq: extra.tone, level: 1 }] : [],
    seed: 7,
  });
}

/** The heard fundamental every 0.1 s, as a detector or the matcher would give it, `offHz` off. */
function curveOf(offHz = 0): Curve {
  const times: number[] = [];
  const freq: number[] = [];
  for (let t = 0; t <= DURATION; t += 0.1) {
    const h = heardAt(track, START + t, STANDARD_AIR);
    times.push(t);
    freq.push(h ? F0 * h.factor + offHz : NaN);
  }
  return { times, freq };
}

async function scoreOf(samples: Float32Array) {
  const verdict = await matchAll(buildStack(samples, RATE), START, [{ id: "target", track, meta: null }], STANDARD_AIR, { f0Min: 40, f0Max: 400 });
  return verdict.ranked[0]?.score ?? 0;
}

/** A second-order Butterworth high-pass (RBJ biquad). */
function highPass(x: Float32Array, freq: number): Float32Array {
  const w = (2 * Math.PI * freq) / RATE;
  const alpha = Math.sin(w) / Math.SQRT2;
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const [b0, b1, b2] = [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0];
  const [a1, a2] = [(-2 * cos) / a0, (1 - alpha) / a0];
  const y = new Float32Array(x.length);
  let [x1, x2, y1, y2] = [0, 0, 0, 0];
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    [x2, x1, y2, y1] = [x1, x[i], y1, v];
    y[i] = v;
  }
  return y;
}

/** Power of a steady tone at `freq` in the samples, by correlation. */
function tonePower(samples: Float32Array, freq: number) {
  let c = 0;
  let s = 0;
  for (let i = 0; i < samples.length; i++) {
    c += samples[i] * Math.cos((2 * Math.PI * freq * i) / RATE);
    s += samples[i] * Math.sin((2 * Math.PI * freq * i) / RATE);
  }
  return (c * c + s * s) / samples.length ** 2;
}

describe("scrub", () => {
  it("takes the plane out: the matcher that named it no longer finds it", async () => {
    const raw = recording();
    const before = await scoreOf(raw);
    expect(before).toBeGreaterThan(POSSIBLE.score);
    const after = await scoreOf(scrub(raw, RATE, [curveOf()]));
    // Noise alone peaks around 3 to 4 (lib/core/match.ts).
    expect(after).toBeLessThan(4.5);
  });

  it("still takes it out when the curve is a little off, as a detected one is", async () => {
    const after = await scoreOf(scrub(recording(), RATE, [curveOf(1.2)]));
    expect(after).toBeLessThan(4.5);
  });

  it("does what a high-pass filter cannot: after one, the matcher still names the plane", async () => {
    // Two cascaded Butterworth sections at 300 Hz, 24 dB per octave: the curve sits 2 octaves down.
    let x = recording();
    for (let pass = 0; pass < 2; pass++) x = highPass(x, 300);
    expect(await scoreOf(x)).toBeGreaterThan(POSSIBLE.score);
  });

  it("leaves the rest of the sound: a steady tone away from the curve keeps its level", () => {
    // Midway between the fundamental's highest pitch and its second harmonic's lowest.
    const heard = Array.from(curveOf().freq).filter(Number.isFinite);
    const tone = (Math.max(...heard) + 2 * Math.min(...heard)) / 2;
    expect(2 * Math.min(...heard) - tone).toBeGreaterThan(15);
    const raw = recording({ tone });
    const kept = tonePower(scrub(raw, RATE, [curveOf()]), tone) / tonePower(raw, tone);
    expect(kept).toBeGreaterThan(0.9);
    expect(kept).toBeLessThan(1.1);
  });

  it("fills the band it empties: no dark trail along the curve, even scrubbed again", async () => {
    const raw = recording();
    const curve = curveOf();
    // Mean evidence along the curve `offHz` off, where it is heard.
    const along = (samples: Float32Array, offHz: number) => {
      const { base, evidence } = buildStack(samples, RATE);
      const hop = base.times[1] - base.times[0];
      let sum = 0;
      let n = 0;
      for (let i = 0; i < curve.times.length; i++) {
        const k = Math.round((curve.times[i] - base.times[0]) / hop);
        if (!Number.isFinite(curve.freq[i]) || k < 0 || k >= base.frames) continue;
        sum += evidence[k * base.bins + Math.round((curve.freq[i] + offHz - base.minHz) / base.binHz)];
        n++;
      }
      return sum / n;
    };
    const hollow = scrub(raw, RATE, [curve], { fill: false });
    const filled = scrub(raw, RATE, [curve]);
    const twice = scrub(filled, RATE, [curveOf(0.6)]);
    // The notch alone leaves a hollow the shape of the curve: the line is gone, its trail is not.
    expect(along(hollow, 0)).toBeLessThan(-2);
    // Filled, the band and its shoulders sit where the sound 12 Hz away does, a second time too.
    for (const x of [filled, twice]) for (const d of [-4, 0, 4]) expect(Math.abs(along(x, d) - along(x, 12))).toBeLessThan(0.5);
    expect(await scoreOf(twice)).toBeLessThan(4.5);
  });

  it("changes nothing where the curve is not heard", () => {
    const raw = recording();
    const half: Curve = { times: [0, 30, 30.1, DURATION], freq: [NaN, NaN, NaN, NaN] };
    expect(Array.from(scrub(raw, RATE, [half]))).toEqual(Array.from(raw));
  });
});
