import { describe, expect, it } from "vitest";
import { heardAt, pathSpeed, STANDARD_AIR } from "../core/doppler";
import { toLocal, type Listener } from "../core/geo";
import { ANALYSIS_RATE } from "../core/pipeline";
import { computeSpectrogram } from "../core/spectrogram";
import { flybyFixes } from "../core/synth";
import { fit, gainFor, kindOf, loudness, motionOf, MIX, parseCoords, plant, planesOf, planScene } from "./elsewhere";
import { fabricatePolls, type Actor } from "./fabricate";

const centre: Listener = { lat: 37.9755, lon: 23.7348, elevation: 70 };
const T = 1_800_000_000;

// A Cessna crossing 2 km south of the centre, an airliner far above.
const actors: Actor[] = [
  { meta: { hex: "468abc", callsign: "SXABC", type: "C172", category: "A1" }, flyby: { closestAt: T - 20, offset: 2000, heading: 90, speed: 55, altitude: 70 + 600 } },
  { meta: { hex: "4691aa", callsign: "AEE3KZ", type: "A320", category: "A3" }, flyby: { closestAt: T + 100, offset: 9000, heading: 200, speed: 220, altitude: 10_500 } },
];
// The page's polls: three, 3 s apart, the last at T.
const live = fabricatePolls(centre, actors, T - 6, T, 3);

/** A voice note stand-in: hiss and a tone that comes and goes, RMS about 0.06. */
function voice(seconds: number, rate: number, hiss = 0.002): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  let s = 7;
  const noise = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    out[i] = hiss * noise() + 0.08 * Math.sin(2 * Math.PI * 180 * t) * (Math.sin(2 * Math.PI * 3 * t) > 0 ? 1 : 0) + 0.03 * Math.sin(2 * Math.PI * 360 * t);
  }
  return out;
}

describe("motionOf", () => {
  it("follows a straight flight a minute either side of its last poll", () => {
    const truth = flybyFixes(centre, { closestAt: T, offset: 1500, heading: 40, speed: 60, altitude: 900 }, T - 120, T + 120, 1);
    const at = motionOf(truth.filter((f) => f.t >= T - 6 && f.t <= T), centre);
    for (const want of truth.filter((f) => Math.abs(f.t - T) <= 60 && f.t % 10 === 0)) {
      const got = at(want.t);
      const [e1, n1] = toLocal(centre, got.lat, got.lon, 0);
      const [e2, n2] = toLocal(centre, want.lat, want.lon, 0);
      expect(Math.hypot(e1 - e2, n1 - n2)).toBeLessThan(2);
      expect(got.altitude).toBeCloseTo(want.altitude, 3);
    }
  });

  it("keeps up the turn the polls show", () => {
    const truth = flybyFixes(centre, { closestAt: T, offset: 1500, heading: 40, speed: 60, altitude: 900, turnRate: 1.5 }, T - 60, T + 60, 1);
    const at = motionOf(truth.filter((f) => f.t >= T - 6 && f.t <= T), centre);
    const straight = motionOf(truth.filter((f) => f.t === T), centre);
    const want = truth.find((f) => f.t === T + 20)!;
    const miss = (got: { lat: number; lon: number }) => {
      const [e1, n1] = toLocal(centre, got.lat, got.lon, 0);
      const [e2, n2] = toLocal(centre, want.lat, want.lon, 0);
      return Math.hypot(e1 - e2, n1 - n2);
    };
    expect(miss(at(T + 20))).toBeLessThan(10);
    expect(miss(straight(T + 20))).toBeGreaterThan(150);
  });
});

describe("kindOf", () => {
  it("reads the type, then the category, then the speed", () => {
    expect(kindOf({ hex: "a", type: "EC35" }, 50)).toBe("helicopter");
    expect(kindOf({ hex: "a", type: "AT72" }, 120)).toBe("turboprop");
    expect(kindOf({ hex: "a", category: "A7" }, 40)).toBe("helicopter");
    expect(kindOf({ hex: "a", category: "A3" }, 80)).toBe("jet");
    expect(kindOf({ hex: "a" }, 200)).toBe("jet");
    expect(kindOf({ hex: "a" }, 60)).toBe("piston");
  });
});

