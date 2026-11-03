import { describe, expect, it } from "vitest";
import { readMetadata, type FileMetadata, type SliceableFile } from "./metadata";

// Every file here is written byte by byte.

type Part = string | number[] | Uint8Array;

/** Strings are one byte per character, so "©xyz" opens with the 0xa9 of the format. */
function cat(...parts: Part[]): Uint8Array<ArrayBuffer> {
  const chunks = parts.map((p) => (typeof p === "string" ? Uint8Array.from(p, (c) => c.charCodeAt(0)) : Uint8Array.from(p)));
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const zeros = (n: number) => new Uint8Array(n);
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u64 = (n: bigint) => [...u32(Number(n >> 32n)), ...u32(Number(n & 0xffffffffn))];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

function box(type: string, ...parts: Part[]) {
  const body = cat(...parts);
  return cat(u32(8 + body.length), type, body);
}

const ftyp = (brand = "isom") => box("ftyp", brand, u32(512), brand);
const moov = (...parts: Part[]) => box("moov", ...parts);

const TO_1904 = 2_082_844_800;
const seconds = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
const WHEN = seconds(2023, 4, 3, 8, 33, 22);

const mvhd = (unix: number) => box("mvhd", [0, 0, 0, 0], u32(unix + TO_1904), u32(unix + TO_1904), u32(600), u32(0), zeros(80));
const mvhd1 = (unix: number) => box("mvhd", [1, 0, 0, 0], u64(BigInt(unix + TO_1904)), u64(BigInt(unix + TO_1904)), u32(600), u64(0n), zeros(80));
const text = (type: string, value: string) => box(type, u16(utf8(value).length), u16(0x15c7), utf8(value));
const data = (value: string) => box("data", u32(1), u32(0), utf8(value));

/** QuickTime's `meta`: the names in `keys`, the values in `ilst` under the number of their key. */
function keyed(values: Record<string, string>) {
  const entries = Object.entries(values);
  const keys = box("keys", u32(0), u32(entries.length), ...entries.map(([k]) => cat(u32(8 + utf8(k).length), "mdta", utf8(k))));
  const list = box("ilst", ...entries.map(([, v], i) => cat(u32(8 + data(v).length), u32(i + 1), data(v))));
  return box("meta", box("hdlr", zeros(24)), keys, list);
}

/** A stand-in for a huge file: `fill` writes what any read sees, and every read is counted. */
function fake(size: number, fill: (start: number, out: Uint8Array) => void, failAfter = Infinity) {
  const reads: number[] = [];
  const file: SliceableFile = {
    size,
    slice: (start, end) => ({
      arrayBuffer: async () => {
        if (reads.length >= failAfter) throw new Error("the file went away");
        reads.push(end - start);
        const out = new Uint8Array(end - start);
        fill(start, out);
        return out.buffer;
      },
    }),
  };
  return { file, reads };
}

function placed(pieces: [number, Uint8Array][]) {
  return (start: number, out: Uint8Array) => {
    for (const [at, piece] of pieces) {
      for (let i = Math.max(at, start); i < Math.min(at + piece.length, start + out.length); i++) out[i - start] = piece[i - at];
    }
  };
}

const read = (bytes: Uint8Array<ArrayBuffer>) => readMetadata(new Blob([bytes]));

describe("readMetadata, MP4 and MOV", () => {
  it("reads the creation time of mvhd, 32 and 64 bits", async () => {
    expect(await read(cat(ftyp(), moov(mvhd(WHEN))))).toEqual({ format: "mp4", createdAt: { utc: WHEN, source: "mvhd", precision: "second" } });
    expect((await read(cat(ftyp(), moov(mvhd1(WHEN))))).createdAt?.utc).toBe(WHEN);
  });

  it("takes an mvhd of 0 as unset, and a date from before video as a bad clock", async () => {
    const unset = box("mvhd", [0, 0, 0, 0], u32(0), u32(0), u32(600), u32(0), zeros(80));
    expect(await read(cat(ftyp(), moov(unset)))).toEqual({ format: "mp4" });
    expect(await read(cat(ftyp(), moov(mvhd(seconds(1970, 1, 1)))))).toEqual({ format: "mp4" });
    expect(await read(cat(ftyp(), moov(box("mvhd", [9, 0, 0, 0], u32(WHEN + TO_1904), zeros(90)))))).toEqual({ format: "mp4" });
  });

  it("names the format from the brand", async () => {
    expect((await read(cat(ftyp("qt  "), moov()))).format).toBe("mov");
    expect((await read(cat(ftyp("M4A "), moov()))).format).toBe("m4a");
    expect((await read(cat(ftyp("mp42"), moov()))).format).toBe("mp4");
    expect((await read(moov(mvhd(WHEN)))).format).toBe("mov");
    expect((await read(cat(box("wide"), box("mdat", zeros(16)), moov(mvhd(WHEN))))).createdAt?.utc).toBe(WHEN);
  });

  it("finds a moov after a 64-bit mdat of 3 GB without reading it", async () => {
    const head = cat(ftyp(), cat(u32(1), "mdat", u64(3_000_000_000n)));
    const tail = moov(mvhd(WHEN), box("trak", zeros(1000)), box("udta", text("©xyz", "+48.8566+002.3522/")));
    const at = ftyp().length + 3_000_000_000;
    const { file, reads } = fake(at + tail.length, placed([[0, head], [at, tail]]));
    const found = await readMetadata(file);
    expect(found.createdAt?.utc).toBe(WHEN);
    expect(found.location).toEqual({ lat: 48.8566, lon: 2.3522, source: "©xyz" });
    expect(reads.reduce((sum, n) => sum + n, 0)).toBeLessThan(400);
  });

  it("reads udta/©xyz in each form of ISO 6709", async () => {
    const place = async (value: string) => (await read(cat(ftyp(), moov(box("udta", text("©xyz", value)))))).location;
    expect(await place("+48.8566+002.3522/")).toEqual({ lat: 48.8566, lon: 2.3522, source: "©xyz" });
    expect(await place("-33.8688+151.2093+058.5/")).toEqual({ lat: -33.8688, lon: 151.2093, altitude: 58.5, source: "©xyz" });
    expect(await place("+37.4220-122.0841-012.0CRSWGS_84/")).toEqual({ lat: 37.422, lon: -122.0841, altitude: -12, source: "©xyz" });
    const minutes = await place("+4851.396+00221.132/");
    expect(minutes?.lat).toBeCloseTo(48.8566, 6);
    expect(minutes?.lon).toBeCloseTo(2.3522, 6);
    const dms = await place("+485123.76+0022107.92/");
    expect(dms?.lat).toBeCloseTo(48.8566, 6);
    expect(dms?.lon).toBeCloseTo(2.3522, 6);
  });

  it("refuses a place that cannot be one, and 0, 0, which is a device with no fix", async () => {
    for (const value of ["+91.0000+002.0000/", "+48.0000+181.0000/", "+4890.00+00221.00/", "+00.0000+000.0000/", "here", "+48.8566", "+123456789+002.0/", ""]) {
      expect((await read(cat(ftyp(), moov(box("udta", text("©xyz", value)))))).location).toBeUndefined();
    }
  });

  it("reads a udta text with no length and language before it", async () => {
    const found = await read(cat(ftyp(), moov(box("udta", box("©xyz", "+48.8566+002.3522/")))));
    expect(found.location).toEqual({ lat: 48.8566, lon: 2.3522, source: "©xyz" });
  });

  it("reads QuickTime's keys and ilst", async () => {
    const found = await read(
      cat(
        ftyp("qt  "),
        moov(
          mvhd(WHEN + 3600),
          keyed({
            "com.apple.quicktime.location.ISO6709": "+48.8566+002.3522+035.000/",
            "com.apple.quicktime.make": "Apple",
            "com.apple.quicktime.model": "iPhone 15 Pro",
            "com.apple.quicktime.software": "17.1",
            "com.apple.quicktime.creationdate": "2023-04-03T10:33:22+0200",
          }),
        ),
      ),
    );
    expect(found).toEqual({
      format: "mov",
      createdAt: { utc: WHEN, offsetMinutes: 120, source: "com.apple.quicktime.creationdate", precision: "second" },
      location: { lat: 48.8566, lon: 2.3522, altitude: 35, source: "com.apple.quicktime.location.ISO6709" },
      device: "Apple iPhone 15 Pro",
    });
  });

  it("reads keys and ilst in a udta's meta with ISO's version and flags, in either order", async () => {
    const inner = keyed({ "com.apple.quicktime.model": "iPhone 12" });
    const full = box("meta", [0, 0, 0, 0], inner.subarray(8));
    expect((await read(cat(ftyp(), moov(box("udta", full))))).device).toBe("iPhone 12");
    const keys = cat(u32(8 + 8 + 8 + 25), "keys", u32(0), u32(1), u32(8 + 25), "mdta", "com.apple.quicktime.model");
    const list = box("ilst", cat(u32(8 + data("iPhone 13").length), u32(1), data("iPhone 13")));
    expect((await read(cat(ftyp(), moov(box("meta", list, keys))))).device).toBe("iPhone 13");
  });

  it("reads com.android's maker and model, with Samsung's zone on the mvhd time", async () => {
    const meta = keyed({ "com.android.manufacturer": "samsung", "com.android.model": "SM-S918B", "samsung.android.utc_offset": "-0500" });
    expect(await read(cat(ftyp("mp42"), moov(mvhd(WHEN), meta)))).toEqual({
      format: "mp4",
      createdAt: { utc: WHEN, offsetMinutes: -300, source: "mvhd", precision: "second" },
      device: "samsung SM-S918B",
    });
    const named = keyed({ "com.android.manufacturer": "Google", "com.android.model": "Google Pixel 8" });
    expect((await read(cat(ftyp(), moov(named)))).device).toBe("Google Pixel 8");
    expect((await read(cat(ftyp(), moov(keyed({ "com.android.manufacturer": "Google" }))))).device).toBe("Google");
  });

  it("prefers a stated zone, then mvhd, then a clock with no zone", async () => {
    const creation = "com.apple.quicktime.creationdate";
    const bare = keyed({ [creation]: "2023-04-03T10:33:22" });
    expect((await read(cat(ftyp(), moov(mvhd(WHEN), bare)))).createdAt?.source).toBe("mvhd");
    expect(await read(cat(ftyp(), moov(bare)))).toMatchObject({ createdAt: { utc: seconds(2023, 4, 3, 10, 33, 22), source: creation } });
    const day = box("udta", text("©day", "2023-04-03T08:33:22Z"));
    expect((await read(cat(ftyp(), moov(mvhd(WHEN + 60), day)))).createdAt).toEqual({ utc: WHEN, offsetMinutes: 0, source: "©day", precision: "second" });
    const both = keyed({ [creation]: "2023-04-03T10:33:22+02:00" });
    expect((await read(cat(ftyp(), moov(day, both)))).createdAt?.source).toBe(creation);
  });

  it("goes through the MP4 path for an M4A with iTunes-style tags, and never reads the cover", async () => {
    const cover = box("covr", box("data", u32(13), u32(0), zeros(100_000)));
    const day = box("©day", data("2024-05-03T10:12:13Z"));
    const mod = box("©mod", data("Voice Recorder"));
    const meta = box("meta", [0, 0, 0, 0], box("hdlr", zeros(24)), box("ilst", cover, day, mod));
    const bytes = cat(ftyp("M4A "), moov(box("udta", meta)));
    const { file, reads } = fake(bytes.length, placed([[0, bytes]]));
    expect(await readMetadata(file)).toEqual({
      format: "m4a",
      createdAt: { utc: seconds(2024, 5, 3, 10, 12, 13), offsetMinutes: 0, source: "©day", precision: "second" },
      device: "Voice Recorder",
    });
    expect(Math.max(...reads)).toBeLessThan(100);
  });

  it("says how much of a date the file gives", async () => {
    const dated = async (value: string) => (await read(cat(ftyp(), moov(box("udta", text("©day", value)))))).createdAt;
    expect(await dated("2024")).toEqual({ utc: seconds(2024, 1, 1), source: "©day", precision: "year" });
    expect(await dated("2024-05")).toEqual({ utc: seconds(2024, 5, 1), source: "©day", precision: "month" });
    expect(await dated("2024-05-03")).toEqual({ utc: seconds(2024, 5, 3), source: "©day", precision: "day" });
    expect(await dated("2024:05:03 10:12")).toEqual({ utc: seconds(2024, 5, 3, 10, 12), source: "©day", precision: "minute" });
    for (const nonsense of ["2024-13-01", "2023-02-29", "2024-05-03T25:00", "0099-01-01", "2024-05-03T10:12:13+9900", "May 2024", "2024 or so", "9999"]) {
      expect(await dated(nonsense)).toBeUndefined();
    }
  });
});

function bext(date: string, time: string, originator = "") {
  const fixed = zeros(602);
  fixed.set(utf8(originator), 256);
  fixed.set(utf8(date), 320);
  fixed.set(utf8(time), 330);
  return fixed;
}

const chunk = (type: string, ...parts: Part[]) => {
  const body = cat(...parts);
  return cat(type, le32(body.length), body, body.length % 2 ? [0] : []);
};
const wav = (...parts: Part[]) => {
  const body = cat("WAVE", ...parts);
  return cat("RIFF", le32(body.length), body);
};
const fmt = chunk("fmt ", zeros(16));
const info = (value: string) => chunk("LIST", "INFO", chunk("ISFT", "Lavf"), chunk("ICRD", value));

describe("readMetadata, WAV", () => {
  it("reads bext's origination date and time, and its originator", async () => {
    expect(await read(wav(fmt, chunk("bext", bext("2024-05-03", "10:12:13", "ZOOM F3")), chunk("data", zeros(4))))).toEqual({
      format: "wav",
      createdAt: { utc: seconds(2024, 5, 3, 10, 12, 13), source: "bext", precision: "second" },
      device: "ZOOM F3",
    });
  });

  it("takes bext's other separators, a date alone, and all zeros as unset", async () => {
    expect((await read(wav(chunk("bext", bext("2024_05_03", "10.12.13"))))).createdAt?.utc).toBe(seconds(2024, 5, 3, 10, 12, 13));
    expect((await read(wav(chunk("bext", bext("2024-05-03", ""))))).createdAt).toEqual({ utc: seconds(2024, 5, 3), source: "bext", precision: "day" });
    expect(await read(wav(chunk("bext", zeros(602))))).toEqual({ format: "wav" });
    expect(await read(wav(chunk("bext", bext("0000-00-00", "00:00:00"))))).toEqual({ format: "wav" });
  });

  it("reads LIST/INFO/ICRD, after an odd chunk and after the data", async () => {
    const found = await read(wav(fmt, chunk("JUNK", zeros(3)), chunk("data", zeros(5)), info("2024-05-03")));
    expect(found).toEqual({ format: "wav", createdAt: { utc: seconds(2024, 5, 3), source: "ICRD", precision: "day" } });
    expect(await read(wav(info("a Tuesday")))).toEqual({ format: "wav" });
  });

  it("prefers bext to ICRD, in either order", async () => {
    const b = chunk("bext", bext("2024-05-03", "10:12:13"));
    expect((await read(wav(info("2020-01-01"), b))).createdAt?.source).toBe("bext");
    expect((await read(wav(b, info("2020-01-01")))).createdAt?.source).toBe("bext");
  });

  it("reads an RF64 up to its data chunk, whose size is not in the chunk", async () => {
    const body = cat("WAVE", chunk("ds64", zeros(28)), chunk("bext", bext("2024-05-03", "10:12:13")), "data", u32(0xffffffff), zeros(32));
    expect((await read(cat("RF64", u32(0xffffffff), body))).createdAt?.source).toBe("bext");
  });
});

const synchsafe = (n: number) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];

