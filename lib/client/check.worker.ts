// The check page's work, off the page's thread so a long file never freezes it: read the file's
// sound once into a store (lib/core/stream.ts), find the tones (lib/core/leak.ts), take them out,
// look again, and write the cleaned file: the same video under the cleaned sound (lib/client/remux.ts),
// or the sound alone when it cannot be. The file's sound stays here and on this device, and never
// leaves it.

import { chunksOf, cleanOut, curvesOf, findTonesWith, pictureOf, viewOf, type Picture, type Pieces, type Reader, type Tone, type View } from "../core/leak";
import { ANALYSIS_RATE } from "../core/rate";
import { estimator, stagesOf, type Estimate } from "../core/progress";
import type { Curve } from "../core/scrub";
import { copySound, memorySource, readInto, storedSound, takeOutOfFile, type SoundSource, type SoundStore } from "../core/stream";
import { openSink, openStore } from "./disk";
import { sweep } from "./folder";
import { openMedia, type MediaFile } from "./media";
import { readMetadata, type CreatedAt, type Place } from "./metadata";
import { openVideoWriter, planVideo, type Refusal, type VideoPlan } from "./remux";
import { withPieces } from "./pool";
import { pcm16, WAV_HEADER, wavHeader } from "./wav";

export type CheckRequest =
  /** A file picked: this worker reads it as a stream if it can. `partial`: also send each tone as soon as it is found. */
  | { type: "open"; file: File; folder: string; partial?: boolean }
  /** The sound of a file this worker could not read, decoded by the page (Web Audio). */
  | { type: "sound"; channels: Float32Array[]; sampleRate: number }
  | { type: "clean" }
  /** The page shows this tone: its pictures. Nothing else waits for them. */
  | { type: "draw"; id: number };

export type Step = "open" | "find" | "clean" | "again" | "write";

/** A tone the page can show, and where it lies. `gone`: it was taken out, so it has a picture of after as well. */
export type Found = { id: number; tone: Tone; view: View; gone?: boolean };

/** What comes before the end when the request asks (`partial`): the tones so far, strongest first, and where each lies. */
export type CheckPartial = { type: "tones"; duration: number; tones: { tone: Tone; view: View }[] };

/** What the visitor's video said about itself, and the new file does not. */
export type Removed = { createdAt?: CreatedAt; location?: Place; device?: string; tracks: number };

/** What the cleaned file is: a video, or the sound alone and why. */
export type Kind = { extension: string } & ({ video: true; removed: Removed } | { video: false; why?: Refusal });

/** The cleaned file, ready to download. */
export type Written = { file: Blob } & Kind;

export type CheckEvent =
  /** `done` of `total` within the step; `fraction` and `secondsLeft` for what was asked, find or clean (lib/core/progress.ts). */
  | ({ type: "progress"; step: Step; done: number; total: number } & Estimate)
  /** The worker cannot read this file: the page decodes it, at the rate its container says if it says one. */
  | { type: "decode-here"; sampleRate?: number }
  /** A video with no sound track: no tone to find, nothing to clean. */
  | { type: "no-sound" }
  | { type: "found"; duration: number; found: Found[] }
  | ({ type: "cleaned"; cleaned: Found[]; left: Found[] } & Written)
  /** How a tone looks, and how it looks once taken out. */
  | { type: "drawn"; id: number; before: Picture; after?: Picture }
  | { type: "error"; message: string };

// The worker's own global, typed by what this file uses of it (the DOM and webworker libs clash).
const scope = self as unknown as { postMessage: (event: CheckEvent | CheckPartial, transfer?: Transferable[]) => void; onmessage: ((e: MessageEvent<CheckRequest>) => void) | null };
const post = (event: CheckEvent | CheckPartial, transfer: Transferable[] = []) => scope.postMessage(event, transfer);

const clock = () => performance.now() / 1000;

/** The stages of each job and their shares of it: reading a file takes about as long as searching it, measured on a 30-minute video. */
const FINDING = stagesOf<Step>([["open", 1], ["find", 1]]);
const CLEANING = stagesOf<Step>([["clean", 1], ["write", 1], ["again", 1]]);