describe("parseCoords", () => {
  it("reads latitude and longitude written either way", () => {
    expect(parseCoords("37.98, 23.73")).toEqual({ lat: 37.98, lon: 23.73 });
    expect(parseCoords("37,98; 23,73")).toEqual({ lat: 37.98, lon: 23.73 });
    expect(parseCoords(" -33.87 151.21 ")).toEqual({ lat: -33.87, lon: 151.21 });
    expect(parseCoords("51.5,-0.13")).toEqual({ lat: 51.5, lon: -0.13 });
    expect(parseCoords("95, 10")).toBeNull();
    expect(parseCoords("Athens")).toBeNull();
  });
});

describe("planScene", () => {
  const scene = planScene(live, centre, 40, STANDARD_AIR)!;

  it("puts the spot beside the low plane near the centre, not under the airliner", () => {
    expect(scene).not.toBeNull();
    expect(scene.planted[0].meta.hex).toBe("468abc");
    expect(scene.offset.distance).toBeLessThan(8000);
    const p = scene.planted[0];
    // About as far to the side as it is high, heard within the clip with the right delay.
    expect(p.closest.range).toBeGreaterThan(600);
    expect(p.closest.range).toBeLessThan(1200);
    expect(p.closest.at).toBeGreaterThan(scene.start + 5);
    expect(p.closest.at).toBeLessThan(scene.start + 35);
    expect(p.closest.delay).toBeCloseTo(p.closest.range / pathSpeed(STANDARD_AIR, p.closest.height), 1);
  });

  it("keeps the clip on the polls when it can, and moves it back when the plane has gone", () => {
    expect(scene.shift).toBe(0);
    // A helicopter that flew over the centre 150 s ago is 9 km north now: the clip goes back.
    const gone: Actor = { meta: { hex: "4692cc", type: "EC35", category: "A7" }, flyby: { closestAt: T - 150, offset: 300, heading: 0, speed: 60, altitude: 70 + 400 } };
    const earlier = planScene(fabricatePolls(centre, [gone], T - 6, T, 3), centre, 40, STANDARD_AIR)!;
    expect(earlier.shift).toBeGreaterThanOrEqual(20);
    expect(earlier.shift).toBeLessThanOrEqual(120);
    expect(earlier.planted[0].closest.range).toBeLessThan(1000);
    expect(earlier.offset.distance).toBeLessThan(8000);
  });

  it("hands analyze() every flight every 2 s over the clip, the airliner too", () => {
    expect(scene.polls[0].now / 1000).toBeLessThanOrEqual(scene.start - 48);
    expect(scene.polls.at(-1)!.now / 1000).toBeGreaterThanOrEqual(scene.start + 38);
    expect(new Set(scene.polls.flatMap((p) => p.aircraft.map((a) => a.hex)))).toEqual(new Set(["468abc", "4691aa"]));
  });

  it("never picks a flight with a twin beside it, which would draw the same curve", () => {
    // The Cessna again as a TIS-B copy 200 m off, and a Piper alone, higher and 6.5 km north.
    const copy: Actor = { meta: { hex: "~26b1a3", category: "A1" }, flyby: { ...actors[0].flyby, offset: 2200 } };
    const alone: Actor = { meta: { hex: "4693dd", type: "PA28", category: "A1" }, flyby: { closestAt: T - 10, offset: -6500, heading: 270, speed: 50, altitude: 70 + 1000 } };
    const s = planScene(fabricatePolls(centre, [...actors, copy, alone], T - 6, T, 3), centre, 40, STANDARD_AIR)!;
    expect(s.planted[0].meta.hex).toBe("4693dd");
  });

  it("finds nothing when every flight is too high", () => {
    expect(planScene(fabricatePolls(centre, [actors[1]], T - 6, T, 3), centre, 40, STANDARD_AIR)).toBeNull();
  });

  it("another seed, another side of the path", () => {
    // South of its path or north of it: 2 km south of the centre is 0.018 degrees.
    const sides = new Set([1, 2, 3, 4, 5, 6].map((seed) => planScene(live, centre, 40, STANDARD_AIR, { seed })!.spot.lat > centre.lat - 0.018));
    expect(sides.size).toBe(2);
  });
});

