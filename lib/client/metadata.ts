// What a file says about itself: when it was made, where, and on what. A phone's video often names
// its own place and minute: the "where and when" search narrows its day with it, and the "does your
// video give away where you are?" page warns about it.
//
// Reads by parts, so a 2 GB file is never loaded: the headers of its boxes or chunks, then only the
// few small values wanted. Never throws: a truncated or hostile file gives what could be read, and
// a value cut short is refused rather than read as another one (half a coordinate is another place).
//
// Not read: GPS in timed tracks (GoPro's GPMF, drones, dashcams), XMP, 3GPP `loci`, and every format
// but MP4, MOV, M4A, WAV and MP3. An empty answer does not mean the file says nothing.

/** Anything with a size that reads by parts: a File, a Blob. */
export type SliceableFile = {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
};

export type CreatedAt = {
  /** UTC seconds, like `start` in lib/core/wherewhen.ts. */
  utc: number;
  /** The clock's offset from UTC, when the file states it. */
  offsetMinutes?: number;
  /**
   * The tag it was read from, so a page can say how sure it is. The surest first, which is also the
   * order they are preferred in:
   * - `com.apple.quicktime.creationdate` or `©day`, with an `offsetMinutes`: a clock and its zone.
   * - `mvhd`: UTC by the format and on phones, but local time on some cameras, and the time of the
   *   export on a file that was edited.
   * - Those two tags with no offset, `bext`, `ICRD`, `TDRC`, `TYER`: a clock with no zone, read as
   *   if it were UTC, so up to 14 hours off.
   */
  source: string;
  /** How much of the date the file gives. `utc` is the start of it: `TYER` alone is a year, and `utc` its January 1st. */
  precision: "year" | "month" | "day" | "hour" | "minute" | "second";
};

export type Place = {
  lat: number;
  lon: number;
  /** Metres. */
  altitude?: number;
  /** The tag it was read from: `©xyz` or `com.apple.quicktime.location.ISO6709`. */
  source: string;
};

export type FileMetadata = {
  createdAt?: CreatedAt;
  location?: Place;
  device?: string;
  /** "mp4", "mov", "m4a", "wav", "mp3", "aac", "ogg", "flac", "webm" (or Matroska), or "unknown". */
  format: string;
};

type Found = {
  format: string;
  dates: CreatedAt[];
  location?: Place;
  make?: string;
  model?: string;
  zone?: number;
};

/** Boxes and chunks looked at in one file, at every level. A real file has a few dozen. */
const MAX_BOXES = 4096;
/** How deep `udta` boxes are followed. A real file has one. */
const MAX_DEPTH = 8;
/** The longest value read. Longer is not a date, a place or a model: a cover image, say. */
const MAX_TEXT = 4096;
const MAX_KEYS = 64 * 1024;
/** All that is ever read from one file. A real file takes a few kB. */
const MAX_BYTES = 4 * 1024 * 1024;

const SECONDS_FROM_1904_TO_1970 = 2_082_844_800;
/** Dates outside these are an unset clock or a bad writer. */
const EARLIEST = Date.UTC(1980, 0, 1) / 1000;
const LATEST = Date.UTC(2100, 0, 1) / 1000;

const CREATION_DATE = "com.apple.quicktime.creationdate";
const DATES = new Set([CREATION_DATE, "©day"]);
const PLACES = new Set(["com.apple.quicktime.location.ISO6709", "©xyz"]);
const MAKES = new Set(["com.apple.quicktime.make", "com.android.manufacturer", "©mak"]);
const MODELS = new Set(["com.apple.quicktime.model", "com.android.model", "©mod"]);
/** Samsung's zone for the `mvhd` time (named in ExifTool's QuickTime tags). */
const ZONES = new Set(["samsung.android.utc_offset", "com.samsung.android.utc_offset"]);
const WANTED = new Set([...DATES, ...PLACES, ...MAKES, ...MODELS, ...ZONES]);

const SOURCE_ORDER = [CREATION_DATE, "©day", "mvhd", "bext", "ICRD", "TDRC", "TYER"];

/** What may open an MP4 or a MOV, whose first box says so at byte 4. */
const FIRST_BOXES = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"]);
const AUDIO_BRANDS = new Set(["M4A ", "M4B ", "M4P ", "F4A ", "F4B "]);
const RIFF_FORMS = new Set(["RIFF", "RF64", "BW64"]);
const OTHER_FORMATS: Record<string, string> = { OggS: "ogg", fLaC: "flac", "\x1aE\xdf\xa3": "webm" };
const ID3_V22_FRAMES: Record<string, string> = { TYE: "TYER", TDA: "TDAT", TIM: "TIME" };
const ID3_DATE_FRAMES = new Set(["TDRC", "TYER", "TDAT", "TIME"]);

