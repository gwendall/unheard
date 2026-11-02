// The whole analysis, from samples and polls to a verdict. The page, the tests and every eval
// call this one function: what the evals measure is what runs in production.

import { collect, type AircraftMeta, type Poll } from "../adsb";
import type { Air } from "./doppler";
import type { Listener } from "./geo";
import { matchAll, type Candidate, type MatchOptions, type Verdict } from "./match";
import { buildStack, type Spectrogram, type Stack, type StackOptions } from "./spectrogram";
import { buildTrack } from "./track";

/** The sample rate the page resamples to before analysis: tones up to 4 kHz, light to process. */
export const ANALYSIS_RATE = 8000;

export type Recording = {
  /** Mono samples at `sampleRate`. */
  samples: Float32Array;
  sampleRate: number;
  /** The phone's UTC time of the first sample, seconds. */
  start: number;
  listener: Listener;
  air: Air;
  /** Every poll made around the recording, from a little before it began. */
  polls: Poll[];
};

export type AnalysisOptions = {
  spectrogram?: StackOptions;
  match?: MatchOptions;
};

export type Analysis = {
  /** The base layer (longest window): the time grid of every Match curve, and what the page draws. */
  spec: Spectrogram;
  evidence: Float32Array;
  stack: Stack;
  verdict: Verdict<AircraftMeta>;
  /** Aircraft in the polls, and how many could be scored. */
  seen: number;
};

export function candidatesOf(polls: Poll[], listener: Listener): Candidate<AircraftMeta>[] {
  const out: Candidate<AircraftMeta>[] = [];
  for (const [hex, s] of collect(polls)) {
    const track = s.fixes.length ? buildTrack(s.fixes, listener) : null;
    if (track) out.push({ id: hex, track, meta: s.meta });
  }
  return out;
}

export async function analyze(rec: Recording, options: AnalysisOptions = {}, onProgress?: (done: number, total: number, id: string) => void): Promise<Analysis> {
  const stack = buildStack(rec.samples, rec.sampleRate, options.spectrogram);
  const candidates = candidatesOf(rec.polls, rec.listener);
  const verdict = await matchAll(stack, rec.start, candidates, rec.air, options.match, onProgress);
  return { spec: stack.base, evidence: stack.evidence, stack, verdict, seen: candidates.length };
}
