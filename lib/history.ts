// The flight history as Unheard stores it: one UTC day of the aircraft that could be heard (low
// and airborne), cut into tiles of 1° a browser fetches one by one over plain HTTP, from any base
// URL (a bucket, a local folder, a mirror). scripts/history-index.ts writes them from adsb.lol's
// daily globe_history; the tiles are a derived database under ODbL 1.0, "© adsb.lol
// contributors". The format (v1) is documented in docs/history-format.md. No DOM, no Node here:
// bytes in, flights out, and a fetcher supplied by the caller.

import type { Fix } from "./core/track";
import { inParallel, MAX_FETCHES } from "./core/parallel";

/** What makes the sound: the propeller and rotor tones are what the trace follower finds. */
export const KIND = { unknown: 0, piston: 1, turboprop: 2, rotor: 3, jet: 4, other: 5 } as const;
export type Kind = (typeof KIND)[keyof typeof KIND];

/** Kind from an ICAO type description (Doc 8643, as in tar1090-db): L1P, H2T, L2J... */
export function kindOfDescription(desc: string | undefined, category?: string): Kind {
  if (desc && desc.length === 3) {
    if ("HGT".includes(desc[0])) return KIND.rotor;
    if (desc[2] === "P") return KIND.piston;
    if (desc[2] === "T") return KIND.turboprop;
    if (desc[2] === "J") return KIND.jet;
    return KIND.other;
  }
  // No type: the emitter category says rotorcraft (A7), glider (B1), light (A1)...
  if (category === "A7") return KIND.rotor;
  if (category === "B1" || category === "B2" || category === "B4") return KIND.other;
  if (category === "A3" || category === "A4" || category === "A5") return KIND.jet;
  return KIND.unknown;
}

/** Heard as a falling tone the trace follower finds: propellers and rotors. */
export const isProp = (kind: Kind) => kind === KIND.piston || kind === KIND.turboprop || kind === KIND.rotor;

/** Format version: in every tile's header and in the manifest. */
export const FORMAT = 1;
const MAGIC = 0x31484855; // "UHH1"
const HEADER = 40;
const E6 = 1e6;
const ENTRY = 32;
const POINT = 15;
const DECI = 10;
const FT = 0.3048;
const KT = 1852 / 3600;
const FPM = FT / 60;

/** One aircraft's points in a tile (or merged across tiles), as columns, in time order. */
export type Flight = {
  hex: string;
  kind: Kind;
  type: string;
  registration: string;
  /** UTC seconds. */
  t: Float64Array;
  lat: Float64Array;
  lon: Float64Array;
  /** Feet, geometric when broadcast, else pressure altitude (flagged). */
  altFt: Float64Array;
  /** Knots, degrees true, feet per minute. */
  gs: Float32Array;
  track: Float32Array;
  vrate: Float32Array;
  flags: Uint8Array;
};

/** A decoded tile: its south-west corner and side in degrees, and its runs. */
export type Tile = { day: number; lat0: number; lon0: number; size: number; flights: Flight[] };

/** The aircraft a run of points belongs to. */
export type Aircraft = { hex: string; kind: Kind; type: string; registration: string };

/** A 1° tile's name: its south-west corner, e.g. "37_-122". */
export const tileOf = (lat: number, lon: number) => `${Math.floor(lat)}_${Math.floor(lon)}`;

/** One day's index, `<day>/manifest.json`. */
export type Manifest = {
  format: string;
  /** The indexer's own version: the same source and build give byte-identical tiles. */
  build: number;
  day: string;
  source: { repository: string; release: string; assets: { name: string; size: number }[]; licence: string; attribution: string };
  types: { source: string; commit: string };
  filter: string;
  /** Per tile: corner and side (degrees), aircraft runs, points, file bytes, SHA-256 of the file
   * and of its decompressed content. */
  tiles: Record<string, { lat0: number; lon0: number; size: number; runs: number; points: number; bytes: number; sha256: string; content: string }>;
  totals: { tiles: number; aircraft: number; points: number; bytes: number };
};

