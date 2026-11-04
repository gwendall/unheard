// The cleaned video: the same video packets copied as they are, never re-encoded, under the cleaned
// sound, in a new container of the same kind. What the file said about itself is left behind because
// nothing is carried over: no tag, no date, no other track (a second sound, GPS in a timed track,
// subtitles, chapters, a cover). The muxer is told not to stamp a date of its own.
//
// Runs in the check's worker. The sound is one track of AAC (MP4, MOV) or Opus (WebM), from the
// browser's encoder, or for AAC from a WebAssembly one loaded only where the browser has none.
//
// The copy without its tags takes the same road and encodes nothing: picture and sound, each packet
// as it is, in a new container of the same kind (`planCopy`, `writeCopy`), for sound files as well.

import {
  ADTS,
  AdtsOutputFormat,
  AudioSample,
  AudioSampleSource,
  canEncodeAudio,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  FLAC,
  FlacOutputFormat,
  MATROSKA,
  MkvOutputFormat,
  MovOutputFormat,
  MP3,
  Mp3OutputFormat,
  MP4,
  Mp4OutputFormat,
  OGG,
  OggOutputFormat,
  Output,
  QTFF,
  StreamTarget,
  WAVE,
  WavOutputFormat,
  WEBM,
  WebMOutputFormat,
  type AudioCodec,
  type EncodedPacket,
  type Input,
  type InputAudioTrack,
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

/** The new file, with nothing said about itself. */
function outputTo(format: OutputFormat, sink: Sink): Output {
  const target = new StreamTarget(
    new WritableStream<{ type: "write"; data: Uint8Array; position: number }>({
      write(chunk) {
        sink.write(chunk.data, chunk.position);
      },
    }),
    { chunked: true },
  );
  const output = new Output({ format, target });
  // Null, not left out: left out, the muxer stamps today's date on the file.
  output.setMetadataTags({ creationTime: null });
  return output;
}

/** Starts the new file: `add` the cleaned sound, the picture follows along. */
export async function openVideoWriter(video: InputVideoTrack, plan: VideoPlan, sink: Sink, sound: { sampleRate: number; channels: number; origin: number }): Promise<VideoWriter> {
  const { sampleRate, channels, origin } = sound;
  const output = outputTo(plan.format, sink);

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

/** What a sound file comes back as, each as it came in. */
async function soundFormatFor(input: Input): Promise<OutputFormat | null> {
  const format = await input.getFormat();
  if (format === MP3) return new Mp3OutputFormat();
  if (format === WAVE) return new WavOutputFormat();
  if (format === FLAC) return new FlacOutputFormat();
  if (format === OGG) return new OggOutputFormat();
  if (format === ADTS) return new AdtsOutputFormat();
  return null;
}

/** What is copied without its tags, and into what. */
export type CopyPlan = { format: OutputFormat; video: InputVideoTrack | null; audio: InputAudioTrack | null; extension: string; type: string };

/** How this file comes back without its tags, or null when we cannot write it so: a track that could not come across would make the copy another file. */
export async function planCopy(input: Input): Promise<CopyPlan | null> {
  const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
  if (!video && !audio) return null;
  const format = (await choiceFor(input))?.format() ?? (await soundFormatFor(input));
  if (!format) return null;
  if (video && (!video.codec || !format.getSupportedVideoCodecs().includes(video.codec))) return null;
  if (audio && (!audio.codec || !format.getSupportedAudioCodecs().includes(audio.codec))) return null;
  // An MP4 with no picture is an M4A to everything that opens it.
  const soundOnly = !video && format instanceof Mp4OutputFormat;
  return { format, video, audio, extension: soundOnly ? "m4a" : format.fileExtension.slice(1), type: soundOnly ? "audio/mp4" : format.mimeType };
}

/** Tags that only name the software that wrote the file. Nearly every file has one, this copy too: alone, they are no reason to offer it. */
const WRITERS = new Set(["©TOO", "TSSE", "ISFT", "ENCODER", "VENDOR"]);

/** Whether a copy would leave something behind: a tag that says more than the software's name, or a track beyond the picture and the sound. */
export async function holdsTags(input: Input): Promise<boolean> {
  const [{ raw, ...named }, tracks] = await Promise.all([input.getMetadataTags(), input.getTracks()]);
  if (Object.keys(named).length > 0 || Object.keys(raw ?? {}).some((key) => !WRITERS.has(key.toUpperCase()))) return true;
  const pictures = tracks.filter((t) => t.isVideoTrack()).length;
  const sounds = tracks.filter((t) => t.isAudioTrack()).length;
  return tracks.length > Math.min(1, pictures) + Math.min(1, sounds);
}

/** The picture and the sound copied as they are, in the order of their times, so the muxer holds little in memory. */
export async function writeCopy(plan: CopyPlan, sink: Sink, onProgress?: (fraction: number) => void): Promise<Blob> {
  const { video, audio } = plan;
  const output = outputTo(plan.format, sink);
  const picture = video && new EncodedVideoPacketSource(video.codec!);
  if (picture) output.addVideoTrack(picture, { rotation: video.rotation });
  const sound = audio && new EncodedAudioPacketSource(audio.codec!);
  if (sound) output.addAudioTrack(sound);
  await output.start();
  try {
    const seconds = Math.max(...(await Promise.all([video?.computeDuration() ?? 0, audio?.computeDuration() ?? 0])));
    const pictureMeta = { decoderConfig: (await video?.getDecoderConfig()) ?? undefined };
    const soundMeta = { decoderConfig: (await audio?.getDecoderConfig()) ?? undefined };
    const pictures = video ? new EncodedPacketSink(video).packets(undefined, undefined, { verifyKeyPackets: true })[Symbol.asyncIterator]() : null;
    const sounds = audio ? new EncodedPacketSink(audio).packets()[Symbol.asyncIterator]() : null;
    const next = async (from: AsyncIterator<EncodedPacket> | null) => (from ? ((await from.next()).value as EncodedPacket | undefined) : undefined);
    let p = await next(pictures);
    let a = await next(sounds);
    while (p || a) {
      const pictureFirst = !!p && (!a || p.timestamp <= a.timestamp);
      const at = pictureFirst ? p!.timestamp : a!.timestamp;
      if (pictureFirst) {
        await picture!.add(p!, pictureMeta);
        p = await next(pictures);
      } else {
        await sound!.add(a!, soundMeta);
        a = await next(sounds);
      }
      if (seconds > 0) onProgress?.(Math.min(1, at / seconds));
    }
    picture?.close();
    sound?.close();
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  }
  return sink.finish(plan.type);
}