function id3(version: number, frames: Uint8Array[], flags = 0, extra: Part = []) {
  const body = cat(extra, ...frames);
  return cat("ID3", [version, 0, flags], synchsafe(body.length), body, [0xff, 0xfb, 0x90, 0x00]);
}
const frame24 = (id: string, ...value: Part[]) => {
  const body = cat(...value);
  return cat(id, synchsafe(body.length), [0, 0], body);
};
const frame23 = (id: string, ...value: Part[]) => {
  const body = cat(...value);
  return cat(id, u32(body.length), [0, 0], body);
};
const frame22 = (id: string, ...value: Part[]) => {
  const body = cat(...value);
  return cat(id, [0, 0, body.length], body);
};

describe("readMetadata, MP3", () => {
  it("reads TDRC of ID3v2.4, past a large picture it does not read", async () => {
    const bytes = id3(4, [frame24("APIC", zeros(200_000)), frame24("TDRC", [3], "2024-05-03T10:12:13")]);
    const { file, reads } = fake(bytes.length, placed([[0, bytes]]));
    expect(await readMetadata(file)).toEqual({ format: "mp3", createdAt: { utc: seconds(2024, 5, 3, 10, 12, 13), source: "TDRC", precision: "second" } });
    expect(Math.max(...reads)).toBeLessThan(100);
  });

  it("puts TYER, TDAT and TIME of ID3v2.3 together", async () => {
    const whole = id3(3, [frame23("TYER", [0], "2024"), frame23("TDAT", [0], "0305"), frame23("TIME", [0], "1012")]);
    expect((await read(whole)).createdAt).toEqual({ utc: seconds(2024, 5, 3, 10, 12), source: "TYER", precision: "minute" });
    expect((await read(id3(3, [frame23("TYER", [0], "2024")]))).createdAt).toEqual({ utc: seconds(2024, 1, 1), source: "TYER", precision: "year" });
  });

  it("prefers TDRC to TYER, and reads ID3v2.2's TYE", async () => {
    expect((await read(id3(3, [frame23("TYER", [0], "2020"), frame23("TDRC", [0], "2024-05-03")]))).createdAt?.source).toBe("TDRC");
    expect((await read(id3(2, [frame22("TAL", [0], "An album"), frame22("TYE", [0], "2024")]))).createdAt).toEqual({ utc: seconds(2024, 1, 1), source: "TYER", precision: "year" });
  });

  it("reads each text encoding, a list of values, and stops at the padding", async () => {
    const utf16 = (value: string, bom: number[], swap: boolean) => cat([1], bom, Uint8Array.from([...value].flatMap((c) => (swap ? [0, c.charCodeAt(0)] : [c.charCodeAt(0), 0]))));
    const expected = seconds(2024, 5, 3);
    expect((await read(id3(4, [frame24("TDRC", utf16("2024-05-03", [0xff, 0xfe], false))]))).createdAt?.utc).toBe(expected);
    expect((await read(id3(4, [frame24("TDRC", utf16("2024-05-03", [0xfe, 0xff], true))]))).createdAt?.utc).toBe(expected);
    expect((await read(id3(4, [frame24("TDRC", [2], Uint8Array.from([..."2024-05-03"].flatMap((c) => [0, c.charCodeAt(0)])))]))).createdAt?.utc).toBe(expected);
    expect((await read(id3(4, [frame24("TDRC", [3], "2024-05-03\0", "1999")]))).createdAt?.utc).toBe(expected);
    expect((await read(id3(4, [frame24("TLAN", [3], "fra"), zeros(64), frame24("TDRC", [3], "2024-05-03")]))).createdAt).toBeUndefined();
  });

  it("skips an extended header, and undoes unsynchronisation", async () => {
    expect((await read(id3(3, [frame23("TYER", [0], "2024")], 0x40, [...u32(6), ...zeros(6)]))).createdAt?.source).toBe("TYER");
    expect((await read(id3(4, [frame24("TDRC", [3], "2024")], 0x40, [...synchsafe(6), 1, 0])))).toMatchObject({ createdAt: { source: "TDRC" } });
    const stuffed = cat([1, 0xff, 0x00, 0xfe], Uint8Array.from([..."2024"].flatMap((c) => [c.charCodeAt(0), 0])));
    expect((await read(id3(3, [frame23("TYER", stuffed)], 0x80))).createdAt?.source).toBe("TYER");
  });

  it("knows an MP3 with no tag", async () => {
    expect(await read(cat([0xff, 0xfb, 0x90, 0x00], zeros(64)))).toEqual({ format: "mp3" });
  });
});

