// The check page's work, off the page's thread so a long file never freezes it: find the tones
// (lib/core/leak.ts), take them out, look again, and write the cleaned WAV. The file's sound stays
// here between steps and never leaves the device.

import { chunksOf, cleanOut, findTones, pictureOf, readerOf, viewOf, type Audio, type Picture, type Tone, type View } from "../core/leak";
import { ANALYSIS_RATE } from "../core/pipeline";
import { wavBlob } from "./wav";

export type CheckRequest = { type: "find"; channels: Float32Array[]; sampleRate: number } | { type: "clean" };

export type Step = "find" | "clean" | "again" | "write";

/** A tone the page shows: where it is, how it looks, and how it looks once taken out. */
export type Found = { tone: Tone; view: View; before: Picture };

export type CheckEvent =
  | { type: "progress"; step: Step; done: number; total: number }
  | { type: "found"; duration: number; found: Found[] }
  | { type: "cleaned"; cleaned: (Found & { after: Picture })[]; left: Found[]; wav: Blob }
  | { type: "error"; message: string };

// The worker's own global, typed by what this file uses of it (the DOM and webworker libs clash).
const scope = self as unknown as { postMessage: (event: CheckEvent) => void; onmessage: ((e: MessageEvent<CheckRequest>) => void) | null };
const post = (event: CheckEvent) => scope.postMessage(event);

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

function find(a: Audio) {
  const { read, length } = readerOf(a);
  const tones = findTones(read, chunksOf(length), ANALYSIS_RATE, { onChunk: (done, total) => post({ type: "progress", step: "find", done, total }) });
  current = show(a, tones);
  post({ type: "found", duration: duration(a), found: current });
}

function cleanUp(a: Audio) {
  // Every tone taken out, with how it looked just before its round.
  const shown = new Map<Tone, Found>(current.map((f) => [f.tone, f]));
  const { cleaned, left } = cleanOut(
    a,
    current.map((f) => f.tone),
    {
      onWindow: (done, total) => post({ type: "progress", step: "clean", done, total }),
      find: { onChunk: (done, total) => post({ type: "progress", step: "again", done, total }) },
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
  post({ type: "progress", step: "write", done: 0, total: 1 });
  post({ type: "cleaned", cleaned: after, left: current, wav: wavBlob(a.channels, a.sampleRate) });
}

scope.onmessage = (e: MessageEvent<CheckRequest>) => {
  try {
    if (e.data.type === "find") {
      audio = { channels: e.data.channels, sampleRate: e.data.sampleRate };
      find(audio);
    } else if (audio) {
      cleanUp(audio);
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
