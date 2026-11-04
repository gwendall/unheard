// A file's sound, decoded in the page: Web Audio takes the audio of most video containers, and
// resamples it to the rate asked. Nothing of it is ever sent.

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

/**
 * A file's sound at the rate tones are looked for at, decoded once per file: the check and the
 * search read the same one. A copy each time, since a worker takes what it is given.
 */
export async function soundOf(file: File): Promise<Decoded> {
  let sound = sounds.get(file);
  if (!sound) sounds.set(file, (sound = decode(file, ANALYSIS_RATE)));
  const { channels, sampleRate } = await sound;
  return { channels: channels.map((c) => c.slice()), sampleRate };
}

/** What to tell the visitor about a file that would not decode: too big for memory, or no sound the browser can read. */
export function troubleOf(err: unknown): "tooBig" | "open" {
  const memory = err instanceof TooBig || err instanceof RangeError || (err instanceof DOMException && ["NotReadableError", "QuotaExceededError"].includes(err.name));
  return memory ? "tooBig" : "open";
}