describe("readMetadata, anything else", () => {
  it("returns just the format", async () => {
    expect(await read(cat("OggS", zeros(32)))).toEqual({ format: "ogg" });
    expect(await read(cat("fLaC", zeros(32)))).toEqual({ format: "flac" });
    expect(await read(cat([0x1a, 0x45, 0xdf, 0xa3], zeros(32)))).toEqual({ format: "webm" });
    expect(await read(cat([0xff, 0xf1, 0x50, 0x80], zeros(32)))).toEqual({ format: "aac" });
    expect(await read(cat("RIFF", u32(4), "AVI "))).toEqual({ format: "unknown" });
    expect(await read(utf8("just some text, long enough"))).toEqual({ format: "unknown" });
    expect(await read(zeros(0))).toEqual({ format: "unknown" });
    expect(await read(zeros(1))).toEqual({ format: "unknown" });
  });
});

const FIXTURES: Record<string, Uint8Array<ArrayBuffer>> = {
  "mvhd and udta": cat(ftyp(), moov(mvhd(WHEN), box("udta", text("©xyz", "+48.8566+002.3522+035.000/"), text("©mod", "Pixel 8")))),
  "keys and ilst": cat(
    ftyp("qt  "),
    moov(
      keyed({
        "com.apple.quicktime.creationdate": "2023-04-03T10:33:22+0200",
        "com.apple.quicktime.location.ISO6709": "+48.8566+002.3522+035.000/",
        "com.apple.quicktime.model": "iPhone 15 Pro",
      }),
    ),
  ),
  "64-bit mdat first": cat(ftyp(), cat(u32(1), "mdat", u64(32n), zeros(16)), moov(mvhd1(WHEN))),
  bext: wav(fmt, chunk("bext", bext("2024-05-03", "10:12:13", "ZOOM F3")), chunk("data", zeros(8))),
  ICRD: wav(fmt, chunk("data", zeros(8)), info("2024-05-03")),
  TDRC: id3(4, [frame24("TIT2", [3], "A title"), frame24("TDRC", [3], "2024-05-03T10:12:13")]),
  TYER: id3(3, [frame23("TYER", [0], "2024"), frame23("TDAT", [0], "0305"), frame23("TIME", [0], "1012")]),
};

