// Real recordings: AeroSonicDB clips paired with ADS-B Exchange snapshots (evals/.cache/aerosonic,
// fetched by scripts/fetch-aerosonic.ts), the Livermore phone recordings with their ADS-B tracks
// (evals/.cache/livermore, scripts/fetch-livermore.ts), and capture bundles saved by the page in
// capture mode (evals/fixtures/real/*.json). All become Scenarios for the same analyze() as
// production.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Poll } from "../../lib/adsb";
import { recordingOf, decodeWav, type Bundle } from "../../lib/bundle";
import { ANALYSIS_RATE } from "../../lib/core/pipeline";
import { resample } from "../../lib/core/resample";
import { alignRidge, LIVERMORE, placeRecorders, pollsOf, readPassages, type TrackPoint } from "./livermore";
import type { Scenario } from "./sim";

type ClipMeta = {
  file: string;
  hex: string;
  type: string;
  engine: string;
  start: number;
  listener: { lat: number; lon: number; elevation: number };
  temperatureC: number;
  audible: { from: number; duration: number };
};

const CACHE = new URL("../.cache/aerosonic/clips/", import.meta.url);

/**
 * AeroSonicDB labels only the aircraft that triggered the recording. Others audible in a clip,
 * written down here with the reason. Assumed, not verified by ear.
 */
const ALSO_AUDIBLE: Record<string, { hex: string; why: string }> = {
  "7C3A50_2023-03-01_14-01-01": {
    hex: "7c23d1",
    why: "EC135 helicopter 2.6 km from the microphone at the clip start; its curve matches at 131 Hz, apart from the Bell 412's 169 Hz, and ranks second when the Bell is in the data.",
  },
};

/** AeroSonicDB clips as scenarios; with `missing`, the aircraft heard is taken out of the data. */
export function aerosonicScenarios(): Scenario[] {
  if (!existsSync(CACHE)) return [];
  const out: Scenario[] = [];
  for (const name of readdirSync(CACHE).sort()) {
    const dir = new URL(`${name}/`, CACHE);
    if (!existsSync(new URL("meta.json", dir)) || !existsSync(new URL("audio.wav", dir))) continue;
    const meta = JSON.parse(readFileSync(new URL("meta.json", dir), "utf8")) as ClipMeta;
    const polls = JSON.parse(readFileSync(new URL("polls.json", dir), "utf8")) as Poll[];
    const wav = decodeWav(new Uint8Array(readFileSync(new URL("audio.wav", dir))));
    const samples = resample(wav.samples, wav.sampleRate, ANALYSIS_RATE);
    const base = { samples, sampleRate: ANALYSIS_RATE, start: meta.start, listener: meta.listener, air: { groundTempC: meta.temperatureC } };
    const tags = { type: meta.type, engine: meta.engine };
    const other = ALSO_AUDIBLE[meta.file.slice(0, 26)];
    out.push({ id: `asdb-${meta.file.slice(0, 26)}`, kind: "heard", recording: { ...base, polls }, truth: { heard: meta.hex, alsoHeard: other ? [other.hex] : undefined }, tags, native: wav });
    const without = polls.map((p) => ({ now: p.now, aircraft: p.aircraft.filter((a) => a.hex !== meta.hex) }));
    // Without its aircraft, a clip must name nobody, unless another one was audible too.
    out.push({ id: `asdb-missing-${meta.file.slice(0, 26)}`, kind: other ? "heard" : "missing", recording: { ...base, polls: without }, truth: { heard: other?.hex ?? null }, tags: other ? { ...tags, note: "other aircraft audible" } : tags });
  }
  return out;
}

/**
 * The Livermore set names one aircraft per recording. Others audible in one, written down here
 * with the reason. Assumed from the data and the spectrogram, not verified by ear.
 */
const LIVERMORE_ALSO_AUDIBLE: Record<string, { hex: string; why: string }> = {
  N563FX_R21: {
    hex: "acade8",
    why: "N916KT, a Cessna 172S, flies straight at the recorder from 6.9 to 1.1 km (950 m up) during the recording: a steady prop tone near 85 Hz that rises as its ground speed goes from 95 to 110 kt and falls as it closes in, at the blade-pass of its own recording (R22, 79.5 Hz). The jet's line is at 0.5 to 1.2 kHz.",
  },
};

