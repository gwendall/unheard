// A recording too long to hold. The file is read from start to end, a block at a time, and never
// kept: its sound at the analysis rate goes to a store (a file on this device in the page), which
// findTones and the rounds of take out and look again read as they read a whole recording. Those
// rounds work at that rate, so they cost a twelfth of the file's own sound; what they found is then
// taken out of the file's own sound in one more pass, window by window, and the result searched
// again, since that is the sound that comes out.
//
// What holds the sound is a SoundSource: a decoder over a file (lib/client/media.ts), or memory.

import { chunksOf, findTonesWith, inline, spanOf, type Audio, type CleanOptions, type FindOptions, type Pieces, type Reader, type Sound, type Tone } from "./leak";
import { inOrder } from "./parallel";
import { ANALYSIS_RATE } from "./rate";
import { RESAMPLE_REACH, resampleAt } from "./resample";
import type { Curve, ScrubOptions } from "./scrub";

/** A recording read once from start to end, a block at a time. */
export type SoundSource = {
  sampleRate: number;
  channels: number;
  /** Samples per channel the file announces. The blocks may come to a little more or less. */
  length: number;
  /** Every channel from the first sample, block after block with no gap. Each call starts over. */
  blocks(): AsyncIterable<Float32Array[]>;
};

/** The sound at the analysis rate, wherever it is kept. Past what was written, it reads as silence. */
export type SoundStore = {
  read: Reader;
  write(start: number, samples: Float32Array): void;
};

const MEMORY_BLOCK = 1 << 18;

/** A recording already in memory, handed out in blocks. */
export function memorySource(audio: Audio): SoundSource {
  const length = audio.channels[0]?.length ?? 0;
  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels.length,
    length,
    async *blocks() {
      for (let i = 0; i < length; i += MEMORY_BLOCK) yield audio.channels.map((ch) => ch.subarray(i, i + MEMORY_BLOCK));
    },
  };
}

const PAGE = 1 << 20;

/** A store in memory, in pages: 115 MB per hour of sound. */
export function memoryStore(): SoundStore {
  const pages: Float32Array[] = [];
  return {
    read(start, count) {
      const out = new Float32Array(count);
      for (let i = 0; i < count; ) {
        const at = start + i;
        const inPage = at % PAGE;
        const m = Math.min(count - i, PAGE - inPage);
        const page = pages[(at - inPage) / PAGE];
        if (page) out.set(page.subarray(inPage, inPage + m), i);
        i += m;
      }
      return out;
    },
    write(start, samples) {
      for (let i = 0; i < samples.length; ) {
        const at = start + i;
        const inPage = at % PAGE;
        const m = Math.min(samples.length - i, PAGE - inPage);
        const index = (at - inPage) / PAGE;
        (pages[index] ??= new Float32Array(PAGE)).set(samples.subarray(i, i + m), inPage);
        i += m;
      }
    },
  };
}

/** A stretch of the recording in seconds: [start, end]. */
export type Stretch = { start: number; end: number };

/**
 * Blocks of a recording in, its mono sound at the analysis rate into `store`, through the kernel
 * readerOf uses. With `only`, the store is left as it is outside those stretches, and the kernel not
 * run: most of a long file does not change when its tones are taken out.
 */
export function analysisWriter(store: SoundStore, from: number, options: { rate?: number; only?: Stretch[] } = {}) {
  const { rate = ANALYSIS_RATE, only } = options;
  let held = new Float32Array(0);
  let heldAt = 0;
  let written = 0;
  let seen = 0;
  const flush = (end: number) => {
    if (end <= written) return;
    const wanted = !only || only.some((s) => s.start * rate < end && s.end * rate >= written);
    if (wanted) store.write(written, from === rate ? held.slice(written - heldAt, end - heldAt) : resampleAt(held, from, rate, (written * from) / rate - heldAt, end - written));
    written = end;
    // Only what the kernel may still reach is kept.
    const keep = Math.max(heldAt, Math.floor((written * from) / rate) - RESAMPLE_REACH - 1);
    held = held.slice(keep - heldAt);
    heldAt = keep;
  };
  return {
    add(block: Float32Array[]) {
      const n = block[0]?.length ?? 0;
      const grown = new Float32Array(held.length + n);
      grown.set(held);
      for (const ch of block) for (let i = 0; i < n; i++) grown[held.length + i] += ch[i] / block.length;
      held = grown;
      seen += n;
      flush(Math.max(written, Math.floor(((seen - RESAMPLE_REACH - 1) * rate) / from)));
    },
    /** The last samples, whose kernel runs past the end. Returns how many samples the store holds. */
    end() {
      flush(Math.floor((seen * rate) / from));
      return written;
    },
  };
}