const NOTHING = new Uint8Array(0);

type Reader = {
  size: number;
  /** Up to `length` bytes, fewer at the end of the file, none on a failed read or past the budget. */
  read(pos: number, length: number): Promise<Uint8Array>;
  /** False once the file has shown too many boxes: every walk stops there. */
  spend(): boolean;
};

function readerOf(file: SliceableFile): Reader {
  const size = Number.isFinite(file.size) && file.size > 0 ? file.size : 0;
  let bytes = 0;
  let boxes = 0;
  return {
    size,
    async read(pos, length) {
      const end = Math.min(pos + length, size);
      if (pos >= end || bytes + (end - pos) > MAX_BYTES) return NOTHING;
      bytes += end - pos;
      try {
        return new Uint8Array(await file.slice(pos, end).arrayBuffer());
      } catch {
        return NOTHING;
      }
    },
    spend: () => ++boxes <= MAX_BOXES,
  };
}

const viewOf = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const latin1 = (b: Uint8Array) => String.fromCharCode(...b);
const fourcc = (b: Uint8Array, at: number) => latin1(b.subarray(at, at + 4));
const decode = (b: Uint8Array, encoding = "utf-8") => new TextDecoder(encoding).decode(b);
const clean = (text: string) => text.split("\0")[0].trim();

/** A part of the file. `cut`: it claims to run past what holds it, so its end is missing. */
type Region = { type: string; start: number; end: number; cut: boolean };
type Box = Region & { id: number };

/** The payload of a small region, or nothing if it is cut short or too long to be a value. */
async function whole(r: Reader, region: Region): Promise<Uint8Array | undefined> {
  const length = region.end - region.start;
  if (region.cut || length > MAX_TEXT) return undefined;
  const b = await r.read(region.start, length);
  return b.length === length ? b : undefined;
}

// Dates and places.

function offsetOf(text: string): number | undefined {
  if (/^(z|utc|gmt)$/i.test(text)) return 0;
  const m = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(text);
  if (!m) return undefined;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  if (Number(m[3] ?? 0) >= 60 || minutes > 14 * 60) return undefined;
  return minutes === 0 || m[1] === "+" ? minutes : -minutes;
}

const DATE = /^(\d{4})(?:[-:/.]?(\d{2})(?:[-:/.]?(\d{2})(?:[t ]?(\d{2})(?::?(\d{2})(?::?(\d{2})(?:\.\d+)?)?)?\s*(z|utc|gmt|[+-]\d{2}(?::?\d{2})?)?)?)?)?$/i;
const PRECISIONS = ["year", "month", "day", "hour", "minute", "second"] as const;

/** From a year alone to a time and its zone. A date that does not exist or could not be true is refused. */
function parseDate(text: string, source: string): CreatedAt | undefined {
  const m = DATE.exec(text);
  if (!m) return undefined;
  const parts = m.slice(1, 7).filter((part) => part !== undefined).map(Number);
  const [year, month = 1, day = 1, hour = 0, minute = 0, second = 0] = parts;
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const exists =
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day &&
    at.getUTCHours() === hour &&
    at.getUTCMinutes() === minute &&
    at.getUTCSeconds() === second;
  if (!exists) return undefined;
  const offsetMinutes = m[7] === undefined ? undefined : offsetOf(m[7]);
  if (m[7] !== undefined && offsetMinutes === undefined) return undefined;
  const utc = at.getTime() / 1000 - (offsetMinutes ?? 0) * 60;
  if (utc < EARLIEST || utc >= LATEST) return undefined;
  const precision = PRECISIONS[parts.length - 1];
  return offsetMinutes === undefined ? { utc, source, precision } : { utc, offsetMinutes, source, precision };
}

/** One angle of ISO 6709: degrees, degrees and minutes, or degrees, minutes and seconds, by its digits. */
function angleOf(text: string, degreeDigits: number): number | undefined {
  const digits = text.split(".")[0].length;
  const value = Number(text);
  if (digits <= degreeDigits) return value;
  if (digits === degreeDigits + 2) {
    const degrees = Math.floor(value / 100);
    const minutes = value - degrees * 100;
    return minutes < 60 ? degrees + minutes / 60 : undefined;
  }
  if (digits === degreeDigits + 4) {
    const degrees = Math.floor(value / 10000);
    const minutes = Math.floor(value / 100) - degrees * 100;
    const seconds = value - Math.floor(value / 100) * 100;
    return minutes < 60 && seconds < 60 ? degrees + minutes / 60 + seconds / 3600 : undefined;
  }
  return undefined;
}

