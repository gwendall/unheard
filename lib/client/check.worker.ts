// The check page's work, off the page's thread so a long file never freezes it: read the file's
// sound once into a store (lib/core/stream.ts), find the tones (lib/core/leak.ts), take them out,
// look again, and write the cleaned file. The file's sound stays here and on this device, and never
// leaves it.

import { chunksOf, cleanOut, curvesOf, findTones, pictureOf, viewOf, type Picture, type Tone, type View } from "../core/leak";
import { ANALYSIS_RATE } from "../core/rate";
import { estimator, stagesOf, type Estimate } from "../core/progress";
import type { Curve } from "../core/scrub";
import { memorySource, readInto, storedSound, takeOutOfFile, type SoundSource, type SoundStore } from "../core/stream";
import { openSink, openStore } from "./disk";
import { sweep } from "./folder";
import { openMedia, type MediaFile } from "./media";
import { pcm16, WAV_HEADER, wavHeader } from "./wav";

export type CheckRequest =
  /** A file picked: this worker reads it as a stream if it can. `partial`: also send each tone as soon as it is found. */
  | { type: "open"; file: File; folder: string; partial?: boolean }
  /** The sound of a file this worker could not read, decoded by the page (Web Audio). */
  | { type: "sound"; channels: Float32Array[]; sampleRate: number }
  | { type: "clean" };

export type Step = "open" | "find" | "clean" | "again" | "write";

/** A tone the page shows: where it is, how it looks, and how it looks once taken out. */
export type Found = { tone: Tone; view: View; before: Picture };

/** What comes before the end when the request asks (`partial`): the tones so far, strongest first, and where each lies. */
export type CheckPartial = { type: "tones"; duration: number; tones: { tone: Tone; view: View }[] };

/** The cleaned file, ready to download. */
export type Written = { file: Blob; extension: string };

export type CheckEvent =
  /** `done` of `total` within the step; `fraction` and `secondsLeft` for what was asked, find or clean (lib/core/progress.ts). */
  | ({ type: "progress"; step: Step; done: number; total: number } & Estimate)
  /** The worker cannot read this file: the page decodes it, at the rate its container says if it says one. */
  | { type: "decode-here"; sampleRate?: number }
  | { type: "found"; duration: number; found: Found[] }
  | ({ type: "cleaned"; cleaned: (Found & { after: Picture })[]; left: Found[] } & Written)
  | { type: "error"; message: string };

// The worker's own global, typed by what this file uses of it (the DOM and webworker libs clash).
const scope = self as unknown as { postMessage: (event: CheckEvent | CheckPartial) => void; onmessage: ((e: MessageEvent<CheckRequest>) => void) | null };
const post = (event: CheckEvent | CheckPartial) => scope.postMessage(event);

const clock = () => performance.now() / 1000;

/** The stages of each job and their shares of it: reading a file takes about as long as searching it, measured on a 30-minute video. */
const FINDING = stagesOf<Step>([["open", 1], ["find", 1]]);
const CLEANING = stagesOf<Step>([["clean", 1], ["write", 1], ["again", 1]]);

/** A job's progress as it goes: the step it is in, and how far the whole job has got. */
function jobOf(stages: (stage: Step, share: number) => number) {
  const estimate = estimator(clock);
  const now = { step: "open" as Step, done: 0, total: 1 };
  const count = (step: Step, done: number, total: number) => void Object.assign(now, { step, done, total });
  const share = (part: number, stage = now.step) => post({ type: "progress", ...now, ...estimate(stages(stage, part)) });
  return {
    count,
    share,
    /** A step whose count says how far it has got. */
    reach(step: Step, done: number, total: number) {
      count(step, done, total);
      share(done / Math.max(1, total));
    },
  };
}

type Session = {
  folder: string;
  media: MediaFile | null;
  source: SoundSource | null;
  store: SoundStore;
  /** Send each tone as soon as it is found. */
  partial: boolean;
  /** Samples of the store, and seconds of sound. */
  length: number;
  duration: number;
  /** What was taken out so far, round after round: the file's own sound goes through all of it. */
  rounds: Curve[][];
  current: Found[];
  writes: number;
};

let session: Session | null = null;

function show(s: Session, tones: Tone[]): Found[] {
  return tones.map((tone) => {
    const view = viewOf(tone, s.duration);
    return { tone, view, before: pictureOf(s.store.read, s.length, view) };
  });
}

