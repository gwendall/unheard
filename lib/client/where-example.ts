import { encodeWav } from "../bundle";
import { STANDARD_AIR } from "../core/doppler";
import { ANALYSIS_RATE } from "../core/pipeline";
import { synthesize, type Source } from "../core/synth";
import { buildTrack, type Fix } from "../core/track";
import made from "./where-example.json";

// The file of /example: a simulated recording, made in the browser, of real flights (adsb.lol, ODbL
// 1.0) passing a public spot (scripts/make-where-example.ts). Only the sound is made up. It then goes
// through the page like any file: the same search on the same archive, under the same rule.

/** Hiss and rumble under the planes: as in the end-to-end tests' scene, a little cleaner per hertz than any outdoor recording. */
const NOISE = 0.3;
/** Each aircraft its own pitch, as in the end-to-end tests' scene: no two curves cross. */
const PITCHES = [92, 118, 147, 171, 203];

export function whereExampleWav(): Uint8Array {
  const sources: Source[] = made.tracks.map((fixes, i) => {
    const track = buildTrack(fixes as Fix[], made.spot);
    if (!track) throw new Error("the example has a track with no point");
    return { track, f0: PITCHES[i % PITCHES.length], level: 0.2 };
  });
  const samples = synthesize({ start: made.start, duration: made.duration, sampleRate: ANALYSIS_RATE, air: STANDARD_AIR, sources, noise: NOISE, rumble: NOISE, seed: 11 });
  return encodeWav(samples, ANALYSIS_RATE);
}