const ISO6709 = /^([+-])(\d+(?:\.\d*)?)([+-])(\d+(?:\.\d*)?)(?:([+-])(\d+(?:\.\d*)?))?(?:CRS[^/]*)?\/?$/;

/** "+48.8566+002.3522+035.000/". Exactly 0, 0 is a device with no fix, not a recording at sea. */
function parsePlace(text: string, source: string): Place | undefined {
  const m = ISO6709.exec(text);
  if (!m) return undefined;
  const lat = angleOf(m[2], 2);
  const lon = angleOf(m[4], 3);
  if (lat === undefined || lon === undefined || lat > 90 || lon > 180 || (lat === 0 && lon === 0)) return undefined;
  const place: Place = { lat: m[1] === "-" && lat ? -lat : lat, lon: m[3] === "-" && lon ? -lon : lon, source };
  if (m[6] !== undefined) place.altitude = Number(m[6]) * (m[5] === "-" ? -1 : 1);
  return place;
}

const deviceText = (text: string) => (/^[^\p{C}]{1,128}$/u.test(text) ? text : undefined);

function addDate(found: Found, date: CreatedAt | undefined) {
  if (date) found.dates.push(date);
}

function take(name: string, text: string, found: Found) {
  const value = clean(text);
  if (DATES.has(name)) addDate(found, parseDate(value, name));
  else if (PLACES.has(name)) found.location ??= parsePlace(value, name);
  else if (MAKES.has(name)) found.make ??= deviceText(value);
  else if (MODELS.has(name)) found.model ??= deviceText(value);
  else if (ZONES.has(name)) found.zone ??= offsetOf(value);
}

// MP4, MOV, M4A: ISO 14496-12 and Apple's QuickTime File Format.

/** The boxes between two positions, headers only. Past the box budget, or at a broken size, it stops. */
async function* boxes(r: Reader, from: number, to: number, topLevel = false): AsyncGenerator<Box> {
  let pos = from;
  while (pos + 8 <= to && r.spend()) {
    const head = await r.read(pos, 16);
    if (head.length < 8) return;
    const view = viewOf(head);
    let size = view.getUint32(0);
    let headerLength = 8;
    if (size === 1) {
      if (head.length < 16) return;
      size = Number(view.getBigUint64(8));
      headerLength = 16;
    } else if (size === 0) {
      // Runs to the end of the file, at the top level only. In a `udta` it closes the list.
      if (!topLevel) return;
      size = to - pos;
    }
    if (size < headerLength) return;
    yield { type: fourcc(head, 4), id: view.getUint32(4), start: pos + headerLength, end: Math.min(pos + size, to), cut: pos + size > to };
    pos += size;
  }
}

async function readMvhd(r: Reader, box: Box, found: Found) {
  const b = await r.read(box.start, 12);
  if (b.length < 4 || b[0] > 1 || b.length < (b[0] === 1 ? 12 : 8)) return;
  const view = viewOf(b);
  const utc = (b[0] === 1 ? Number(view.getBigUint64(4)) : view.getUint32(4)) - SECONDS_FROM_1904_TO_1970;
  // 0, unset, lands in 1904 and is refused like any other date before EARLIEST.
  if (utc >= EARLIEST && utc < LATEST) found.dates.push({ utc, source: "mvhd", precision: "second" });
}

/** A `udta` text: a 16-bit length and a 16-bit language, then the text. Some writers leave out the first two. */
function udtaText(b: Uint8Array): string {
  const length = b.length >= 4 ? (b[0] << 8) | b[1] : 0;
  return decode(length > 0 && 4 + length <= b.length ? b.subarray(4, 4 + length) : b);
}

function parseKeys(b: Uint8Array): string[] {
  const keys: string[] = [];
  if (b.length < 8) return keys;
  const view = viewOf(b);
  const count = view.getUint32(4);
  let pos = 8;
  while (keys.length < count && pos + 8 <= b.length) {
    const size = view.getUint32(pos);
    if (size < 8 || pos + size > b.length) break;
    keys.push(decode(b.subarray(pos + 8, pos + size)));
    pos += size;
  }
  return keys;
}

/** The payload of an `ilst` value's `data` box: a type, a locale, then the value. Only text is wanted. */
function dataText(b: Uint8Array): string | undefined {
  if (b.length < 8) return undefined;
  const type = viewOf(b).getUint32(0) & 0xffffff;
  if (type === 0 || type === 1) return decode(b.subarray(8));
  return type === 2 ? decode(b.subarray(8), "utf-16be") : undefined;
}