/** One pass over `source` into `store`. Returns the samples it holds, and how many came in. */
export async function readInto(source: SoundSource, store: SoundStore, onProgress?: (done: number, total: number) => void): Promise<{ length: number; frames: number }> {
  const writer = analysisWriter(store, source.sampleRate);
  let frames = 0;
  for await (const block of source.blocks()) {
    writer.add(block);
    frames += block[0]?.length ?? 0;
    onProgress?.(frames, Math.max(frames, source.length));
  }
  return { length: writer.end(), frames };
}

/** Seconds of a stored recording cleaned at a time, and read on either side of them. */
const STORED_PIECE = 60;
const STORED_MARGIN = 4;

const shifted = (c: Curve, by: number): Curve => ({ ...c, times: Float64Array.from(c.times as ArrayLike<number>, (t) => t - by) });

/** A stored recording as the rounds of take out and look again work on it (cleanOut). `workers`: where its pieces can run. */
export function storedSound(store: SoundStore, length: number, rate = ANALYSIS_RATE, workers: Pieces = inline): Sound {
  return {
    read: store.read,
    length,
    async clean(curves: Curve[], options: CleanOptions = {}) {
      const known = curves.flatMap((c) => {
        const span = spanOf(c);
        return span ? [{ c, span }] : [];
      });
      const size = Math.round(STORED_PIECE * rate);
      const margin = Math.round(STORED_MARGIN * rate);
      const pieces: { a: number; b: number; here: typeof known }[] = [];
      for (let a = 0; a < length; a += size) {
        const b = Math.min(length, a + size);
        const here = known.filter(({ span }) => span.end * rate >= a - margin && span.start * rate <= b + margin);
        if (here.length) pieces.push({ a, b, here });
      }
      // One piece is as well done here: no worker to start, nothing to copy.
      const runner = pieces.length > 1 ? workers : inline;
      const shares = new Float64Array(pieces.length);
      // A piece's result is written once the next piece has read: each reads the sound as it was.
      const results = inOrder(pieces.entries(), runner.size, async ([i, { a, b, here }]) => {
        options.onWindow?.(i, pieces.length);
        const s0 = Math.max(0, a - margin);
        const s1 = Math.min(length, b + margin);
        const job = { channels: [store.read(s0, s1 - s0)], rate, rounds: [here.map(({ c }) => shifted(c, s0 / rate))], scrub: options.scrub };
        const [out] = await runner.takeOut(job, (s) => {
          shares[i] = s;
          options.onShare?.(shares.reduce((x, y) => x + y, 0) / pieces.length);
        });
        return { at: a, data: out.subarray(a - s0, b - s0) };
      });
      for await (const { at, data } of results) store.write(at, data);
      options.onWindow?.(pieces.length, pieces.length);
    },
  };
}

/** Seconds of the file's own sound cleaned at a time. */
export const BLOCK_SECONDS = 20;
/** Read on either side: a round's smoothing reaches about 1.2 s, and rounds add up. */
const marginFor = (rounds: number) => Math.max(4, 1 + 1.2 * rounds);

/** The blocks of a source held between a window's start and its end. */
function held(blocks: AsyncIterable<Float32Array[]>, channels: number) {
  const it = blocks[Symbol.asyncIterator]();
  let parts: { at: number; data: Float32Array[] }[] = [];
  let end = 0;
  let done = false;
  return {
    get end() {
      return end;
    },
    async until(wanted: number) {
      while (!done && end < wanted) {
        const next = await it.next();
        if (next.done) done = true;
        else {
          parts.push({ at: end, data: next.value });
          end += next.value[0]?.length ?? 0;
        }
      }
    },
    copy(a: number, b: number): Float32Array[] {
      const out = Array.from({ length: channels }, () => new Float32Array(b - a));
      for (const p of parts) {
        const n = p.data[0]?.length ?? 0;
        const from = Math.max(a, p.at);
        const to = Math.min(b, p.at + n);
        if (to > from) out.forEach((ch, c) => ch.set(p.data[c].subarray(from - p.at, to - p.at), from - a));
      }
      return out;
    },
    drop(before: number) {
      parts = parts.filter((p) => p.at + (p.data[0]?.length ?? 0) > before);
    },
    async close() {
      await it.return?.();
    },
  };
}

