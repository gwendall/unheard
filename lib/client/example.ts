// The simulated example: a light plane passes 600 m from a listener in a field, under a few other
// aircraft, its hum far under the wind and the hiss. Made in the browser, analysed by the
// same analyze() as a real recording.

import { STANDARD_AIR } from "../core/doppler";
import type { Listener } from "../core/geo";
import { ANALYSIS_RATE, type Recording } from "../core/pipeline";
import { synthesize } from "../core/synth";
import { buildTrack } from "../core/track";
import { flybyFixes } from "../core/synth";
import { fabricatePolls, type Actor } from "./fabricate";

export const EXAMPLE_TARGET = "39ab12";

export function exampleActors(start: number, elevation: number): Actor[] {
  return [
    { meta: { hex: EXAMPLE_TARGET, callsign: "FGDEMO", registration: "F-GDEM", type: "C172", category: "A1" }, flyby: { closestAt: start + 48, offset: 420, heading: 115, speed: 56, altitude: elevation + 550, turnRate: 0.25 } },
    { meta: { hex: "3986f1", callsign: "SKY204", type: "A20N", category: "A3" }, flyby: { closestAt: start + 30, offset: 6500, heading: 250, speed: 120, altitude: elevation + 2300 } },
    { meta: { hex: "39c8b0", callsign: "HELI7", type: "EC35", category: "A7" }, flyby: { closestAt: start + 70, offset: -3200, heading: 20, speed: 55, altitude: elevation + 300 } },
    { meta: { hex: "4ca7d2", callsign: "JET881", type: "B738", category: "A3" }, flyby: { closestAt: start + 5, offset: 11000, heading: 300, speed: 200, altitude: 9500 } },
    { meta: { hex: "39a4e7", callsign: "CLUB3", type: "DR40", category: "A1" }, flyby: { closestAt: start + 85, offset: 2600, heading: 160, speed: 50, altitude: elevation + 750 } },
  ];
}

export function buildExample(now = Date.now() / 1000): Recording {
  const listener: Listener = { lat: 48.8556, lon: 2.2986, elevation: 160 };
  const start = Math.floor(now) - 100;
  const duration = 90;
  const actors = exampleActors(start, listener.elevation);
  const target = actors[0];
  const track = buildTrack(flybyFixes(listener, target.flyby, start - 30, start + duration + 4, 0.5), listener)!;
  const samples = synthesize({
    start,
    duration,
    sampleRate: ANALYSIS_RATE,
    air: STANDARD_AIR,
    sources: [{ track, f0: 92, level: 0.12 }],
    noise: 1,
    rumble: 1,
    hum: [{ freq: 50, level: 0.4 }],
    seed: 42,
  });
  // Polls every 2 s, from a little before the recording starts.
  const polls = fabricatePolls(listener, actors, start - 10, start + duration, 2);
  return { samples, sampleRate: ANALYSIS_RATE, start, listener, air: STANDARD_AIR, polls };
}