/**
 * `meta` holds `keys`, the names, and `ilst`, the values: each value's box type is the number of its
 * key, or, with iTunes-style tags, its own name. A cover image in there is never read.
 */
async function readMeta(r: Reader, box: Box, found: Found) {
  // ISO's `meta` opens with four bytes of version and flags, zero; QuickTime's goes straight to a box.
  const head = await r.read(box.start, 4);
  if (head.length < 4) return;
  const from = box.start + (viewOf(head).getUint32(0) === 0 ? 4 : 0);
  let keys: string[] = [];
  let list: Box | undefined;
  for await (const child of boxes(r, from, box.end)) {
    if (child.type === "keys") keys = parseKeys(await r.read(child.start, Math.min(child.end - child.start, MAX_KEYS)));
    else if (child.type === "ilst") list = child;
  }
  if (!list) return;
  for await (const item of boxes(r, list.start, list.end)) {
    const name = keys[item.id - 1] ?? item.type;
    if (!WANTED.has(name)) continue;
    for await (const value of boxes(r, item.start, item.end)) {
      if (value.type !== "data") continue;
      const b = await whole(r, value);
      const text = b && dataText(b);
      if (text !== undefined) take(name, text, found);
      break;
    }
  }
}

/** `moov` or a `udta` in it. Tracks are not opened: on a long video they hold most of `moov`. */
async function readContainer(r: Reader, box: Box, depth: number, found: Found) {
  if (depth > MAX_DEPTH) return;
  for await (const child of boxes(r, box.start, box.end)) {
    if (child.type === "mvhd") await readMvhd(r, child, found);
    else if (child.type === "udta") await readContainer(r, child, depth + 1, found);
    else if (child.type === "meta") await readMeta(r, child, found);
    else if (WANTED.has(child.type)) {
      const b = await whole(r, child);
      if (b) take(child.type, udtaText(b), found);
    }
  }
}

async function readMp4(r: Reader, found: Found) {
  // An old QuickTime file opens without `ftyp`.
  found.format = "mov";
  for await (const box of boxes(r, 0, r.size, true)) {
    if (box.type === "ftyp") {
      const brand = fourcc(await r.read(box.start, 4), 0);
      found.format = brand === "qt  " ? "mov" : AUDIO_BRANDS.has(brand) ? "m4a" : "mp4";
    } else if (box.type === "moov") {
      await readContainer(r, box, 1, found);
      return;
    }
  }
}

// WAV: RIFF, and EBU Tech 3285's Broadcast Wave.

async function* chunks(r: Reader, from: number, to: number): AsyncGenerator<Region> {
  let pos = from;
  while (pos + 8 <= to && r.spend()) {
    const head = await r.read(pos, 8);
    if (head.length < 8) return;
    const size = viewOf(head).getUint32(4, true);
    const start = pos + 8;
    yield { type: fourcc(head, 0), start, end: Math.min(start + size, to), cut: start + size > to };
    pos = start + size + (size & 1);
  }
}

/** Where `bext` ends its text fields: description 256, originator 32, reference 32, date 10, time 8. */
const BEXT_LENGTH = 338;

async function readBext(r: Reader, chunk: Region, found: Found) {
  const b = await r.read(chunk.start, Math.min(chunk.end - chunk.start, BEXT_LENGTH));
  if (b.length < BEXT_LENGTH) return;
  found.model ??= deviceText(clean(latin1(b.subarray(256, 288))));
  // The EBU allows any of these separators. A date alone is still a day to search.
  const date = clean(latin1(b.subarray(320, 330))).replace(/[_: .]/g, "-");
  const time = clean(latin1(b.subarray(330, 338))).replace(/[-_ .]/g, ":");
  addDate(found, parseDate(time ? `${date}T${time}` : date, "bext"));
}

async function readWav(r: Reader, found: Found) {
  for await (const chunk of chunks(r, 12, r.size)) {
    if (chunk.type === "bext") await readBext(r, chunk, found);
    else if (chunk.type === "LIST" && fourcc(await r.read(chunk.start, 4), 0) === "INFO") {
      for await (const item of chunks(r, chunk.start + 4, chunk.end)) {
        const b = item.type === "ICRD" ? await whole(r, item) : undefined;
        if (b) addDate(found, parseDate(clean(decode(b)), "ICRD"));
      }
    }
  }
}

// MP3: ID3v2.2, 2.3 and 2.4. A compressed or encrypted frame reads as nonsense, which the dates refuse.

const synchsafe = (b: Uint8Array, at: number) => ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f);