/** Where a round's curves change the sound, margins included: what has to be searched again. */
export function reachOf(rounds: Curve[][]): Stretch[] {
  const pad = marginFor(rounds.length);
  return rounds.flat().flatMap((c) => {
    const span = spanOf(c);
    return span ? [{ start: span.start - pad, end: span.end + pad }] : [];
  });
}

/**
 * The source with every round's curves taken out, round after round as they were found, in blocks.
 * Only the blocks being cleaned are held; where no curve is known the sound comes through as it was.
 * Over `pieces` several blocks are cleaned at a time, each from its own copy of the sound, and they
 * come out in order.
 */
export async function* cleanedBlocks(source: SoundSource, rounds: Curve[][], options: { block?: number; scrub?: ScrubOptions; pieces?: Pieces } = {}): AsyncGenerator<Float32Array[]> {
  const rate = source.sampleRate;
  const size = Math.round((options.block ?? BLOCK_SECONDS) * rate);
  const margin = Math.round(marginFor(rounds.length) * rate);
  const known = rounds.map((curves) =>
    curves.flatMap((c) => {
      const span = spanOf(c);
      return span ? [{ c, span }] : [];
    }),
  );
  // One block is as well done here: no worker to start, nothing to copy. A length not announced may be anything.
  const runner = source.length > 0 && source.length <= size ? inline : (options.pieces ?? inline);
  const sound = held(source.blocks(), source.channels);
  type Block = { kept: Float32Array[] } | { channels: Float32Array[]; rounds: Curve[][]; from: number; to: number };
  async function* blocks(): AsyncGenerator<Block> {
    for (let a = 0; ; a += size) {
      await sound.until(a + size + margin);
      const b = Math.min(a + size, sound.end);
      if (b <= a) return;
      const s0 = Math.max(0, a - margin);
      const s1 = Math.min(sound.end, b + margin);
      const here = known.map((round) => round.filter(({ span }) => span.end >= s0 / rate && span.start <= s1 / rate));
      if (here.every((round) => !round.length)) yield { kept: sound.copy(a, b) };
      else yield { channels: sound.copy(s0, s1), rounds: here.map((round) => round.map(({ c }) => shifted(c, s0 / rate))), from: a - s0, to: b - s0 };
      sound.drop(a + size - margin);
    }
  }
  try {
    // A channel is taken out on its own, whatever the others hold: each is a piece.
    yield* inOrder(blocks(), Math.max(1, Math.ceil(runner.size / source.channels)), async (block) => {
      if ("kept" in block) return block.kept;
      const { rounds, from, to } = block;
      const out = await Promise.all(block.channels.map((ch) => runner.takeOut({ channels: [ch], rate, rounds, scrub: options.scrub }, () => {})));
      return out.map(([ch]) => ch.subarray(from, to));
    });
  } finally {
    await sound.close();
  }
}

/**
 * The file's own sound with `rounds` taken out, each block handed to `consume`; what comes out
 * replaces the store where it changed, and that is searched again. Returns what is still found.
 */
export async function takeOutOfFile(
  source: SoundSource,
  rounds: Curve[][],
  store: SoundStore,
  length: number,
  consume: (block: Float32Array[]) => void | Promise<void>,
  options: { find?: FindOptions; onProgress?: (done: number, total: number) => void; rate?: number; pieces?: Pieces } = {},
): Promise<Tone[]> {
  const { rate = ANALYSIS_RATE, pieces = inline } = options;
  const only = reachOf(rounds);
  const writer = analysisWriter(store, source.sampleRate, { rate, only });
  let frames = 0;
  for await (const block of cleanedBlocks(source, rounds, { pieces })) {
    writer.add(block);
    await consume(block);
    frames += block[0]?.length ?? 0;
    options.onProgress?.(frames, Math.max(frames, source.length));
  }
  writer.end();
  const changed = chunksOf(length, rate).filter((c) => only.some((s) => s.start * rate <= c.end && s.end * rate >= c.start));
  return changed.length ? findTonesWith(pieces, store.read, changed, rate, options.find) : [];
}
