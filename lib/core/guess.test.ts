import { describe, expect, it } from "vitest";
import { KIND, type Flight } from "../history";
import { pathSpeed } from "./doppler";
import type { Segment } from "./flyby";
import { fromLocal } from "./geo";
import { readAt } from "./guess";
import type { Stack } from "./spectrogram";
import type { Trace } from "./trace";

const air = { groundTempC: 15 };
const listener = { lat: 37.7, lon: -121.8, elevation: 0 };
const start = 1_779_000_000;
/** A Cessna eastbound at 55 m/s, 450 m up, passing 400 m north of the listener 60 s in. */
const [v, north, up, tc] = [55, 400, 450, start + 60];

function cessna(): Flight {
  const n = 91;
  const t = Float64Array.from({ length: n }, (_, i) => tc + (i - 45) * 2);
  const at = Array.from(t, (ti) => fromLocal(listener, v * (ti - tc), north));
  return {
    hex: "a1b2c3",
    kind: KIND.piston,
    type: "C172",
    registration: "N12345",
    t,
    lat: Float64Array.from(at, (p) => p.lat),
    lon: Float64Array.from(at, (p) => p.lon),
    altFt: new Float64Array(n).fill(up / 0.3048),
    gs: new Float32Array(n).fill((v * 3600) / 1852),
    track: new Float32Array(n).fill(90),
    vrate: new Float32Array(n),
    flags: new Uint8Array(n),
  };
}

/** Its 92 Hz tone as heard, a trace every quarter second over the two minutes recorded. */
function heard(): Segment[] {
  const c = pathSpeed(air, up);
  const times = Float64Array.from({ length: 480 }, (_, i) => i / 4);
  const freq = times.map((s) => {
    let te = start + s;
    for (let i = 0; i < 50; i++) te = start + s - Math.hypot(v * (te - tc), north, up) / c;
    const along = v * (te - tc);
    return (92 * c) / (c + (v * along) / Math.hypot(along, north, up));
  });
  const trace = { from: 0, to: times.length - 1, freq, confidence: 1 } as unknown as Trace;
  return [{ stack: { base: { times } } as unknown as Stack, offset: 0, traces: [trace] }];
}

describe("readAt", () => {
  it("explains a tone by its aircraft at the right spot and start, and not elsewhere", () => {
    const segments = heard();
    const flights = [cessna()];
    const [right] = readAt(segments, flights, { ...listener, start }, { air });
    expect(right.hex).toBe("a1b2c3");
    expect(right.loss).toBeLessThan(0.05);
    expect(right.clock).toBe(0);
    const away = fromLocal(listener, 0, -3000);
    expect(readAt(segments, flights, { ...away, start }, { air })[0].loss).toBeGreaterThan(0.3);
    expect(readAt(segments, flights, { ...listener, start: start + 30 }, { air })[0].loss).toBeGreaterThan(0.3);
  });
});