/**
 * The Livermore phone recordings (Pathak 2026, CC BY 4.0), one aircraft each. Every other
 * passage's aircraft flying within 40 km during a recording goes into its data too, as it would
 * in the page's polls: those are the candidates to beat. Each recording also runs with its
 * aircraft taken out (must name nobody), when at least one other aircraft is left to name.
 */
export function livermoreScenarios(): Scenario[] {
  const passages = readPassages();
  if (!passages.length) return [];
  const placed = placeRecorders(passages);
  // One track per aircraft: the same one can fly in several recordings.
  const flights = new Map<string, { hex: string; registration: string; track: TrackPoint[] }>();
  for (const p of passages) {
    const f = flights.get(p.hex) ?? { hex: p.hex, registration: p.registration, track: [] };
    const merged = [...f.track, ...p.track].sort((a, b) => a.t - b.t);
    f.track = merged.filter((x, i) => i === 0 || x.t - merged[i - 1].t > 0.05);
    flights.set(p.hex, f);
  }
  const weather = new URL("weather.json", LIVERMORE);
  const hourly = existsSync(weather) ? (JSON.parse(readFileSync(weather, "utf8")) as { hourly: { time: string[]; temperature_2m: number[] } }).hourly : null;
  const temperature = (t: number) => {
    const i = hourly?.time.indexOf(new Date(Math.floor(t / 3600) * 3600_000).toISOString().slice(0, 16)) ?? -1;
    return i >= 0 ? hourly!.temperature_2m[i] : 15;
  };
  const out: Scenario[] = [];
  for (const p of passages) {
    const at = placed.get(p.id);
    if (!at) continue;
    const wav = decodeWav(new Uint8Array(readFileSync(new URL("audio.wav", p.dir))));
    const samples = resample(wav.samples, wav.sampleRate, ANALYSIS_RATE);
    const { start } = alignRidge(samples, ANALYSIS_RATE, p.ridge);
    const polls = pollsOf([...flights.values()], at.listener, start - 30, start + samples.length / ANALYSIS_RATE);
    const base = { samples, sampleRate: ANALYSIS_RATE, start, listener: at.listener, air: { groundTempC: temperature(start) } };
    const tags = { site: at.site, slantKm: Math.round(p.slant / 100) / 10, flight: p.category.replace(/_/g, " ") };
    const other = LIVERMORE_ALSO_AUDIBLE[p.id];
    out.push({ id: `lvk-${p.id}`, kind: "heard", recording: { ...base, polls }, truth: { heard: p.hex, alsoHeard: other ? [other.hex] : undefined }, tags, native: wav });
    const without = polls.map((x) => ({ now: x.now, aircraft: x.aircraft.filter((a) => a.hex !== p.hex) })).filter((x) => x.aircraft.length);
    // Without its aircraft, a recording must name nobody, unless another one was audible too.
    if (without.length) out.push({ id: `lvk-missing-${p.id}`, kind: other ? "heard" : "missing", recording: { ...base, polls: without }, truth: { heard: other?.hex ?? null }, tags: other ? { ...tags, note: "other aircraft audible" } : tags });
  }
  return out;
}

/** Capture bundles saved by the page in capture mode (committed), and donations pulled by
 * scripts/fetch-donations.ts (evals/.cache/donations/, private until reviewed). */
const BUNDLES = [
  { dir: new URL("../fixtures/real/", import.meta.url), prefix: "cap" },
  { dir: new URL("../.cache/donations/", import.meta.url), prefix: "don" },
];

/** Real recordings made through the page, once a human has said what was heard. */
export function bundleScenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const { dir, prefix } of BUNDLES) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      const bundle = JSON.parse(readFileSync(new URL(name, dir), "utf8")) as Bundle;
      if (!bundle.truth) continue;
      const recording = recordingOf(bundle);
      const heard = bundle.truth.heard;
      out.push({ id: `${prefix}-${name.replace(/\.json$/, "")}`, kind: heard ? "heard" : "noise", recording, truth: { heard }, tags: { app: bundle.app, device: bundle.device?.userAgent.slice(0, 40) ?? "" } });
    }
  }
  return out;
}
