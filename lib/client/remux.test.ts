import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, type AudioCodec, type InputAudioTrack, type InputVideoTrack } from "mediabunny";
import { describe, expect, it } from "vitest";
import { memorySink } from "./disk";
import { readMetadata } from "./metadata";
import { holdsTags, openVideoWriter, planCopy, planVideo, writeCopy, type VideoPlan } from "./remux";

// The cleaned video without a browser: real H.264 and VP9 packets, the sound as PCM (Node has no
// AAC or Opus encoder; e2e/check-video.spec.ts runs the real ones). tiny.mp4 is a phone's file in
// little: two sound tracks, a rotation, a place, a date and a device.
//
// ffmpeg -f lavfi -i testsrc=size=32x32:rate=4:duration=3 -f lavfi -i sine=300:... -f lavfi -i sine=500:...
//   -map 0:v -map 1:a -map 2:a -c:v libx264 -bf 2 -g 4 -c:a aac -b:a 16k -ac 1 -metadata creation_time=...
//   -metadata com.apple.quicktime.location.ISO6709=... -metadata com.apple.quicktime.model=... -movflags +use_metadata_tags tiny.mp4
// then ffmpeg -display_rotation 90 -i tiny.mp4 -map 0 -c copy -map_metadata 0 -movflags +use_metadata_tags
const bytesOf = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const open = (data: Uint8Array) => new Input({ source: new BlobSource(new Blob([data as BlobPart])), formats: ALL_FORMATS });

const RATE = 8000;
const SOUND = { sampleRate: RATE, channels: 2, origin: 0 };

async function clean(name: string, codec: AudioCodec = "pcm-s16") {
  const input = open(bytesOf(name));
  const video = (await input.getPrimaryVideoTrack()) as InputVideoTrack;
  const plan = await planVideo(input, video, SOUND, async () => true);
  if ("refused" in plan) throw new Error(plan.refused);
  const sink = memorySink();
  const writer = await openVideoWriter(video, { ...plan, codec } as VideoPlan, sink, SOUND);
  const left = Float32Array.from({ length: 3 * RATE }, (_, i) => 0.25 * Math.sin(i / 10));
  await writer.add([left, left.map((x) => -x)]);
  const blob = await writer.finish();
  return { input, video, left, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

async function packetsOf(track: InputVideoTrack | InputAudioTrack) {
  const out: { hash: string; type: string; timestamp: number }[] = [];
  for await (const p of new EncodedPacketSink(track).packets()) out.push({ hash: createHash("sha256").update(p.data).digest("hex"), type: p.type, timestamp: p.timestamp });
  return out;
}

/** Every box's type and where its payload is, however deep the known containers go. */
function boxes(bytes: Uint8Array, from = 0, to = bytes.length, out: { type: string; at: number; end: number }[] = []) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let pos = from; pos + 8 <= to; ) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    let head = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      head = 16;
    } else if (size === 0) size = to - pos;
    out.push({ type, at: pos + head, end: pos + size });
    if (["moov", "trak", "mdia"].includes(type)) boxes(bytes, pos + head, pos + size, out);
    pos += size;
  }
  return out;
}

describe("the copy without its tags", () => {
  it("holds the picture and the first sound as they were, and nothing the file said", async () => {
    const input = open(bytesOf("tiny.mp4"));
    expect(await holdsTags(input)).toBe(true);
    const plan = (await planCopy(input))!;
    expect([plan.extension, plan.type]).toEqual(["mp4", "video/mp4"]);
    const fractions: number[] = [];
    const blob = await writeCopy(plan, memorySink(), (fraction) => fractions.push(fraction));
    expect(fractions.at(-1)).toBeGreaterThan(0.9);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const back = open(bytes);
    const [picture, sound] = [(await back.getPrimaryVideoTrack())!, (await back.getPrimaryAudioTrack())!];
    expect((await back.getTracks()).length).toBe(2);
    expect(await packetsOf(picture)).toEqual(await packetsOf((await input.getPrimaryVideoTrack())!));
    expect(await packetsOf(sound)).toEqual(await packetsOf((await input.getPrimaryAudioTrack())!));
    expect(picture.rotation).toBe((await input.getPrimaryVideoTrack())!.rotation);
    expect(await back.getMetadataTags()).toEqual({});
    const said = await readMetadata(new Blob([bytes as BlobPart]));
    expect([said.location, said.createdAt, said.device]).toEqual([undefined, undefined, undefined]);
    // So nothing is offered for it.
    expect(await holdsTags(back)).toBe(false);
  });
});