/** A job's progress as it goes: the step it is in, and how far the whole job has got. */
function jobOf(stages: (stage: Step, share: number) => number, last: Step) {
  const estimate = estimator(clock, stages(last, 0));
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
  file: File;
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
  /** Every tone told to the page, by id, and the sound its pictures read. */
  drawable: Drawable[];
};

/** Where a tone's pictures are read: the sound as it is, or as it was before tones were taken out of it. */
type Drawable = { view: View; before: Reader; after?: Reader };

let session: Session | null = null;

/** Tones as the page is told of them. Their pictures are drawn when it asks: a real hour holds dozens, and it shows three. */
function told(s: Session, tones: Tone[], before: Reader, after?: Reader): Found[] {
  return tones.map((tone) => {
    const view = viewOf(tone, s.duration);
    const id = s.drawable.push({ view, before, after }) - 1;
    return after ? { id, tone, view, gone: true } : { id, tone, view };
  });
}

const asked: number[] = [];
let drawing = false;

/** The pictures asked for, one at a time and back to the queue between them, so that "Take them out" never waits for them. */
async function drawAsked() {
  if (drawing) return;
  drawing = true;
  while (asked.length && session) {
    const id = asked.shift()!;
    const f = session.drawable[id];
    if (f) {
      const before = pictureOf(f.before, session.length, f.view);
      const after = f.after && pictureOf(f.after, session.length, f.view);
      post({ type: "drawn", id, before, after }, after ? [before.cells.buffer, after.cells.buffer] : [before.cells.buffer]);
    }
    await new Promise((go) => setTimeout(go));
  }
  drawing = false;
}

async function find(s: Session, source: SoundSource) {
  s.source = source;
  const job = jobOf(FINDING, "find");
  const { length, frames } = await readInto(source, s.store, (done, total) => job.reach("open", done, total));
  s.length = length;
  s.duration = frames / source.sampleRate;
  job.reach("find", 0, 1);
  const tones = await withPieces((pieces) =>
    findTonesWith(pieces, s.store.read, chunksOf(length), ANALYSIS_RATE, {
      onChunk: (done, total) => job.count("find", done, total),
      onProgress: (part) => job.share(part),
      onTones: s.partial ? (found) => post({ type: "tones", duration: s.duration, tones: found.map((tone) => ({ tone, view: viewOf(tone, s.duration) })) }) : undefined,
    }),
  );
  s.current = told(s, tones, s.store.read);
  post({ type: "found", duration: s.duration, found: s.current });
}

