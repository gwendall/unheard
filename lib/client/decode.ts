// A file's sound, decoded in the page: Web Audio takes the audio of most video containers, and
// resamples it to the rate asked; the search reads it as a stream where it can (soundOf). Nothing of it is ever sent.

import { ANALYSIS_RATE } from "../core/rate";

export type Decoded = { channels: Float32Array[]; sampleRate: number };

/** Past this a browser cannot read a file whole. */
export const MAX_BYTES = 2 * 1024 ** 3;

class TooBig extends Error {}

export async function decode(file: File, rate: number): Promise<Decoded> {
  if (file.size > MAX_BYTES) throw new TooBig();
  const bytes = await file.arrayBuffer();
  const buffer = await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes);
  // Two channels at most: the check puts its cleaned file back under a video, left and right.
  const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c).slice());
  return { channels, sampleRate: buffer.sampleRate };
}

const sounds = new WeakMap<File, Promise<Decoded>>();

async function read(file: File): Promise<Decoded> {
  const [{ openMedia }, { memoryStore, readInto }] = await Promise.all([import("./media"), import("../core/stream")]);
  const media = await openMedia(file).catch(() => null);
  if (!media?.source) return decode(file, ANALYSIS_RATE);
  const store = memoryStore();
  const { length } = await readInto(media.source, store);
  return { channels: [store.read(0, length)], sampleRate: ANALYSIS_RATE };
}

/**
 * A file's sound at the rate tones are looked for at, read once per file for the search: as a stream
 * where the browser can, so a long file costs that sound and no more (115 MB an hour), and whole by
 * Web Audio where it cannot. The stream's code loads only here. A copy each time, since a worker takes
 * what it is given.
 */
export async function soundOf(file: File): Promise<Decoded> {
  let sound = sounds.get(file);
  if (!sound) sounds.set(file, (sound = read(file)));
  const { channels, sampleRate } = await sound;
  return { channels: channels.map((c) => c.slice()), sampleRate };
}

/** What to tell the visitor about a file that would not decode: too big for memory, or no sound the browser can read. */
export function troubleOf(err: unknown): "tooBig" | "open" {
  const memory = err instanceof TooBig || err instanceof RangeError || (err instanceof DOMException && ["NotReadableError", "QuotaExceededError"].includes(err.name));
  return memory ? "tooBig" : "open";
}
