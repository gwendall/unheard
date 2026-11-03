// The whole analysis, from samples and polls to a verdict. The page, the tests and every eval
// call this one function: what the evals measure is what runs in production.

import { collect, type AircraftMeta, type Poll } from "../adsb";
import type { Air } from "./doppler";
import type { Listener } from "./geo";
import { explainLines, ghostsOf, linesOf, type ExplainOptions, type Ghost, type Line } from "./explain";
import { matchAll, verdictOf, type Candidate, type MatchOptions, type Verdict } from "./match";
import { buildStack, type Spectrogram, type Stack, type StackOptions } from "./spectrogram";
import type { Trace } from "./trace";
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
  explain?: ExplainOptions;
};

export type Analysis = {
  /** The base layer (longest window): the time grid of every Match curve, and what the page draws. */
  spec: Spectrogram;
  evidence: Float32Array;
  stack: Stack;
  verdict: Verdict<AircraftMeta>;
  /** Aircraft in the polls, and how many could be scored. */
  seen: number;
  /** The aircraft lines heard in the sound alone (blind traces), each with the free flyby that
   * follows it and the aircraft of the data that explains it, if one does. */
  lines: Line[];
  /** Lines no aircraft of the data explains: a plane we hear that the flight data does not have. */
  unexplained: Trace[];
  /** The unexplained lines that pass the bar of evals/ghost.eval.ts: what the page tells a visitor. */
  ghosts: Ghost[];
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
  const first = await matchAll(stack, rec.start, candidates, rec.air, options.match, onProgress);
  // A loud line from an aircraft missing from the data lends itself to the curves that cross it:
  // an aircraft that only borrows a line is scored again without it (lib/core/explain.ts).
  const { ranked, lines, unexplained } = await explainLines(stack, rec.start, candidates, rec.air, first.ranked, linesOf(stack), options.explain, options.match);
  return { spec: stack.base, evidence: stack.evidence, stack, verdict: verdictOf(ranked), seen: candidates.length, lines, unexplained, ghosts: ghostsOf(lines, stack.base.times, rec.air) };
}
