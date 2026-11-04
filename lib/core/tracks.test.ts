import { describe, expect, it } from "vitest";
import { KIND, type Flight } from "../history";
import { heardAt, pathSpeed } from "./doppler";
import type { Segment } from "./flyby";
import { fromLocal, toLocal } from "./geo";
import { fixAt } from "./guess";
import type { Stack } from "./spectrogram";
import type { Trace } from "./trace";
import { buildTrack } from "./track";
import { BIN, FLOOR, joinFits, pathsOf, scanTracks, surprise, toneOf, worthOf, type Fits, type Scan, type Tone } from "./tracks";
import { whereWhen, type BestSoFar } from "./wherewhen";

const air = { groundTempC: 15 };
const c = pathSpeed(air, 300);
const centre = { lat: 37.7, lon: -121.8, elevation: 0 };
const start = 1_779_000_000;
/** The recording's spot, 6 km east and 4 km north of the square's centre. */
const spot = fromLocal(centre, 6000, 4000);
const listener = { ...spot, elevation: 0 };
const window: [number, number] = [start - 1800, start + 1800];
const ground = () => 0;
const options = { half: 25_000, window, ground, c, maxRange: 10_000 };

/** A flight from a path in the spot's frame: east and north at each second, a speed in m/s. */
function flightOf(hex: string, seconds: number, at: (t: number) => { e: number; n: number; up: number; ve: number; vn: number }): Flight {
  const t = Float64Array.from({ length: seconds }, (_, i) => start - 300 + i);
  const states = Array.from(t, (ti) => at(ti - start));
  const ll = states.map((s) => fromLocal(listener, s.e, s.n));
  return {
    hex,
    kind: KIND.piston,
    type: "C172",
    registration: hex,
    t,
    lat: Float64Array.from(ll, (p) => p.lat),
    lon: Float64Array.from(ll, (p) => p.lon),
    altFt: Float64Array.from(states, (s) => s.up / 0.3048),
    gs: Float32Array.from(states, (s) => (Math.hypot(s.ve, s.vn) * 3600) / 1852),
    track: Float32Array.from(states, (s) => ((Math.atan2(s.ve, s.vn) * 180) / Math.PI + 360) % 360),
    vrate: new Float32Array(seconds),
    flags: new Uint8Array(seconds),
  };
}

/** Straight east at 60 m/s, 600 m up, passing `north` metres north of the spot at second `tc`. */
const straight = (hex: string, north: number, tc: number) => flightOf(hex, 900, (t) => ({ e: 60 * (t - tc), n: north, up: 600, ve: 60, vn: 0 }));

/** A wide circle 7 km north of the spot, 3 degrees a second at 70 m/s: far, yet its tone falls fast. */
const circling = (hex: string) =>
  flightOf(hex, 900, (t) => {
    const w = (3 * Math.PI) / 180;
    const r = 70 / w;
    return { e: r * Math.sin(w * t), n: 7000 + r * Math.cos(w * t), up: 800, ve: 70 * Math.cos(w * t), vn: -70 * Math.sin(w * t) };
  });

/** The tone heard at the spot from a flight (120 Hz at rest), whole seconds of the file. */
function toneHeard(trace: number, f: Flight, from: number, to: number): Tone {
  const fixes = Array.from(f.t, (_, j) => fixAt(f, j));
  const track = buildTrack(fixes, listener)!;
  const times: number[] = [];
  const logs: number[] = [];
  for (let s = from; s <= to; s++) {
    const h = heardAt(track, start + s, air);
    if (!h) continue;
    times.push(s);
    logs.push(Math.log(120 * h.factor));
  }
  return toneOf(trace, Float64Array.from(times), Float64Array.from(logs), false, c);
}

const localSpot = toLocal(centre, spot.lat, spot.lon, 0);

/** Fits within `metres` and `seconds` of the truth, and the best loss among them. */
function nearTruth(f: Fits, metres: number, seconds: number) {
  let n = 0;
  let best = Infinity;
  for (let i = 0; i < f.n; i++) {
    if (Math.hypot(f.x[i] - localSpot[0], f.y[i] - localSpot[1]) > metres || Math.abs(f.start[i] - start) > seconds) continue;
    n++;
    best = Math.min(best, f.loss[i]);
  }
  return { n, best };
}

const scanOf = (tones: Tone[], flights: Flight[]): Promise<Scan> => scanTracks(tones, pathsOf(flights, centre, window[0] - 120, window[1] + 400), flights, options);