function id3Text(b: Uint8Array): string {
  const body = b.subarray(1);
  if (b[0] === 1) return decode(body, body[0] === 0xfe ? "utf-16be" : "utf-16le");
  if (b[0] === 2) return decode(body, "utf-16be");
  return b[0] === 3 ? decode(body) : latin1(body);
}

async function readId3(r: Reader, found: Found) {
  const head = await r.read(0, 10);
  if (head.length < 10) return;
  const version = head[3];
  if (version < 2 || version > 4) return;
  const short = version === 2;
  const headerLength = short ? 6 : 10;
  const unsynchronised = (head[5] & 0x80) !== 0;
  const end = Math.min(10 + synchsafe(head, 6), r.size);
  let pos = 10;
  if (!short && head[5] & 0x40) {
    const extended = await r.read(pos, 4);
    if (extended.length < 4) return;
    pos += version === 4 ? synchsafe(extended, 0) : viewOf(extended).getUint32(0) + 4;
  }
  const frames = new Map<string, string>();
  while (pos + headerLength <= end && r.spend()) {
    const h = await r.read(pos, headerLength);
    if (h.length < headerLength) break;
    const id = latin1(h.subarray(0, short ? 3 : 4));
    // Padding, or not a frame: nothing after it can be trusted.
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const size = short ? (h[3] << 16) | (h[4] << 8) | h[5] : version === 4 ? synchsafe(h, 4) : viewOf(h).getUint32(4);
    const name = short ? (ID3_V22_FRAMES[id] ?? id) : id;
    if (ID3_DATE_FRAMES.has(name) && size > 0 && size <= MAX_TEXT && pos + headerLength + size <= end) {
      const b = await r.read(pos + headerLength, size);
      // Unsynchronisation puts a 0 after every 0xff, as in a UTF-16 byte order mark.
      if (b.length === size) frames.set(name, clean(id3Text(unsynchronised ? b.filter((x, i) => !(x === 0 && b[i - 1] === 0xff)) : b)));
    }
    pos += headerLength + size;
  }
  addDate(found, parseDate(frames.get("TDRC") ?? "", "TDRC"));
  const year = frames.get("TYER");
  if (!year) return;
  // ID3v2.3 splits a date in three: TYER "2024", TDAT "0305" for 3 May, TIME "1012".
  const dayMonth = frames.get("TDAT") ?? "";
  const time = frames.get("TIME") ?? "";
  const day = /^\d{4}$/.test(dayMonth) ? `-${dayMonth.slice(2)}-${dayMonth.slice(0, 2)}` : "";
  const clock = day && /^\d{4}$/.test(time) ? `T${time.slice(0, 2)}:${time.slice(2)}` : "";
  addDate(found, parseDate(`${year}${day}${clock}`, "TYER"));
}

// The answer.

function otherFormat(head: Uint8Array): string {
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return head[1] & 0x06 ? "mp3" : "aac";
  return OTHER_FORMATS[fourcc(head, 0)] ?? "unknown";
}

/** A date that states its zone first, then `mvhd`, then a clock with no zone. */
function dateRank(date: CreatedAt): number {
  const zoned = date.offsetMinutes !== undefined || date.source === "mvhd";
  return SOURCE_ORDER.indexOf(date.source) + (zoned ? 0 : SOURCE_ORDER.length);
}

function settled(found: Found): FileMetadata {
  const out: FileMetadata = { format: found.format };
  const [best] = found.dates.sort((a, b) => dateRank(a) - dateRank(b));
  if (best) out.createdAt = best.source === "mvhd" && found.zone !== undefined ? { ...best, offsetMinutes: found.zone } : best;
  if (found.location) out.location = found.location;
  const { make, model } = found;
  const device = make && model && !model.toLowerCase().startsWith(make.toLowerCase()) ? `${make} ${model}` : (model ?? make);
  if (device) out.device = device;
  return out;
}

/** What the file's own metadata says. Never throws, and never reads more than a few kB of a real file. */
export async function readMetadata(file: SliceableFile): Promise<FileMetadata> {
  const found: Found = { format: "unknown", dates: [] };
  try {
    const r = readerOf(file);
    const head = await r.read(0, 12);
    if (RIFF_FORMS.has(fourcc(head, 0)) && fourcc(head, 8) === "WAVE") {
      found.format = "wav";
      await readWav(r, found);
    } else if (latin1(head.subarray(0, 3)) === "ID3") {
      found.format = "mp3";
      await readId3(r, found);
    } else if (FIRST_BOXES.has(fourcc(head, 4))) {
      await readMp4(r, found);
    } else {
      found.format = otherFormat(head);
    }
  } catch {
    // Whatever the walks did not expect: what they found so far stands.
  }
  return settled(found);
}
