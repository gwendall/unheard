// A file's sound as a stream: Mediabunny reads the container by parts and the browser's own decoder
// (WebCodecs) takes one packet at a time, so a two-hour video never sits in memory. Runs in the
// check's worker, so none of this loads until a file is dropped.

import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, type InputAudioTrack, type InputVideoTrack } from "mediabunny";
import type { SoundSource } from "../core/stream";

/** Frames per block handed out: about 3 s of sound. */
const BLOCK = 1 << 17;
/** A packet this close to where it should be is where it should be (WebM's clock counts milliseconds). */
const TOLERANCE_SECONDS = 0.01;
/** Two channels at most: left and right go back under a video. */
const MAX_CHANNELS = 2;
const SIDE = Math.SQRT1_2;

export type MediaFile = {
  input: Input;
  audio: InputAudioTrack | null;
  video: InputVideoTrack | null;
  /** The sound as a stream, null when this browser cannot decode it. */
  source: SoundSource | null;
  /** Where the sound starts on the file's clock, seconds: the cleaned sound starts there too. */
  origin: number;
};

/** 5.1 to stereo as ITU-R BS.775 has it, or the first two channels of anything else. */
function toOut(planes: Float32Array[], out: Float32Array[], at: number, frames: number) {
  if (planes.length >= 6) {
    const [l, r, c, , ls, rs] = planes;
    const norm = 1 / (1 + 2 * SIDE);
    for (let i = 0; i < frames; i++) {
      out[0][at + i] = norm * (l[i] + SIDE * c[i] + SIDE * ls[i]);
      out[1][at + i] = norm * (r[i] + SIDE * c[i] + SIDE * rs[i]);
    }
    return;
  }
  out.forEach((ch, c) => ch.set(planes[c].subarray(0, frames), at));
}

async function streamOf(track: InputAudioTrack, origin: number): Promise<SoundSource | null> {
  if (!(await track.canDecode())) return null;
  const sink = new AudioSampleSink(track);
  // What the decoder really gives: HE-AAC's container announces half the rate and one channel.
  let rate = 0;
  let inChannels = 0;
  try {
    for await (const sample of sink.samples()) {
      rate = sample.sampleRate;
      inChannels = sample.numberOfChannels;
      sample.close();
      break;
    }
  } catch {
    return null;
  }
  if (!rate) return null;
  const channels = Math.min(MAX_CHANNELS, inChannels);
  const duration = await track.computeDuration();
  const tolerance = TOLERANCE_SECONDS * rate;
  return {
    sampleRate: rate,
    channels,
    length: Math.round((duration - origin) * rate),
    async *blocks() {
      const planes = Array.from({ length: inChannels }, () => new Float32Array(BLOCK));
      let out = Array.from({ length: channels }, () => new Float32Array(BLOCK));
      let fill = 0;
      let at = 0;
      for await (const sample of sink.samples()) {
        try {
          if (sample.sampleRate !== rate || sample.numberOfChannels !== inChannels) throw new Error("The sound changes format along the file.");
          const position = Math.round((sample.timestamp - origin) * rate);
          const off = position - at;
          let skip = 0;
          let silence = 0;
          if (off > tolerance) silence = off;
          else if (off < -tolerance) skip = Math.min(sample.numberOfFrames, -off);
          // A hole in the sound: silence, so what follows stays in step with the picture.
          while (silence > 0) {
            const m = Math.min(silence, BLOCK - fill);
            fill += m;
            at += m;
            silence -= m;
            if (fill === BLOCK) {
              yield out;
              out = Array.from({ length: channels }, () => new Float32Array(BLOCK));
              fill = 0;
            }
          }
          let done = skip;
          while (done < sample.numberOfFrames) {
            const m = Math.min(sample.numberOfFrames - done, BLOCK - fill);
            planes.forEach((plane, c) => {
              if (inChannels >= 6 || c < channels) sample.copyTo(plane.subarray(0, m), { planeIndex: c, format: "f32-planar", frameOffset: done, frameCount: m });
            });
            toOut(planes, out, fill, m);
            done += m;
            fill += m;
            at += m;
            if (fill === BLOCK) {
              yield out;
              out = Array.from({ length: channels }, () => new Float32Array(BLOCK));
              fill = 0;
            }
          }
        } finally {
          sample.close();
        }
      }
      if (fill) yield out.map((ch) => ch.subarray(0, fill));
    },
  };
}

/**
 * The file as this browser can read it. Null when the container is not one Mediabunny reads: the
 * page then tries Web Audio, which takes the whole file at once.
 */
export async function openMedia(file: Blob): Promise<MediaFile | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    await input.getFormat();
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const origin = audio ? Math.max(0, await audio.getFirstTimestamp()) : 0;
    return { input, audio, video, origin, source: audio ? await streamOf(audio, origin).catch(() => null) : null };
  } catch {
    input.dispose();
    return null;
  }
}