/**
 * All a cut file may say is what the whole file says: never half a place or half a time. ID3v2.3
 * splits a date over three frames, so losing the last ones leaves a coarser date, which says so.
 */
function expectOnlyTrue(found: FileMetadata, truth: FileMetadata) {
  if (found.createdAt?.source === "TYER" && truth.createdAt && found.createdAt.precision !== truth.createdAt.precision) {
    const start = new Date(found.createdAt.utc * 1000).toISOString();
    const whole = new Date(truth.createdAt.utc * 1000).toISOString();
    expect(start.slice(0, 4)).toBe(whole.slice(0, 4));
    expect(found.createdAt.precision).toMatch(/year|day/);
    if (found.createdAt.precision === "day") expect(start.slice(0, 10)).toBe(whole.slice(0, 10));
  } else if (found.createdAt) expect(found.createdAt).toEqual(truth.createdAt);
  if (found.location) expect(found.location).toEqual(truth.location);
  if (found.device) expect(found.device).toEqual(truth.device);
}

describe("readMetadata, truncated and hostile files", () => {
  it("never makes up a value, cut at any byte", async () => {
    for (const bytes of Object.values(FIXTURES)) {
      const truth = await read(bytes);
      expect(Object.keys(truth).length).toBeGreaterThan(1);
      for (let n = 0; n < bytes.length; n++) expectOnlyTrue(await read(bytes.slice(0, n)), truth);
    }
  });

  it("keeps what it found before the file ended", async () => {
    const bytes = FIXTURES["mvhd and udta"];
    const cut = bytes.length - 10;
    expect((await read(bytes.slice(0, cut))).createdAt?.utc).toBe(WHEN);
  });

  it("stops at a size that would not move forward or that overruns everything", async () => {
    const after = moov(mvhd(WHEN));
    const cases: Uint8Array<ArrayBuffer>[] = [
      cat(ftyp(), u32(4), "free", after),
      cat(ftyp(), u32(7), "free", after),
      cat(ftyp(), u32(1), "free", u64(0n), after),
      cat(ftyp(), u32(1), "free", u64(8n), after),
      cat(ftyp(), u32(1), "free", u64(15n), after),
      cat(ftyp(), u32(1), "free", u64(0xffffffffffffffffn), after),
      cat(ftyp(), u32(1), "free"),
      cat(ftyp(), u32(0xffffffff), "free", after),
    ];
    for (const bytes of cases) expect(await read(bytes)).toEqual({ format: "mp4" });
    // Size 0 runs to the end of the file at the top level, and ends a list further in.
    expect(await read(cat(ftyp(), u32(0), "mdat", after))).toEqual({ format: "mp4" });
    expect((await read(cat(ftyp(), moov(mvhd(WHEN), u32(0), box("udta", text("©xyz", "+48.8566+002.3522/"))))))).toEqual({
      format: "mp4",
      createdAt: { utc: WHEN, source: "mvhd", precision: "second" },
    });
  });

  it("refuses a box that claims more than its parent holds", async () => {
    const liar = cat(u32(10_000), "©xyz", u16(18), u16(0), "+48.8566+002.3522/");
    expect(await read(cat(ftyp(), moov(box("udta", liar))))).toEqual({ format: "mp4" });
  });

  it("stops at the depth cap on nested udta", async () => {
    let nested = box("©xyz", "+48.8566+002.3522/");
    for (let i = 0; i < 500; i++) nested = box("udta", nested);
    expect(await read(cat(ftyp(), moov(nested)))).toEqual({ format: "mp4" });
    let shallow = box("©xyz", "+48.8566+002.3522/");
    for (let i = 0; i < 3; i++) shallow = box("udta", shallow);
    expect((await read(cat(ftyp(), moov(shallow)))).location?.lat).toBe(48.8566);
  });

  it("stops at the box cap on a gigabyte of empty boxes, chunks or frames", { timeout: 5000 }, async () => {
    const repeating = (open: Uint8Array, unit: Uint8Array) => (start: number, out: Uint8Array) => {
      for (let i = 0; i < out.length; i++) {
        const at = start + i;
        out[i] = at < open.length ? open[at] : unit[(at - open.length) % unit.length];
      }
    };
    const GB = 1024 ** 3;
    const flood: [Uint8Array, Uint8Array, string][] = [
      [ftyp(), box("free"), "mp4"],
      [cat("RIFF", le32(0xffffffff), "WAVE"), chunk("JUNK"), "wav"],
      [cat("ID3", [4, 0, 0], [0x7f, 0x7f, 0x7f, 0x7f]), frame24("TXXX"), "mp3"],
    ];
    for (const [open, unit, format] of flood) {
      const { file, reads } = fake(GB, repeating(open, unit));
      expect(await readMetadata(file)).toEqual({ format });
      expect(reads.length).toBeLessThan(5000);
    }
  });

  it("does not go past the budget on many large values", { timeout: 5000 }, async () => {
    const big = box("meta", [0, 0, 0, 0], box("keys", zeros(60_000)));
    const bytes = cat(ftyp(), moov(box("udta", ...Array.from({ length: 2000 }, () => big))));
    const { file, reads } = fake(bytes.length, placed([[0, bytes]]));
    expect(await readMetadata(file)).toEqual({ format: "mp4" });
    expect(reads.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("keeps what it found when a read fails, and never throws", async () => {
    const bytes = cat(ftyp(), moov(mvhd(WHEN), box("udta", text("©xyz", "+48.8566+002.3522/"))));
    const found = [];
    for (let failAfter = 0; failAfter < 10; failAfter++) {
      found.push(await readMetadata(fake(bytes.length, placed([[0, bytes]]), failAfter).file));
    }
    expect(found[0]).toEqual({ format: "unknown" });
    expect(found.at(-1)?.location?.lat).toBe(48.8566);
    expect(found.some((f) => f.createdAt && !f.location)).toBe(true);

    const thrower: SliceableFile = {
      size: 100,
      slice: () => {
        throw new Error("no");
      },
    };
    expect(await readMetadata(thrower)).toEqual({ format: "unknown" });
    expect(await readMetadata({ size: Number.NaN, slice: thrower.slice })).toEqual({ format: "unknown" });
  });

  it("survives thousands of damaged files, with no read budget passed", { timeout: 30_000 }, async () => {
    // A fixed seed, so a failure here can be replayed.
    let state = 0x2545f491;
    const next = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };
    for (const bytes of Object.values(FIXTURES)) {
      for (let round = 0; round < 500; round++) {
        const damaged = bytes.slice();
        const hits = 1 + (next() % 8);
        for (let i = 0; i < hits; i++) damaged[next() % damaged.length] = next() % 3 === 0 ? 0xff : next() & 0xff;
        const { file, reads } = fake(damaged.length, placed([[0, damaged]]));
        const found = await readMetadata(file);
        expect(typeof found.format).toBe("string");
        expect(reads.length).toBeLessThan(10_000);
      }
    }
  });
});
