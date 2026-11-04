// The cleaned video: the same video packets copied as they are, never re-encoded, under the cleaned
// sound, in a new container of the same kind. What the file said about itself is left behind because
// nothing is carried over: no tag, no date, no other track (a second sound, GPS in a timed track,
// subtitles, chapters, a cover). The muxer is told not to stamp a date of its own.
//
// Runs in the check's worker. The sound is one track of AAC (MP4, MOV) or Opus (WebM), from the
// browser's encoder, or for AAC from a WebAssembly one loaded only where the browser has none.

import {
  AudioSample,
  AudioSampleSource,
  canEncodeAudio,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  MATROSKA,
  MkvOutputFormat,
  MovOutputFormat,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  StreamTarget,
  WEBM,
  WebMOutputFormat,
  type AudioCodec,
  type Input,
  type InputVideoTrack,
  type OutputFormat,
} from "mediabunny";
import type { Sink } from "./disk";

/** Why a video cannot come back as a video: the visitor gets the cleaned sound, and is told. */
export type Refusal = "encoder" | "container";

export type VideoPlan = { format: OutputFormat; codec: AudioCodec; bitrate: number; extension: string; type: string };

type Choice = { format: () => OutputFormat; codecs: AudioCodec[] };

/** Bits per second per channel: above where AAC and Opus leave anything a search could read as a line. AAC allows at most 6 bits per sample, so low rates get less. */
const bitrateFor = (sampleRate: number) => Math.min(96_000, 5 * sampleRate);

/** Seconds of sound handed to the encoder at a time, and how far the picture may run ahead of it. */
const STEP_SECONDS = 1;
const VIDEO_LEAD_SECONDS = 1;

/** The containers written, each as it came in. */
async function choiceFor(input: Input): Promise<Choice | null> {
  const format = await input.getFormat();
  if (format === MP4) return { format: () => new Mp4OutputFormat({ fastStart: false }), codecs: ["aac"] };
  if (format === QTFF) return { format: () => new MovOutputFormat({ fastStart: false }), codecs: ["aac"] };
  if (format === WEBM) return { format: () => new WebMOutputFormat(), codecs: ["opus"] };
  if (format === MATROSKA) return { format: () => new MkvOutputFormat(), codecs: ["aac", "opus"] };
  return null;
}

let registering: Promise<void> | null = null;

/** Whether this browser can write `codec`. A WebAssembly AAC encoder stands in for a missing native one. */
async function canEncode(codec: AudioCodec, config: { numberOfChannels: number; sampleRate: number; bitrate: number }): Promise<boolean> {
  if (await canEncodeAudio(codec, config)) return true;
  if (codec !== "aac") return false;
  try {
    registering ??= import("@mediabunny/aac-encoder").then(({ registerAacEncoder }) => registerAacEncoder());
    await registering;
    return await canEncodeAudio(codec, config);
  } catch {
    return false;
  }
}

/** How this file comes back as a video, or why it cannot. */
export async function planVideo(
  input: Input,
  video: InputVideoTrack,
  sound: { sampleRate: number; channels: number },
  can: typeof canEncode = canEncode,
): Promise<VideoPlan | { refused: Refusal }> {
  const choice = await choiceFor(input);
  if (!choice) return { refused: "container" };
  const format = choice.format();
  if (!video.codec || !format.getSupportedVideoCodecs().includes(video.codec)) return { refused: "container" };
  const bitrate = bitrateFor(sound.sampleRate) * sound.channels;
  for (const codec of choice.codecs) {
    if (await can(codec, { numberOfChannels: sound.channels, sampleRate: sound.sampleRate, bitrate })) return { format, codec, bitrate, extension: format.fileExtension.slice(1), type: format.mimeType };
  }
  return { refused: "encoder" };
}

/** Lets one side wait until the other has got far enough, or has finished. */
function gate() {
  let reached = 0;
  let waiting: (() => void) | null = null;
  const wake = () => {
    waiting?.();
    waiting = null;
  };
  return {
    open(to: number) {
      reached = to;
      wake();
    },
    async until(time: number) {
      while (time > reached) await new Promise<void>((resolve) => (waiting = resolve));
    },
  };
}

export type VideoWriter = {
  /** The next stretch of cleaned sound, every channel. */
  add(block: Float32Array[]): Promise<void>;
  /** The whole file, once every packet of the picture is in. */
  finish(): Promise<Blob>;
  /** Stops early and leaves nothing behind in memory. */
  cancel(): Promise<void>;
};

/** Starts the new file: `add` the cleaned sound, the picture follows along. */
export async function openVideoWriter(video: InputVideoTrack, plan: VideoPlan, sink: Sink, sound: { sampleRate: number; channels: number; origin: number }): Promise<VideoWriter> {
  const { sampleRate, channels, origin } = sound;
  const target = new StreamTarget(
    new WritableStream<{ type: "write"; data: Uint8Array; position: number }>({
      write(chunk) {
        sink.write(chunk.data, chunk.position);
      },
    }),
    { chunked: true },
  );
  const output = new Output({ format: plan.format, target });
  // Null, not left out: left out, the muxer stamps today's date on the file.
  output.setMetadataTags({ creationTime: null });

  const picture = new EncodedVideoPacketSource(video.codec!);
  output.addVideoTrack(picture, { rotation: video.rotation });
  const audio = new AudioSampleSource({ codec: plan.codec, bitrate: plan.bitrate });
  output.addAudioTrack(audio);
  await output.start();

  // The picture is far quicker than the sound, and the muxer holds what is ahead in memory.
  const soundAt = gate();
  let failure: unknown = null;
  const copying = (async () => {
    const meta = { decoderConfig: (await video.getDecoderConfig()) ?? undefined };
    for await (const packet of new EncodedPacketSink(video).packets(undefined, undefined, { verifyKeyPackets: true })) {
      await soundAt.until(packet.timestamp - VIDEO_LEAD_SECONDS);
      if (failure) return;
      await picture.add(packet, meta);
    }
    picture.close();
  })().catch((err) => {
    failure ??= err;
    soundAt.open(Infinity);
  });

  const step = Math.round(STEP_SECONDS * sampleRate);
  let at = 0;
  return {
    async add(block) {
      const n = block[0]?.length ?? 0;
      for (let i = 0; i < n; i += step) {
        if (failure) throw failure;
        const m = Math.min(step, n - i);
        const data = new Float32Array(m * channels);
        block.forEach((ch, c) => data.set(ch.subarray(i, i + m), c * m));
        const sample = new AudioSample({ data, format: "f32-planar", numberOfChannels: channels, sampleRate, timestamp: origin + at / sampleRate });
        await audio.add(sample);
        sample.close();
        at += m;
        soundAt.open(origin + at / sampleRate);
      }
    },
    async finish() {
      audio.close();
      soundAt.open(Infinity);
      await copying;
      if (failure) throw failure;
      await output.finalize();
      return sink.finish(plan.type);
    },
    async cancel() {
      failure ??= new Error("cancelled");
      soundAt.open(Infinity);
      await copying;
      await output.cancel().catch(() => {});
    },
  };
}