describe("the scan of real tracks", () => {
  it("finds a straight pass where it was heard, both mirrors of it", async () => {
    const f = straight("a00001", 800, 100);
    const scan = await scanOf([toneHeard(0, f, 70, 130)], [f]);
    const near = nearTruth(scan.fits[0], 300, 8);
    expect(near.n).toBeGreaterThan(0);
    expect(near.best).toBeLessThan(0.2);
    // The mirror, across the track, fits as well.
    let mirror = Infinity;
    const list = scan.fits[0];
    for (let i = 0; i < list.n; i++) if (Math.hypot(list.x[i] - localSpot[0], list.y[i] - (localSpot[1] + 1600)) < 300) mirror = Math.min(mirror, list.loss[i]);
    expect(mirror).toBeLessThan(0.2);
  });

  it("finds a flight turning far away, which a straight pass cannot explain", async () => {
    const f = circling("a00002");
    const scan = await scanOf([toneHeard(0, f, 60, 90)], [f]);
    const near = nearTruth(scan.fits[0], 800, 8);
    expect(near.n).toBeGreaterThan(0);
    expect(near.best).toBeLessThan(0.2);
  });

  it("makes a fit that is rare worth more than one any flight gives", async () => {
    const f = straight("a00003", 500, 100);
    const scan = await scanOf([toneHeard(0, f, 70, 130)], [f]);
    expect(surprise(scan.rate[0], 0.05)).toBeGreaterThan(surprise(scan.rate[0], 0.45));
    expect(worthOf(scan, 0, 0.05)).toBeCloseTo(surprise(scan.rate[0], 0.05) - FLOOR);
    expect(worthOf(scan, 0, 1)).toBe(0);
    expect(surprise(scan.rate[0], 0.05)).toBeGreaterThan(5);
    expect(scan.rate[0][Math.floor(0.45 / BIN)]).toBeLessThan(1);
  });
});

describe("the join", () => {
  it("puts the spot and start two flyovers share first, ahead of a fit of one alone", async () => {
    // Not parallel: two parallel tracks at one speed would let spot and start slide together.
    const a = straight("a00004", 800, 100);
    const b = flightOf("a00005", 900, (t) => ({ e: 1500, n: 50 * (t - 400), up: 500, ve: 0, vn: 50 }));
    const tones = [toneHeard(0, a, 70, 130), toneHeard(1, b, 370, 450)];
    const decoy = straight("a00006", 3000, 500);
    const flights = [a, b, decoy];
    const scan = await scanOf(tones, flights);
    // Read exactly as the search would: here, how near the seed is to the true spot and start.
    const read = (_: number, __: number, x: number, y: number, s: number) => ({ loss: Math.hypot(x - localSpot[0], y - localSpot[1]) / 5000 + Math.abs(s - start) / 100, clock: 0 });
    const seeds = joinFits(scan, options.half, window, 50_000, 30_000, 100, read);
    const best = seeds[0];
    expect(Math.hypot(best.x - localSpot[0], best.y - localSpot[1])).toBeLessThan(1500);
    expect(Math.abs(best.start - start)).toBeLessThan(30);
  });
});

describe("whereWhen from the real tracks", () => {
  /** A tone as a blind trace: every quarter second of the file, heard from a flight at the spot. */
  function traceOf(f: Flight, from: number, to: number) {
    const track = buildTrack(Array.from(f.t, (_, j) => fixAt(f, j)), listener)!;
    const times = Float64Array.from({ length: 4 * 500 }, (_, i) => i / 4);
    const freq = Float32Array.from(times, (s) => {
      const h = s >= from && s <= to ? heardAt(track, start + s, air) : null;
      return h ? 120 * h.factor : NaN;
    });
    const trace = { from: 4 * from, to: 4 * to, freq, confidence: 10 } as unknown as Trace;
    return { times, trace };
  }

  it("names the spot and start two flyovers agree on, with a day to search", async () => {
    const a = straight("a00007", 800, 100);
    const b = flightOf("a00008", 900, (t) => ({ e: 1500, n: 50 * (t - 400), up: 500, ve: 0, vn: 50 }));
    const [ta, tb] = [traceOf(a, 70, 130), traceOf(b, 370, 450)];
    const stack = { base: { times: ta.times } } as unknown as Stack;
    const segments: Segment[] = [{ stack, offset: 0, traces: [ta.trace, tb.trace] }];
    const decoys = [straight("a00009", 3000, 500), straight("a0000a", -4000, 200)];
    const stages = new Set<string>();
    const bests: BestSoFar[] = [];
    const ww = await whereWhen(segments, [a, b, ...decoys], {
      window,
      area: { lat: centre.lat, lon: centre.lon, side: 50_000 },
      air,
      refine: 0,
      onProgress: (stage) => stages.add(stage),
      onBest: (b) => bests.push(b),
    });
    const best = ww.hypotheses[0];
    // The search says how far it is, and its best guess before the end, the last one the answer's.
    for (const stage of ["shape", "smooth", "coarse"]) expect(stages.has(stage)).toBe(true);
    expect(bests[0].stage).toBe("coarse");
    const last = bests[bests.length - 1];
    expect(last.stage).toBe("joint");
    expect(Math.hypot(...toLocal(listener, last.lat, last.lon, 0).slice(0, 2))).toBeLessThan(1000);
    expect(Math.abs(last.start - start)).toBeLessThan(20);
    const away = toLocal(listener, best.lat, best.lon, 0);
    expect(Math.hypot(away[0], away[1])).toBeLessThan(1000);
    expect(Math.abs(best.start - start)).toBeLessThan(20);
    expect(new Set(best.reads.map((r) => r.f)).size).toBe(2);
    expect(best.worth).toBeGreaterThan(5);
  });
});
