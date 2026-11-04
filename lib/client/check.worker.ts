// The check page's work, off the page's thread so a long file never freezes it: find the tones
// (lib/core/leak.ts), take them out, look again, and write the cleaned WAV. The file's sound stays
// here between steps and never leaves the device.

import { chunksOf, cleanOut, findTones, pictureOf, readerOf, viewOf, type Audio, type Picture, type Tone, type View } from "../core/leak";
import { ANALYSIS_RATE } from "../core/pipeline";
import { estimator, type Estimate } from "../core/progress";
import { wavBlob } from "./wav";

export type CheckRequest =
  /** `partial`: also send each tone as soon as it is found. */
  | { type: "find"; channels: Float32Array[]; sampleRate: number; partial?: boolean }
  /** `sound`, the first time: at the rate the cleaned file is written at. Finding needs only the analysis rate. */
  | { type: "clean"; sound?: Audio };

export type Step = "find" | "clean" | "again" | "write";

/** A tone the page shows: where it is, how it looks, and how it looks once taken out. */
export type Found = { tone: Tone; view: View; before: Picture };

/** What comes before the end when the request asks (`partial`): the tones so far, strongest first, and where each lies. */
export type CheckPartial = { type: "tones"; duration: number; tones: { tone: Tone; view: View }[] };

export type CheckEvent =
  /** `done` of `total` within the step; `fraction` and `secondsLeft` for what was asked, find or clean (lib/core/progress.ts). */
  | ({ type: "progress"; step: Step; done: number; total: number } & Estimate)
  | { type: "found"; duration: number; found: Found[] }
  | { type: "cleaned"; cleaned: (Found & { after: Picture })[]; left: Found[]; wav: Blob }
  | { type: "error"; message: string };

// The worker's own global, typed by what this file uses of it (the DOM and webworker libs clash).
const scope = self as unknown as { postMessage: (event: CheckEvent | CheckPartial) => void; onmessage: ((e: MessageEvent<CheckRequest>) => void) | null };
const post = (event: CheckEvent | CheckPartial) => scope.postMessage(event);

let audio: Audio | null = null;
let current: Found[] = [];

const duration = (a: Audio) => (a.channels[0]?.length ?? 0) / a.sampleRate;

function show(a: Audio, tones: Tone[]): Found[] {
  const { read, length } = readerOf(a);
  return tones.map((tone) => {
    const view = viewOf(tone, duration(a));
    return { tone, view, before: pictureOf(read, length, view) };
  });
}

const clock = () => performance.now() / 1000;

function find(a: Audio, partial: boolean) {
  const { read, length } = readerOf(a);
  const estimate = estimator(clock);
  const count = { done: 0, total: 1 };
  const tones = findTones(read, chunksOf(length), ANALYSIS_RATE, {
    onChunk: (done, total) => void Object.assign(count, { done, total }),
    onProgress: (fraction) => post({ type: "progress", step: "find", ...count, ...estimate(fraction) }),
    onTones: partial ? (found) => post({ type: "tones", duration: duration(a), tones: found.map((tone) => ({ tone, view: viewOf(tone, duration(a)) })) }) : undefined,
  });
  current = show(a, tones);
  post({ type: "found", duration: duration(a), found: current });
}

function cleanUp(a: Audio) {
  // Every tone taken out, with how it looked just before its round.
  const shown = new Map<Tone, Found>(current.map((f) => [f.tone, f]));
  const estimate = estimator(clock);
  const now = { step: "clean" as Step, done: 0, total: 1 };
  const { cleaned, left } = cleanOut(
    a,
    current.map((f) => f.tone),
    {
      onWindow: (done, total) => void Object.assign(now, { step: "clean", done, total }),
      find: { onChunk: (done, total) => void Object.assign(now, { step: "again", done, total }) },
      onProgress: (fraction) => post({ type: "progress", ...now, ...estimate(fraction) }),
      onRound: (round, tones) => {
        if (round) for (const f of show(a, tones)) shown.set(f.tone, f);
      },
    },
  );
  const { read, length } = readerOf(a);
  const after = cleaned.map((tone) => {
    const f = shown.get(tone)!;
    return { ...f, after: pictureOf(read, length, f.view) };
  });
  current = show(a, left);
  post({ type: "progress", step: "write", done: 0, total: 1, ...estimate(1) });
  post({ type: "cleaned", cleaned: after, left: current, wav: wavBlob(a.channels, a.sampleRate) });
}

scope.onmessage = (e: MessageEvent<CheckRequest>) => {
  try {
    if (e.data.type === "find") {
      audio = { channels: e.data.channels, sampleRate: e.data.sampleRate };
      find(audio, !!e.data.partial);
    } else {
      if (e.data.sound) audio = e.data.sound;
      if (audio) cleanUp(audio);
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
