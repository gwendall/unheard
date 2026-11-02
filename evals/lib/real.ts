// Real recordings: AeroSonicDB clips paired with ADS-B Exchange snapshots (evals/.cache/aerosonic,
// fetched by scripts/fetch-aerosonic.ts), and capture bundles saved by the page in capture mode
// (evals/fixtures/real/*.json). Both become Scenarios for the same analyze() as production.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Poll } from "../../lib/adsb";
import { recordingOf, decodeWav, type Bundle } from "../../lib/bundle";
import { ANALYSIS_RATE } from "../../lib/core/pipeline";
import type { Scenario } from "./sim";

/** Windowed-sinc resampler (Blackman, 32 input samples each side), anti-aliased below 0.45 x out. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = to / from;
  const cutoff = Math.min(1, ratio) * 0.9; // of the input Nyquist
  const half = 32;
  const n = Math.floor(input.length * ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / ratio;
    const k0 = Math.floor(x);
    let sum = 0;
    for (let k = k0 - half + 1; k <= k0 + half; k++) {
      if (k < 0 || k >= input.length) continue;
      const t = x - k;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / half) + 0.08 * Math.cos((2 * Math.PI * t) / half);
      const arg = Math.PI * cutoff * t;
      sum += input[k] * cutoff * (arg === 0 ? 1 : Math.sin(arg) / arg) * w;
    }
    out[i] = sum;
  }
  return out;
}

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
    out.push({ id: `asdb-${meta.file.slice(0, 26)}`, kind: "heard", recording: { ...base, polls }, truth: { heard: meta.hex, alsoHeard: other ? [other.hex] : undefined }, tags });
    const without = polls.map((p) => ({ now: p.now, aircraft: p.aircraft.filter((a) => a.hex !== meta.hex) }));
    // Without its aircraft, a clip must name nobody, unless another one was audible too.
    out.push({ id: `asdb-missing-${meta.file.slice(0, 26)}`, kind: other ? "heard" : "missing", recording: { ...base, polls: without }, truth: { heard: other?.hex ?? null }, tags: other ? { ...tags, note: "other aircraft audible" } : tags });
  }
  return out;
}

const BUNDLES = new URL("../fixtures/real/", import.meta.url);

/** Recordings made with the page in capture mode, once a human has written down the truth. */
export function bundleScenarios(): Scenario[] {
  if (!existsSync(BUNDLES)) return [];
  const out: Scenario[] = [];
  for (const name of readdirSync(BUNDLES).filter((f) => f.endsWith(".json")).sort()) {
    const bundle = JSON.parse(readFileSync(new URL(name, BUNDLES), "utf8")) as Bundle;
    if (!bundle.truth) continue;
    const recording = recordingOf(bundle);
    const heard = bundle.truth.heard;
    out.push({ id: `cap-${name.replace(/\.json$/, "")}`, kind: heard ? "heard" : "noise", recording, truth: { heard }, tags: { app: bundle.app, device: bundle.device?.userAgent.slice(0, 40) ?? "" } });
  }
  return out;
}
