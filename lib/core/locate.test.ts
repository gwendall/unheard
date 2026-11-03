import { describe, expect, it } from "vitest";
import type { Poll } from "../adsb";
import { heardAt, STANDARD_AIR } from "./doppler";
import { fromLocal, type Listener } from "./geo";
import { locate, offsetOf, shiftTrack } from "./locate";
import type { Recording } from "./pipeline";
import { flybyFixes, synthesize, type Flyby } from "./synth";
import { buildTrack, stateAt, type Fix } from "./track";

const truth: Listener = { lat: 43.6, lon: 1.44, elevation: 150 };
const START = 1_800_000_000;
const DURATION = 60;
const RATE = 8000;
const FT = 0.3048;
const KT = 1852 / 3600;

/** What the server would have polled: every 2 s, the fixes as readsb fields. */
function pollsOf(hex: string, fixes: Fix[]): Poll[] {
  return fixes.map((f) => ({
    now: f.t * 1000,
    aircraft: [
      {
        hex,
        lat: f.lat,
        lon: f.lon,
        alt_geom: f.altitude / FT,
        gs: Math.hypot(f.velocity[0], f.velocity[1]) / KT,
        track: ((Math.atan2(f.velocity[0], f.velocity[1]) * 180) / Math.PI + 360) % 360,
        geom_rate: (f.velocity[2] / FT) * 60,
      },
    ],
  }));
}

function recordingOf(flyby: Flyby, seed: number): Recording {
  const fixes = flybyFixes(truth, flyby, START - 60, START + DURATION + 20, 2);
  const track = buildTrack(flybyFixes(truth, flyby, START - 60, START + DURATION + 20, 0.5), truth, { smooth: false })!;
  const samples = synthesize({ start: START, duration: DURATION, sampleRate: RATE, air: STANDARD_AIR, sources: [{ track, f0: 96, harmonics: [1, 0.6, 0.4], level: 0.4 }], noise: 1, rumble: 1, seed });
  return { samples, sampleRate: RATE, start: START, listener: truth, air: STANDARD_AIR, polls: pollsOf("abc123", fixes) };
}

describe("shiftTrack", () => {
  it("is the track built around the other point, without building it again", () => {
    const flyby: Flyby = { closestAt: START + 30, offset: 800, heading: 40, speed: 70, altitude: 900, turnRate: 0.5 };
    const fixes = flybyFixes(truth, flyby, START - 60, START + 90, 2);
    const there = fromLocal(truth, 6000, 4500);
    // Unsmoothed, the two are the same to the micrometre.
    const raw = shiftTrack(buildTrack(fixes, truth, { smooth: false })!, 6000, 4500, truth.lat);
    buildTrack(fixes, { ...there, elevation: truth.elevation }, { smooth: false })!.points.forEach((q, i) => q.p.forEach((x, j) => expect(Math.abs(x - raw.points[i].p[j])).toBeLessThan(1e-6)));
    // Smoothed, within a metre.
    const rebuilt = buildTrack(fixes, { ...there, elevation: truth.elevation })!;
    const shifted = shiftTrack(buildTrack(fixes, truth)!, 6000, 4500, truth.lat);
    for (let t = START - 30; t <= START + 80; t += 7.3) {
      const a = stateAt(rebuilt, t)!;
      const b = stateAt(shifted, t)!;
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(a.p[i] - b.p[i]), `p[${i}] at ${t - START}`).toBeLessThan(1);
        expect(Math.abs(a.v[i] - b.v[i]), `v[${i}] at ${t - START}`).toBeLessThan(0.1);
      }
      const ha = heardAt(rebuilt, t, STANDARD_AIR);
      const hb = heardAt(shifted, t, STANDARD_AIR);
      expect(hb === null).toBe(ha === null);
      // 0.02 %, a seventh of the evidence map's tolerance: the smoother reconciles the frame's
      // stretched east and curved up with the reported velocities a little differently there.
      if (ha && hb) expect(Math.abs(ha.factor - hb.factor)).toBeLessThan(2e-4);
    }
  });
});

describe("locate", () => {
  // A small square around the truth keeps the test quick; the eval searches the full 20 km.
  const area = { ...fromLocal(truth, 900, -700), side: 4000 };
  const options = { steps: [250, 50, 25], clockSpread: 0.5 };
  const dist = (p: { e: number; n: number }, q: [number, number]) => Math.hypot(p.e - q[0], p.n - q[1]);

  it("finds the spot of a straight flyby, and its mirror across the track", async () => {
    // Straight and level, 600 m to the side: the curve is the same from the other side.
    const flyby: Flyby = { closestAt: START + 30, offset: 600, heading: 70, speed: 60, altitude: 600 };
    const loc = await locate(recordingOf(flyby, 5), area, options);
    expect(loc.traces.length).toBeGreaterThan(0);
    const here = offsetOf(area, truth.lat, truth.lon);
    // The aircraft passes 600 m to the side (towards cos h, -sin h): the mirror of the truth is
    // 1200 m that way, on the far side of the track.
    const h = (70 * Math.PI) / 180;
    const twin: [number, number] = [here[0] + 1200 * Math.cos(h), here[1] - 1200 * Math.sin(h)];
    const best = loc.spots[0];
    expect(best.aircraft).toBe("abc123");
    expect(Math.min(dist(best, here), dist(best, twin)), `best at ${best.e.toFixed(0)}, ${best.n.toFixed(0)}`).toBeLessThan(120);
    expect(loc.mirror, "a mirror spot").not.toBeNull();
    const other = dist(best, here) < dist(best, twin) ? twin : here;
    expect(dist(loc.mirror!, other)).toBeLessThan(120);
    // Both explain the sound about as well.
    expect(Math.abs(loc.mirror!.score - best.score)).toBeLessThan(2);
    expect(loc.grid.logLik.length).toBe(loc.grid.size * loc.grid.size);
  });

  it("tells the two sides apart when the aircraft turns", async () => {
    const flyby: Flyby = { closestAt: START + 30, offset: 600, heading: 70, speed: 60, altitude: 600, turnRate: 2 };
    const loc = await locate(recordingOf(flyby, 6), area, options);
    const here = offsetOf(area, truth.lat, truth.lon);
    const best = loc.spots[0];
    expect(dist(best, here), `best at ${best.e.toFixed(0)}, ${best.n.toFixed(0)}`).toBeLessThan(120);
    if (loc.mirror) expect(loc.mirror.loss).toBeGreaterThan(best.loss);
  });
});
