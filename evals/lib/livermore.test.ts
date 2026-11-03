import { describe, expect, it } from "vitest";
import { fromLocal, type Listener } from "../../lib/core/geo";
import { alignRidge, nNumberToIcao, placeRecorders, pollsOf, readKml, trilaterate, type Passage, type TrackPoint } from "./livermore";

describe("nNumberToIcao", () => {
  it("gives the FAA's addresses", () => {
    // Checked against adsbdb.com: the first four are aircraft of the Livermore set.
    expect(nNumberToIcao("N86LP")).toBe("abcd86");
    expect(nNumberToIcao("N4040")).toBe("a4bdd5");
    expect(nNumberToIcao("N7RR")).toBe("a95163");
    expect(nNumberToIcao("N958JX")).toBe("ad533d");
    expect(nNumberToIcao("N1")).toBe("a00001");
    expect(nNumberToIcao("N99999")).toBe("adf7c7");
    expect(() => nNumberToIcao("G-ABCD")).toThrow();
  });
});

describe("readKml", () => {
  it("reads a gx:Track, drops repeats and ground points", () => {
    const kml = `<gx:Track ><when >2026-05-17T20:00:00.000Z</when><when >2026-05-17T20:00:00.000Z</when><when >2026-05-17T20:00:05.500Z</when><when >2026-05-17T20:00:09.000Z</when>
      <gx:coord >-121.9 37.6 0</gx:coord><gx:coord >-121.9 37.6 0</gx:coord><gx:coord >-121.8 37.7 500.5</gx:coord><gx:coord >-121.7 37.71 510</gx:coord></gx:Track>`;
    const pts = readKml(kml);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ t: Date.parse("2026-05-17T20:00:05.500Z") / 1000, lat: 37.7, lon: -121.8, alt: 500.5 });
  });
});

const SITE: Listener = { lat: 37.66, lon: -121.78, elevation: 150 };

/** A straight pass at 60 m/s, `offset` metres beside the site at its closest, `height` above it, at t = 1000 + 100 k. */
function pass(k: number, heading: number, offset: number, height: number, site = SITE): Passage {
  const h = (heading * Math.PI) / 180;
  const [ux, uy] = [Math.sin(h), Math.cos(h)];
  const tc = 1000 + 100 * k;
  const track: TrackPoint[] = [];
  for (let s = -120; s <= 120; s += 5) {
    const e = ux * 60 * s + uy * offset;
    const n = uy * 60 * s - ux * offset;
    const { lat, lon } = fromLocal(site, e, n);
    track.push({ t: tc + s, lat, lon, alt: site.elevation + height });
  }
  return { id: `P${k}`, registration: "N1", hex: "a00001", category: "", dir: new URL("file:///nowhere/"), track, ridge: [{ t: tc - 20, f: 120 }, { t: tc + 20, f: 100 }], offset, height, slant: Math.hypot(offset, height) };
}

describe("trilaterate", () => {
  it("finds the one point at every track's published distance", () => {
    const passages = [pass(0, 10, 400, 800), pass(1, 95, 1200, 1500), pass(2, 200, 250, 600), pass(3, 290, 2000, 900), pass(4, 45, 800, 1100)];
    const site = trilaterate(passages, { lat: 37.68, lon: -121.77 });
    expect(Math.abs(site.lat - SITE.lat) * 111_132).toBeLessThan(1);
    expect(Math.abs(site.lon - SITE.lon) * 88_000).toBeLessThan(1);
    expect(site.elevation).toBeCloseTo(SITE.elevation, 0);
    for (const r of site.residuals.values()) expect(Math.abs(r)).toBeLessThan(1);
  });

  it("puts passages recorded elsewhere at their own site", () => {
    const west: Listener = { lat: 37.69, lon: -121.84, elevation: 110 };
    const main = [pass(0, 10, 400, 800), pass(1, 95, 1200, 1500), pass(2, 200, 250, 600), pass(3, 290, 2000, 900), pass(4, 45, 800, 1100)];
    const other = [pass(5, 30, 300, 500, west), pass(6, 140, 900, 700, west), pass(7, 260, 600, 400, west)];
    const placed = placeRecorders([...main, ...other]);
    expect(placed.get("P0")?.site).toBe("main");
    expect(placed.get("P6")?.site).toBe("second");
    expect(Math.abs(placed.get("P6")!.listener.lon - west.lon) * 88_000).toBeLessThan(5);
  });
});

describe("pollsOf", () => {
  it("gives speed, heading and climb from the neighbouring points", () => {
    const p = pass(0, 90, 300, 1000);
    const polls = pollsOf([{ hex: "a00001", registration: "N1", track: p.track }], SITE, 990, 1010);
    // 5 s apart: 990 to 1010 and one point beyond each end.
    expect(polls.map((x) => x.now / 1000)).toEqual([985, 990, 995, 1000, 1005, 1010, 1015]);
    const a = polls[3].aircraft[0];
    expect(a.gs).toBeCloseTo(60 / (1852 / 3600), 0);
    expect(a.track).toBeCloseTo(90, 0);
    expect(a.geom_rate).toBe(0);
    expect(pollsOf([{ hex: "a00001", registration: "N1", track: p.track }], { ...SITE, lat: SITE.lat + 1 }, 990, 1010)).toEqual([]);
  });
});

describe("alignRidge", () => {
  it("finds the start that lays the ridge on the tone", () => {
    const rate = 8000;
    const duration = 30;
    const samples = new Float32Array(rate * duration);
    let phase = 0;
    let seed = 7;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    // A falling tone from 8 s to 22 s of the recording, in noise.
    const f = (a: number) => 300 - 80 * Math.tanh((a - 15) / 3);
    for (let i = 0; i < samples.length; i++) {
      const a = i / rate;
      phase += (2 * Math.PI * f(a)) / rate;
      samples[i] = (a > 8 && a < 22 ? 0.3 * Math.sin(phase) : 0) + noise();
    }
    const start = 1_779_000_000.37;
    const ridge = Array.from({ length: 70 }, (_, k) => 8 + k * 0.2).map((a) => ({ t: start + a, f: f(a) }));
    const found = alignRidge(samples, rate, ridge);
    expect(Math.abs(found.start - start)).toBeLessThan(0.15);
  });
});