describe("the planted sound", () => {
  const scene = planScene(live, centre, 40, STANDARD_AIR)!;
  const p = scene.planted[0];

  it("hums along the Doppler curve heardAt draws, from the spot", () => {
    const planes = planesOf(scene, ANALYSIS_RATE, 40 * ANALYSIS_RATE, 1, 0);
    const spec = computeSpectrogram(planes, ANALYSIS_RATE, { windowSeconds: 1, hopSeconds: 1, minHz: p.f0 * 0.7, maxHz: p.f0 * 1.3 });
    for (const k of [3, 10, 30, 36]) {
      let top = 0;
      for (let b = 1; b < spec.bins; b++) if (spec.db[k * spec.bins + b] > spec.db[k * spec.bins + top]) top = b;
      const want = p.f0 * heardAt(p.track, scene.start + spec.times[k], STANDARD_AIR)!.factor;
      expect(Math.abs(spec.minHz + top * spec.binHz - want)).toBeLessThan(2);
    }
    // Higher while it comes, lower once it has passed.
    expect(heardAt(p.track, scene.start + 2, STANDARD_AIR)!.factor).toBeGreaterThan(1.05);
    expect(heardAt(p.track, scene.start + 38, STANDARD_AIR)!.factor).toBeLessThan(0.95);
  });

  it("falls with distance", () => {
    const planes = planesOf(scene, ANALYSIS_RATE, 40 * ANALYSIS_RATE, 1, 0);
    const at = (t: number) => loudness(planes.subarray((t - scene.start) * ANALYSIS_RATE, (t - scene.start + 1) * ANALYSIS_RATE));
    const near = Math.round(p.closest.at);
    const range = (t: number) => heardAt(p.track, t, STANDARD_AIR)!.range;
    const want = range(scene.start + 1.5) / range(near + 0.5);
    expect(want).toBeGreaterThan(1.5);
    expect(Math.abs(at(near) / at(scene.start + 1) / want - 1)).toBeLessThan(0.15);
  });

  it("sits far under the voice, and the mix is the voice plus the planes", () => {
    const rate = 16_000;
    const v = voice(40, rate);
    const gain = gainFor(v, rate, scene);
    const out = plant(v, rate, scene, gain);
    const planes = planesOf(scene, rate, v.length, gain);
    expect(out.length).toBe(v.length);
    for (const i of [0, 1234, 300_000, v.length - 1]) expect(out[i]).toBeCloseTo(v[i] + planes[i], 6);
    expect(20 * Math.log10(loudness(planes) / loudness(v))).toBeLessThanOrEqual(-MIX.under + 0.01);
  });

  it("is louder over a noisier background, for the same mark on the spectrogram", () => {
    const quiet = voice(40, ANALYSIS_RATE);
    const noisy = voice(40, ANALYSIS_RATE, 0.02);
    expect(gainFor(noisy, ANALYSIS_RATE, scene, 10)).toBeGreaterThan(gainFor(quiet, ANALYSIS_RATE, scene, 10));
  });

  it("is named by Unheard's own analysis at the spot, as faint as that allows", async () => {
    const found = await fit(voice(40, ANALYSIS_RATE), scene);
    expect(found.analysis.verdict.kind).toBe("strong");
    expect(found.analysis.verdict.best?.id).toBe("468abc");
    // Where the matcher puts the plane at its closest is where the scene put it.
    const best = found.analysis.verdict.best!;
    expect(best.closest!.range).toBeCloseTo(p.closest.range, -2);
    expect(Math.abs(best.clock)).toBeLessThanOrEqual(1);
  }, 60_000);
});