/** The tiles of a manifest that a square `side` metres wide around a point touches, with `margin` metres more. */
export function tilesAround(manifest: Manifest, lat: number, lon: number, side: number, margin = 0): string[] {
  const half = side / 2 + margin;
  const dLat = half / 111_195;
  const dLon = half / (111_195 * Math.cos((lat * Math.PI) / 180));
  return Object.entries(manifest.tiles)
    .filter(([, t]) => t.lat0 < lat + dLat && t.lat0 + t.size > lat - dLat && t.lon0 < lon + dLon && t.lon0 + t.size > lon - dLon)
    .map(([name]) => name)
    .sort();
}

/**
 * Reads a file of the history by its path under the base ("2026-05-16/manifest.json",
 * "2026-05-16/37_-122.bin.gz"), or null when it is not there. The page passes one over HTTP
 * (httpFetcher), the scripts and evals one over a local folder.
 */
export type Fetcher = (path: string) => Promise<Uint8Array | null>;

/** Files under a base URL: our bucket, a folder served in dev, anyone's mirror. */
export const httpFetcher =
  (base: string): Fetcher =>
  async (path) => {
    const res = await fetch(new URL(path, base.endsWith("/") ? base : `${base}/`));
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  };

/** Gzip undone, unless the server already did it (Content-Encoding). */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readManifest(fetcher: Fetcher, day: string): Promise<Manifest | null> {
  const bytes = await fetcher(`${day}/manifest.json`);
  return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as Manifest) : null;
}

/**
 * The days an archive holds, from the days.json at its root, oldest first: a list of days, or of
 * `{ day }`, bare or under `days`. Null when it has none, or none a reader can trust.
 */
export async function readDays(fetcher: Fetcher): Promise<string[] | null> {
  try {
    const bytes = await fetcher("days.json");
    if (!bytes) return null;
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { days?: unknown } | null)?.days;
    if (!Array.isArray(list)) return null;
    const days = list.map((d: unknown) => (typeof d === "string" ? d : (d as { day?: unknown } | null)?.day)).filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d));
    return [...new Set(days)].sort();
  } catch {
    return null;
  }
}

/**
 * The flights of some days around a square, merged per aircraft across tiles; and the bytes
 * fetched. Only the tiles the square touches, several at a time: the flights come out the same
 * whatever order they arrive in.
 */
export async function loadFlights(fetcher: Fetcher, days: string[], area: { lat: number; lon: number; side: number }, margin = 15_000, onProgress?: (done: number, total: number) => void): Promise<{ flights: Flight[]; bytes: number; tiles: number; missing: string[] }> {
  const manifests = await inParallel(days, MAX_FETCHES, (day) => readManifest(fetcher, day));
  const missing = days.filter((_, i) => !manifests[i]);
  const paths = days.flatMap((day, i) => {
    const manifest = manifests[i];
    return manifest ? tilesAround(manifest, area.lat, area.lon, area.side, margin).map((name) => `${day}/${name}.bin.gz`) : [];
  });
  let bytes = 0;
  let done = 0;
  onProgress?.(0, paths.length);
  const read = await inParallel(paths, MAX_FETCHES, async (path) => {
    const gz = await fetcher(path);
    const tile = gz ? decodeTile(await gunzip(gz)) : null;
    if (gz) bytes += gz.length;
    onProgress?.(++done, paths.length);
    return tile;
  });
  const tiles = read.filter((t): t is Tile => t !== null);
  return { flights: mergeFlights(tiles), bytes, tiles: tiles.length, missing };
}

const ascii = (s: string, n: number) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < Math.min(n, s.length); i++) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
};
const unascii = (b: Uint8Array) => {
  let s = "";
  for (const c of b) if (c) s += String.fromCharCode(c);
  return s;
};
const hexCode = (hex: string) => (hex.startsWith("~") ? 0x1000000 : 0) | (parseInt(hex.replace("~", ""), 16) & 0xffffff);
const hexOf = (code: number) => (code & 0x1000000 ? "~" : "") + (code & 0xffffff).toString(16).padStart(6, "0");
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(x)));