describe("the cleaned video", () => {
  it("names no place, date or device, where the file it came from names them all", async () => {
    const before = await readMetadata(new Blob([bytesOf("tiny.mp4") as BlobPart]));
    expect(before.location?.lat).toBeCloseTo(48.7731);
    expect(before.createdAt?.source).toBe("com.apple.quicktime.creationdate");
    expect(before.device).toBe("Apple iPhone 15 Pro");
    const { bytes } = await clean("tiny.mp4");
    expect(await readMetadata(new Blob([bytes as BlobPart]))).toEqual({ format: "mp4" });
  });

  it("carries no date of any kind and no tag: not the muxer's own clock, nor a date in a track's header", async () => {
    const { bytes } = await clean("tiny.mp4");
    const all = boxes(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const stamped = all.filter((b) => ["mvhd", "tkhd", "mdhd"].includes(b.type));
    expect(stamped.length).toBe(1 + 2 + 2);
    for (const b of stamped) {
      const wide = bytes[b.at] === 1;
      expect(wide ? view.getBigUint64(b.at + 4) : BigInt(view.getUint32(b.at + 4))).toBe(0n);
      expect(wide ? view.getBigUint64(b.at + 12) : BigInt(view.getUint32(b.at + 8))).toBe(0n);
    }
    expect(all.map((b) => b.type)).not.toContain("udta");
    expect(all.map((b) => b.type)).not.toContain("meta");
    const text = Buffer.from(bytes).toString("latin1");
    for (const word of ["iPhone", "Apple", "48.7731", "ISO6709", "2026"]) expect(text).not.toContain(word);
  });

  it("holds the picture's packets byte for byte, in order, at their times", async () => {
    const { video, bytes } = await clean("tiny.mp4");
    const before = await packetsOf(video);
    const out = open(bytes);
    const after = await packetsOf((await out.getPrimaryVideoTrack())!);
    expect(before.length).toBeGreaterThan(5);
    expect(new Set(before.map((p) => p.type))).toEqual(new Set(["key", "delta"]));
    expect(after.map((p) => p.hash)).toEqual(before.map((p) => p.hash));
    expect(after.map((p) => p.type)).toEqual(before.map((p) => p.type));
    after.forEach((p, i) => expect(Math.abs(p.timestamp - before[i].timestamp)).toBeLessThan(1 / 1000));
    expect(await (await out.getPrimaryVideoTrack())!.getDecoderConfig()).toMatchObject({ codec: (await video.getDecoderConfig())!.codec });
  });

  it("keeps the rotation, and only the picture and the one cleaned sound", async () => {
    const { bytes, video, left } = await clean("tiny.mp4");
    expect(video.rotation).not.toBe(0);
    const out = open(bytes);
    const tracks = await out.getTracks();
    expect(tracks.map((t) => t.type).sort()).toEqual(["audio", "video"]);
    expect((await out.getPrimaryVideoTrack())!.rotation).toBe(video.rotation);
    const sound = (await out.getPrimaryAudioTrack())!;
    expect(sound.codec).toBe("pcm-s16");
    expect(sound.numberOfChannels).toBe(2);
    expect(sound.sampleRate).toBe(RATE);
    expect(await sound.computeDuration()).toBeCloseTo(left.length / RATE, 2);
  });

  it("is refused for a container it cannot write, or with no encoder, and says which", async () => {
    const input = open(bytesOf("tiny.mp4"));
    const video = (await input.getPrimaryVideoTrack())!;
    expect(await planVideo(input, video, SOUND, async () => false)).toEqual({ refused: "encoder" });
    const webm = open(bytesOf("tiny.webm"));
    const plan = await planVideo(webm, (await webm.getPrimaryVideoTrack())!, SOUND, async () => true);
    expect(plan).toMatchObject({ codec: "opus", extension: "webm" });
    const notVideo = { getFormat: async () => ({}) } as unknown as Input;
    expect(await planVideo(notVideo, video, SOUND, async () => true)).toEqual({ refused: "container" });
  });
});

describe("a sink in memory", () => {
  it("lets a later write replace an earlier one, wherever it falls", async () => {
    const sink = memorySink();
    sink.write(new TextEncoder().encode("aaaa"), 0);
    sink.write(new TextEncoder().encode("bbbbbb"), 4);
    sink.write(new TextEncoder().encode("XY"), 2);
    sink.write(new TextEncoder().encode("Z"), 9);
    const blob = await sink.finish("text/plain");
    expect(blob.type).toBe("text/plain");
    expect(await blob.text()).toBe("aaXYbbbbbZ");
  });
});
