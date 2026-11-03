// Real suburban sound with a human's word on what is in it: the six one-hour environmental
// recordings of AeroSonicDB 1.1.2 (CC BY-NC 4.0, evaluation only, evals/.cache/aerosonic-env,
// `node scripts/fetch-aerosonic.ts --env`), labelled every 5 s: 0 no aircraft audible, 1 aircraft,
// "ignore" the edges of an event. Stretches labelled 0 are recordings with nothing to find: birds,
// cars, voices, wind, whatever that street held. Stretches around a 1 are planes heard with no
// flight data at all. No ADS-B exists for those days, so the polls are empty: nothing can explain
// a line, the hardest case for a claim about lines nothing explains. A human's "no aircraft" is
// about what a human hears: a line there may still be a far plane, so these count as an upper bound.

import { existsSync, readFileSync } from "node:fs";
import { decodeWav } from "../../lib/bundle";
import { ANALYSIS_RATE, type Recording } from "../../lib/core/pipeline";
import { resample } from "../../lib/core/resample";

const DIR = new URL("../.cache/aerosonic-env/", import.meta.url);
const INTERVAL = 5;
const LONG = 120;
const SHORT = 60;

export type Ambient = { id: string; plane: boolean; recording: Recording };

function labels(): string[][] {
  const rows = readFileSync(new URL("environment_class_mappings.csv", DIR), "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  return rows[0].map((_, column) => rows.map((r) => r[column]));
}

/** Stretches of a column with one label: [first interval, intervals]. */
function runsOf(column: string[], label: string): [number, number][] {
  const out: [number, number][] = [];
  let from = -1;
  for (let i = 0; i <= column.length; i++) {
    if (column[i] === label) {
      if (from < 0) from = i;
    } else if (from >= 0) {
      out.push([from, i - from]);
      from = -1;
    }
  }
  return out;
}

/** Windows of `long` s, then one of `SHORT` s if that much of the stretch is left. */
function windows([first, count]: [number, number], long: number): [number, number][] {
  const out: [number, number][] = [];
  let at = first * INTERVAL;
  let left = count * INTERVAL;
  for (; left >= long; at += long, left -= long) out.push([at, long]);
  if (left >= SHORT) out.push([at, SHORT]);
  return out;
}

/** Lazily, a file at a time (an hour of WAV is 159 MB): the silent stretches, then each aircraft event in `pad` s of what is around it. */
export function* ambientScenarios(pad = 20, long = LONG): Generator<Ambient> {
  if (!existsSync(new URL("environment_class_mappings.csv", DIR)) || !existsSync(new URL("extracted/env_audio/1_AUDIO.wav", DIR))) return;
  const columns = labels();
  for (const [c, column] of columns.entries()) {
    const wav = decodeWav(new Uint8Array(readFileSync(new URL(`extracted/env_audio/${c + 1}_AUDIO.wav`, DIR))));
    const total = wav.samples.length / wav.sampleRate;
    const cut = (from: number, seconds: number): Recording => ({
      samples: resample(wav.samples.subarray(Math.round(from * wav.sampleRate), Math.round((from + seconds) * wav.sampleRate)), wav.sampleRate, ANALYSIS_RATE),
      sampleRate: ANALYSIS_RATE,
      start: 1_684_000_000 + from,
      listener: { lat: -34.85364, lon: 138.67517, elevation: 100 },
      air: { groundTempC: 20 },
      polls: [],
    });
    for (const run of runsOf(column, "0")) {
      for (const [from, seconds] of windows(run, long)) yield { id: `env-${c + 1}-${from}`, plane: false, recording: cut(from, seconds) };
    }
    for (const [first, count] of runsOf(column, "1")) {
      if (count < 2) continue;
      const from = Math.max(0, first * INTERVAL - pad);
      const seconds = Math.min(total - from, count * INTERVAL + 2 * pad);
      yield { id: `env-plane-${c + 1}-${from}`, plane: true, recording: cut(from, seconds) };
    }
  }
}