async function find(s: Session, source: SoundSource) {
  s.source = source;
  const job = jobOf(FINDING);
  const { length, frames } = await readInto(source, s.store, (done, total) => job.reach("open", done, total));
  s.length = length;
  s.duration = frames / source.sampleRate;
  job.reach("find", 0, 1);
  const tones = findTones(s.store.read, chunksOf(length), ANALYSIS_RATE, {
    onChunk: (done, total) => job.count("find", done, total),
    onProgress: (part) => job.share(part),
    onTones: s.partial ? (found) => post({ type: "tones", duration: s.duration, tones: found.map((tone) => ({ tone, view: viewOf(tone, s.duration) })) }) : undefined,
  });
  s.current = show(s, tones);
  post({ type: "found", duration: s.duration, found: s.current });
}

async function open(file: File, folder: string, partial: boolean) {
  void sweep().catch(() => {});
  const media = await openMedia(file);
  session = { folder, media, source: null, store: await openStore(folder), partial, length: 0, duration: 0, rounds: [], current: [], writes: 0 };
  if (media?.source) {
    try {
      await find(session, media.source);
      return;
    } catch {
      // Its decoder gave up on this file: Web Audio may not.
    }
  }
  post({ type: "decode-here", sampleRate: media?.audio?.sampleRate });
}

/** The sound as a WAV, written as it is cleaned. */
async function writeWav(s: Session, source: SoundSource, onDone: (consume: (block: Float32Array[]) => void) => Promise<Tone[]>): Promise<{ left: Tone[]; written: Written }> {
  const sink = await openSink(s.folder, `cleaned-${++s.writes}.wav`, WAV_HEADER + source.length * source.channels * 2);
  const blank = new Uint8Array(WAV_HEADER);
  sink.write(blank, 0);
  let at = WAV_HEADER;
  let frames = 0;
  const left = await onDone((block) => {
    const bytes = new Uint8Array(pcm16(block));
    sink.write(bytes, at);
    at += bytes.length;
    frames += block[0]?.length ?? 0;
  });
  sink.write(new Uint8Array(wavHeader(source.channels, source.sampleRate, frames)), 0);
  return { left, written: { file: await sink.finish("audio/wav"), extension: "wav" } };
}

async function cleanUp(s: Session) {
  const source = s.source;
  if (!source) return;
  // Every tone taken out, with how it looked just before its round.
  const shown = new Map<Tone, Found>(s.current.map((f) => [f.tone, f]));
  const job = jobOf(CLEANING);
  const { cleaned } = cleanOut(
    storedSound(s.store, s.length),
    s.current.map((f) => f.tone),
    {
      onWindow: (done, total) => job.count("clean", done, total),
      find: { onChunk: (done, total) => job.count("again", done, total) },
      onProgress: (part) => job.share(part, "clean"),
      onRound: (round, tones) => {
        s.rounds.push(curvesOf(tones));
        if (round) for (const f of show(s, tones)) shown.set(f.tone, f);
      },
    },
  );
  job.reach("write", 0, 1);
  // What the rounds found comes out of the file's own sound, and what comes out is what is searched.
  const { left, written } = await writeWav(s, source, (consume) =>
    takeOutOfFile(source, s.rounds, s.store, s.length, consume, {
      onProgress: (done, total) => job.reach("write", done, total),
      find: { onChunk: (done, total) => job.count("again", done, total), onProgress: (part) => job.share(part, "again") },
    }),
  );
  const after = cleaned.map((tone) => {
    const f = shown.get(tone)!;
    return { ...f, after: pictureOf(s.store.read, s.length, f.view) };
  });
  s.current = show(s, left);
  job.share(1, "again");
  post({ type: "cleaned", cleaned: after, left: s.current, ...written });
}

async function handle(e: MessageEvent<CheckRequest>) {
  const request = e.data;
  if (request.type === "open") await open(request.file, request.folder, !!request.partial);
  else if (request.type === "sound") {
    if (session) await find(session, memorySource({ channels: request.channels, sampleRate: request.sampleRate }));
  } else if (session) await cleanUp(session);
}

scope.onmessage = (e: MessageEvent<CheckRequest>) => {
  handle(e).catch((err) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }));
};