/** Points per indexed point as the indexer hands them over: UTC seconds, degrees, feet, knots,
 * degrees, ft/min, flags. */
export const STRIDE = 8;

/**
 * One tile being written: points arrive run by run, each run in time order (the indexer feeds
 * one aircraft at a time), into growing typed columns (17 bytes a point, off the JS heap).
 */
export class TileWriter {
  readonly lat0: number;
  readonly lon0: number;
  readonly size: number;
  readonly day: number;
  private entries: { aircraft: Aircraft; first: number; count: number; start: number }[] = [];
  /** The aircraft of the run being written; null: the next point starts a run. */
  last: Aircraft | null = null;
  private lastT = 0;
  private n = 0;
  private cap = 0;
  private cols = { t: new Int32Array(0), lat: new Uint16Array(0), lon: new Uint16Array(0), alt: new Int16Array(0), gs: new Uint16Array(0), track: new Uint16Array(0), vrate: new Int16Array(0), flags: new Uint8Array(0) };

  constructor(day: number, lat0: number, lon0: number, size = 1) {
    this.day = day;
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.size = size;
  }

  get points() {
    return this.n;
  }

  /** Point i of `pts` (STRIDE numbers each) for `aircraft`; a new run starts when the aircraft changes. */
  add(aircraft: Aircraft, pts: ArrayLike<number>, i: number): void {
    const o = i * STRIDE;
    const tt = Math.round((pts[o] - this.day) * DECI);
    if (aircraft !== this.last || tt - this.lastT > 65535) {
      this.entries.push({ aircraft, first: this.n, count: 0, start: tt });
      this.last = aircraft;
    }
    if (this.n === this.cap) this.grow();
    const c = this.cols;
    const k = this.n++;
    c.t[k] = tt;
    c.lat[k] = clamp(((pts[o + 1] - this.lat0) / this.size) * 65535, 0, 65535);
    c.lon[k] = clamp(((pts[o + 2] - this.lon0) / this.size) * 65535, 0, 65535);
    c.alt[k] = clamp(pts[o + 3], -32768, 32767);
    c.gs[k] = clamp(pts[o + 4] * 10, 0, 65535);
    c.track[k] = clamp((((pts[o + 5] % 360) + 360) % 360) * 100, 0, 35999);
    c.vrate[k] = clamp(pts[o + 6], -32768, 32767);
    c.flags[k] = pts[o + 7];
    this.entries[this.entries.length - 1].count++;
    this.lastT = tt;
  }

  private grow() {
    this.cap = Math.max(256, this.cap * 2);
    const c = this.cols;
    const re = <T extends Int32Array | Uint16Array | Int16Array | Uint8Array>(a: T, make: (n: number) => T): T => {
      const b = make(this.cap);
      b.set(a);
      return b;
    };
    this.cols = {
      t: re(c.t, (n) => new Int32Array(n)),
      lat: re(c.lat, (n) => new Uint16Array(n)),
      lon: re(c.lon, (n) => new Uint16Array(n)),
      alt: re(c.alt, (n) => new Int16Array(n)),
      gs: re(c.gs, (n) => new Uint16Array(n)),
      track: re(c.track, (n) => new Uint16Array(n)),
      vrate: re(c.vrate, (n) => new Int16Array(n)),
      flags: re(c.flags, (n) => new Uint8Array(n)),
    };
  }

  /** Aircraft with at least one run here. */
  get aircraft() {
    return new Set(this.entries.map((e) => e.aircraft.hex)).size;
  }

  get runs() {
    return this.entries.length;
  }