async function open(file: File, folder: string, partial: boolean) {
  void sweep().catch(() => {});
  const media = await openMedia(file);
  if (media?.video && !media.audio) {
    post({ type: "no-sound" });
    return;
  }
  session = { file, folder, media, source: null, store: await openStore(folder), partial, length: 0, duration: 0, rounds: [], current: [], writes: 0, drawable: [] };
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

/** A pass over the file's own sound, each cleaned block handed on. With `look`, returns what is still found in it. */
type Pass = (consume: (block: Float32Array[]) => void | Promise<void>, look: boolean) => Promise<Tone[]>;
type Outcome = { left: Tone[]; written: Written };
type Job = ReturnType<typeof jobOf>;

/** The sound as a WAV, written as it is cleaned. */
async function writeWav(s: Session, source: SoundSource, pass: Pass, why?: Refusal): Promise<Outcome> {
  const sink = await openSink(s.folder, `cleaned-${++s.writes}.wav`, WAV_HEADER + source.length * source.channels * 2);
  sink.write(new Uint8Array(WAV_HEADER), 0);
  let at = WAV_HEADER;
  let frames = 0;
  const left = await pass((block) => {
    const bytes = new Uint8Array(pcm16(block));
    sink.write(bytes, at);
    at += bytes.length;
    frames += block[0]?.length ?? 0;
  }, true);
  sink.write(new Uint8Array(wavHeader(source.channels, source.sampleRate, frames)), 0);
  return { left, written: { file: await sink.finish("audio/wav"), extension: "wav", video: false, why } };
}

/** What this file really holds: an encoder does not give back quite what it was given, and this is what anyone will hear. */
async function heardIn(s: Session, file: Blob, job: Job, pieces: Pieces): Promise<Tone[]> {
  const back = await openMedia(file);
  if (back?.source) {
    await readInto(back.source, s.store, (done, total) => {
      job.count("again", done, total);
      job.share(done / (2 * Math.max(1, total)));
    });
  }
  return findTonesWith(pieces, s.store.read, chunksOf(s.length), ANALYSIS_RATE, { onChunk: (done, total) => job.count("again", done, total), onProgress: (part) => job.share(0.5 + part / 2) });
}

/** The same video under the cleaned sound, written as it is cleaned. */
async function writeVideo(s: Session, media: MediaFile, plan: VideoPlan, source: SoundSource, pass: Pass, job: Job, pieces: Pieces): Promise<Outcome> {
  const sink = await openSink(s.folder, `cleaned-${++s.writes}.${plan.extension}`, s.file.size);
  const writer = await openVideoWriter(media.video!, plan, sink, { sampleRate: source.sampleRate, channels: source.channels, origin: media.origin });
  try {
    await pass((block) => writer.add(block), false);
    const file = await writer.finish();
    const left = await heardIn(s, file, job, pieces);
    const { createdAt, location, device } = await readMetadata(s.file);
    return { left, written: { file, extension: plan.extension, video: true, removed: { createdAt, location, device, tracks: (await media.input.getTracks()).length - 2 } } };
  } catch (err) {
    await writer.cancel().catch(() => {});
    throw err;
  }
}

/** A video back as a video when it can be, the sound alone when not. */
async function writeFile(s: Session, source: SoundSource, pass: Pass, job: Job, pieces: Pieces): Promise<Outcome> {
  const media = s.media;
  if (!media?.video) return writeWav(s, source, pass);
  const plan = await planVideo(media.input, media.video, source);
  if ("refused" in plan) return writeWav(s, source, pass, plan.refused);
  try {
    return await writeVideo(s, media, plan, source, pass, job, pieces);
  } catch {
    // The browser said it could, and then could not: the sound is still worth having.
    return writeWav(s, source, pass, "encoder");
  }
}

async function cleanUp(s: Session) {
  const source = s.source;
  if (!source) return;
  const job = jobOf(CLEANING, "again");
  // The store is about to change: what the page shows, or may yet ask to see, reads the sound as it was.
  const now = s.store.read;
  const was = await openStore(s.folder, `before-${s.writes + 1}.f32`);
  copySound(s.store, was, s.length);
  for (const f of s.drawable) {
    if (f.before === now) f.before = was.read;
    if (f.after === now) f.after = was.read;
  }
  const { cleaned, left, written } = await withPieces(async (pieces) => {
    const { cleaned } = await cleanOut(
      storedSound(s.store, s.length, ANALYSIS_RATE, pieces),
      s.current.map((f) => f.tone),
      {
        pieces,
        onWindow: (done, total) => job.count("clean", done, total),
        find: { onChunk: (done, total) => job.count("again", done, total) },
        onProgress: (part) => job.share(part, "clean"),
        onRound: (_, tones) => void s.rounds.push(curvesOf(tones)),
      },
    );
    job.reach("write", 0, 1);
    // What the rounds found comes out of the file's own sound, and what comes out is what is searched.
    const { left, written } = await writeFile(
      s,
      source,
      (consume, look) =>
        takeOutOfFile(source, s.rounds, s.store, s.length, consume, {
          look,
          pieces,
          onProgress: (done, total) => job.reach("write", done, total),
          find: { onChunk: (done, total) => job.count("again", done, total), onProgress: (part) => job.share(part, "again") },
        }),
      job,
      pieces,
    );
    return { cleaned, left, written };
  });
  s.current = told(s, left, now);
  job.share(1, "again");
  post({ type: "cleaned", cleaned: told(s, cleaned, was.read, now), left: s.current, ...written });
}

async function handle(e: MessageEvent<CheckRequest>) {
  const request = e.data;
  if (request.type === "open") await open(request.file, request.folder, !!request.partial);
  else if (request.type === "sound") {
    if (session) await find(session, memorySource({ channels: request.channels, sampleRate: request.sampleRate }));
  } else if (session) await cleanUp(session);
}

scope.onmessage = (e: MessageEvent<CheckRequest>) => {
  if (e.data.type === "draw") {
    asked.push(e.data.id);
    void drawAsked().catch((err) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }));
    return;
  }
  handle(e).catch((err) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }));
};