  /** The same points in four tiles of half the side (for a tile too heavy to fetch at once). */
  quarters(): TileWriter[] {
    const half = this.size / 2;
    const out = [0, 1, 2, 3].map((q) => new TileWriter(this.day, this.lat0 + (q >> 1) * half, this.lon0 + (q & 1) * half, half));
    const c = this.cols;
    const pt = new Float64Array(STRIDE);
    for (const e of this.entries) {
      for (let k = e.first; k < e.first + e.count; k++) {
        pt[0] = this.day + c.t[k] / DECI;
        pt[1] = this.lat0 + (c.lat[k] / 65535) * this.size;
        pt[2] = this.lon0 + (c.lon[k] / 65535) * this.size;
        [pt[3], pt[4], pt[5], pt[6], pt[7]] = [c.alt[k], c.gs[k] / 10, c.track[k] / 100, c.vrate[k], c.flags[k]];
        const q = (pt[1] >= this.lat0 + half ? 2 : 0) + (pt[2] >= this.lon0 + half ? 1 : 0);
        out[q].add(e.aircraft, pt, 0);
      }
      // A run ends with its entry, in every quarter.
      for (const w of out) w.last = null;
    }
    return out.filter((w) => w.points > 0);
  }

  /**
   * The tile's bytes (before gzip), with only the runs `keep` accepts. Runs are written by
   * address, then start: the same points give the same bytes, in whatever order they arrived.
   */
  bytes(keep: (a: Aircraft) => boolean = () => true): Uint8Array {
    const entries = this.entries.filter((e) => keep(e.aircraft)).sort((a, b) => hexCode(a.aircraft.hex) - hexCode(b.aircraft.hex) || a.start - b.start || a.first - b.first);
    const P = entries.reduce((s, e) => s + e.count, 0);
    const buf = new ArrayBuffer(HEADER + entries.length * ENTRY + P * POINT);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, FORMAT, true);
    view.setUint32(8, this.day, true);
    view.setInt32(12, Math.round(this.lat0 * E6), true);
    view.setInt32(16, Math.round(this.lon0 * E6), true);
    view.setUint32(20, Math.round(this.size * E6), true);
    view.setUint32(24, entries.length, true);
    view.setUint32(28, P, true);
    const base = HEADER + entries.length * ENTRY;
    const off = colOffset(P);
    const c = this.cols;
    let p = 0;
    entries.forEach((e, i) => {
      const o = HEADER + i * ENTRY;
      view.setUint32(o, hexCode(e.aircraft.hex), true);
      view.setUint32(o + 4, p, true);
      view.setUint32(o + 8, e.count, true);
      view.setUint32(o + 12, Math.max(0, e.start), true);
      bytes[o + 16] = e.aircraft.kind;
      bytes.set(ascii(e.aircraft.type, 4), o + 20);
      bytes.set(ascii(e.aircraft.registration, 8), o + 24);
      // Each 16-bit column holds the change from the run's previous point (mod 65536), its low
      // bytes then its high bytes: near-constant values become runs of small bytes.
      const put = (col: number, value: number) => {
        bytes[base + off[col] + p] = value & 0xff;
        bytes[base + off[col] + P + p] = (value >> 8) & 0xff;
      };
      let prev = Math.max(0, e.start);
      const last = [0, 0, 0, 0, 0, 0, 0];
      for (let k = e.first; k < e.first + e.count; k++, p++) {
        const tt = Math.max(prev, c.t[k]);
        put(0, tt - prev);
        prev = tt;
        const now = [0, c.lat[k], c.lon[k], c.alt[k] & 0xffff, c.gs[k], c.track[k], c.vrate[k] & 0xffff];
        for (let col = 1; col < 7; col++) {
          put(col, (now[col] - last[col]) & 0xffff);
          last[col] = now[col];
        }
        bytes[base + off[7] + p] = c.flags[k];
      }
    });
    return bytes;
  }
}

/** Byte offset of each column after the entry table, for P points. */
const colOffset = (P: number) => [0, 2, 4, 6, 8, 10, 12, 14].map((k) => k * P);

const signed = (x: number) => (x >= 0x8000 ? x - 0x10000 : x);

/** A tile's flights, one per run (an aircraft that left and came back has two). */
export function decodeTile(bytes: Uint8Array): Tile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("not an Unheard history tile");
  if (view.getUint32(4, true) !== FORMAT) throw new Error(`history tile format v${view.getUint32(4, true)}, this reader knows v${FORMAT}`);
  const day = view.getUint32(8, true);
  const lat0 = view.getInt32(12, true) / E6;
  const lon0 = view.getInt32(16, true) / E6;
  const size = view.getUint32(20, true) / E6;
  const E = view.getUint32(24, true);
  const P = view.getUint32(28, true);
  const base = HEADER + E * ENTRY;
  const off = colOffset(P);
  const flights: Flight[] = [];
  for (let i = 0; i < E; i++) {
    const o = HEADER + i * ENTRY;
    const first = view.getUint32(o + 4, true);
    const n = view.getUint32(o + 8, true);
    let tt = view.getUint32(o + 12, true);
    const get = (col: number, p: number) => bytes[base + off[col] + p] | (bytes[base + off[col] + P + p] << 8);
    const last = [0, 0, 0, 0, 0, 0, 0];
    const f: Flight = {
      hex: hexOf(view.getUint32(o, true)),
      kind: bytes[o + 16] as Kind,
      type: unascii(bytes.subarray(o + 20, o + 24)),
      registration: unascii(bytes.subarray(o + 24, o + 32)),
      t: new Float64Array(n),
      lat: new Float64Array(n),
      lon: new Float64Array(n),
      altFt: new Float64Array(n),
      gs: new Float32Array(n),
      track: new Float32Array(n),
      vrate: new Float32Array(n),
      flags: new Uint8Array(n),
    };
    for (let j = 0; j < n; j++) {
      const p = first + j;
      tt += get(0, p);
      for (let col = 1; col < 7; col++) last[col] = (last[col] + get(col, p)) & 0xffff;
      f.t[j] = day + tt / DECI;
      f.lat[j] = lat0 + (last[1] / 65535) * size;
      f.lon[j] = lon0 + (last[2] / 65535) * size;
      f.altFt[j] = signed(last[3]);
      f.gs[j] = last[4] / 10;
      f.track[j] = last[5] / 100;
      f.vrate[j] = signed(last[6]);
      f.flags[j] = bytes[base + off[7] + p];
    }
    flights.push(f);
  }
  return { day, lat0, lon0, size, flights };
}

/** One flight per aircraft from the runs of several tiles (and days), points in time order. */
export function mergeFlights(tiles: Tile[]): Flight[] {
  const by = new Map<string, Flight[]>();
  for (const tile of tiles) for (const f of tile.flights) by.set(f.hex, [...(by.get(f.hex) ?? []), f]);
  const out: Flight[] = [];
  for (const parts of by.values()) {
    if (parts.length === 1) {
      out.push(parts[0]);
      continue;
    }
    const idx: [number, number][] = [];
    parts.forEach((f, a) => f.t.forEach((_, j) => idx.push([a, j])));
    idx.sort((x, y) => parts[x[0]].t[x[1]] - parts[y[0]].t[y[1]]);
    const n = idx.length;
    const m: Flight = { ...parts[0], t: new Float64Array(n), lat: new Float64Array(n), lon: new Float64Array(n), altFt: new Float64Array(n), gs: new Float32Array(n), track: new Float32Array(n), vrate: new Float32Array(n), flags: new Uint8Array(n) };
    idx.forEach(([a, j], i) => {
      const f = parts[a];
      m.t[i] = f.t[j];
      m.lat[i] = f.lat[j];
      m.lon[i] = f.lon[j];
      m.altFt[i] = f.altFt[j];
      m.gs[i] = f.gs[j];
      m.track[i] = f.track[j];
      m.vrate[i] = f.vrate[j];
      m.flags[i] = f.flags[j];
    });
    out.push(m);
  }
  return out;
}

/** The flight's points between two UTC times as position fixes (what lib/core/track builds on). */
export function fixesOf(f: Flight, from = -Infinity, to = Infinity): Fix[] {
  const out: Fix[] = [];
  for (let j = 0; j < f.t.length; j++) {
    if (f.t[j] < from || f.t[j] > to) continue;
    const rad = (f.track[j] * Math.PI) / 180;
    const gs = f.gs[j] * KT;
    out.push({ t: f.t[j], lat: f.lat[j], lon: f.lon[j], altitude: f.altFt[j] * FT, velocity: [gs * Math.sin(rad), gs * Math.cos(rad), f.vrate[j] * FPM] });
  }
  return out;
}
