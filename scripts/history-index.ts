// Builds the flight history of lib/history.ts (format v1, docs/history-format.md) from adsb.lol's
// daily globe_history (https://github.com/adsblol/globe_history_2026, ODbL 1.0, "© adsb.lol
// contributors"): for one UTC day, only what can be heard, airborne points at or below 10,000 ft
// pressure altitude, every aircraft with its kind (propeller, rotor, jet) from tar1090-db's ICAO
// type table at a pinned commit. The day's tar (about 3 GB, split in .tar.aa and .tar.ab) is
// streamed and parsed on the fly, never stored; each trace_full_<hex>.json (gzip) goes to a
// worker that unpacks and filters it. The same release gives byte-identical tiles.
//
//   pnpm history:build 2026-05-16 [2026-05-17 | 2026-05-09..2026-05-17] [--out dir] [--workers 6]
//   node scripts/history-index.ts 2026-05-16 --peek     (print the first traces, write nothing)
//
// Output: <out>/<day>/<tile>.bin.gz, manifest.json (what a reader needs) and build.json (this
// run's times and memory); <out> defaults to evals/.cache/history/ (never committed). A day
// already built (its manifest there) is skipped unless --force.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { crc32, deflateRawSync, gunzipSync } from "node:zlib";
import { FORMAT, isProp, kindOfDescription, KIND, STRIDE, TileWriter, type Aircraft, type Kind, type Manifest } from "../lib/history.ts";

/** This indexer's version: bump it when the same release would give different tiles. */
const BUILD = 1;
/** tar1090-db's ICAO type table, pinned so that a rebuild classifies aircraft the same way. */
const TYPES_COMMIT = "2ab834a65f2fbde9457823e88682cd46954b8bc1";
/** A tile heavier than this is cut in four (and again), so a browser never fetches more at once. */
const MAX_TILE = 5_000_000;

type Job = { id: number; gz: ArrayBuffer };
type Result = { id: number; aircraft: Aircraft | null; pts: Float64Array; json: number; points: number; airborne: number; ms: number };

if (!isMainThread) {
  // Worker: unpack one trace, keep its low airborne points.
  const { types, maxFt } = workerData as { types: Record<string, { desc: string }>; maxFt: number };
  parentPort!.on("message", (job: Job) => {
    const t0 = performance.now();
    const raw = gunzipSync(Buffer.from(job.gz));
    const doc = JSON.parse(raw.toString("utf8")) as { icao: string; r?: string; t?: string; timestamp: number; trace: unknown[][] };
    const points: number[] = [];
    let airborne = 0;
    let category: string | undefined;
    for (const p of doc.trace) {
      const meta = p[8] as { category?: string } | null;
      if (meta?.category) category = meta.category;
      const alt = p[3];
      if (alt === "ground" || alt === null || p[1] === null || p[2] === null) continue;
      airborne++;
      const flags = p[6] as number;
      // Bit 3: the altitude field is geometric (no pressure altitude received).
      const baro = flags & 8 ? null : (alt as number);
      const geom = flags & 8 ? (alt as number) : (p[10] as number | null);
      if ((baro ?? geom ?? Infinity) > maxFt) continue;
      const gs = p[4] as number | null;
      const track = p[5] as number | null;
      if (gs === null || track === null) continue;
      const source = String(p[9] ?? "");
      const vrate = (p[11] as number | null) ?? (p[7] as number | null) ?? 0;
      points.push(doc.timestamp + (p[0] as number), p[1] as number, p[2] as number, geom ?? baro!, gs, track, vrate, (geom === null ? 1 : 0) | (source.startsWith("mlat") || source.startsWith("tisb") ? 2 : 0));
    }
    const type = (doc.t ?? "").trim();
    const kind: Kind = kindOfDescription(types[type]?.desc, category);
    const aircraft: Aircraft | null = points.length ? { hex: doc.icao, kind, type, registration: (doc.r ?? "").trim() } : null;
    const pts = Float64Array.from(points);
    const result: Result = { id: job.id, aircraft, pts, json: raw.length, points: doc.trace.length, airborne, ms: performance.now() - t0 };
    parentPort!.postMessage(result, [pts.buffer]);
  });
}

/** Gzip with a fixed header (no time, no OS): the same bytes in give the same file on any machine
 * running the same zlib (Node's own). */
function gzipFixed(bytes: Uint8Array): Uint8Array {
  const body = deflateRawSync(bytes, { level: 6 });
  const out = new Uint8Array(10 + body.length + 8);
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);
  out.set(body, 10);
  const view = new DataView(out.buffer);
  view.setUint32(10 + body.length, crc32(bytes), true);
  view.setUint32(14 + body.length, bytes.length >>> 0, true);
  return out;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The days asked: YYYY-MM-DD, or a range YYYY-MM-DD..YYYY-MM-DD. */
function daysOf(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(a);
    if (range) for (let t = Date.parse(range[1]); t <= Date.parse(range[2]); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) out.push(a);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const days = daysOf(args);
  if (!days.length) throw new Error("usage: pnpm history:build YYYY-MM-DD [YYYY-MM-DD..YYYY-MM-DD] [--out dir] [--workers n] [--max-ft 10000] [--pod prod-0] [--force] [--peek]");
  const out = pathToFileURL(resolve(flag("out", fileURLToPath(new URL("../evals/.cache/history/", import.meta.url)))) + "/");
  const options = {
    out,
    peek: args.includes("--peek"),
    force: args.includes("--force"),
    workers: Number(flag("workers", String(Math.min(6, availableParallelism())))),
    maxFt: Number(flag("max-ft", "10000")),
    pod: flag("pod", "prod-0"),
  };
  // A whole day of the world at 60 MB/s plus parsing: well under an hour each.
  setTimeout(() => process.exit(1), days.length * 60 * 60_000).unref();
  for (const day of days) await indexDay(day, options);
}

async function indexDay(day: string, o: { out: URL; peek: boolean; force: boolean; workers: number; maxFt: number; pod: string }) {
  const { workers, maxFt, peek } = o;
  const OUT = new URL(`${day}/`, o.out);
  if (!peek && !o.force && existsSync(new URL("manifest.json", OUT))) {
    console.log(`${day}: already built in ${fileURLToPath(OUT)}`);
    return;
  }
  mkdirSync(OUT, { recursive: true });

  // ICAO type designator to description (L1P, H2T, L2J...), tar1090-db (gzip even as .js).
  const typesFile = new URL(`icao_aircraft_types-${TYPES_COMMIT.slice(0, 7)}.json`, o.out);
  if (!existsSync(typesFile)) {
    const res = await fetch(`https://raw.githubusercontent.com/wiedehopf/tar1090-db/${TYPES_COMMIT}/db/icao_aircraft_types.js`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`tar1090-db types: HTTP ${res.status}`);
    writeFileSync(typesFile, gunzipSync(Buffer.from(await res.arrayBuffer())));
  }
  const types = JSON.parse(readFileSync(typesFile, "utf8")) as Record<string, { desc: string }>;

  const [y, m, d] = day.split("-");
  const repository = `adsblol/globe_history_${y}`;
  const tag = `v${y}.${m}.${d}-planes-readsb-${o.pod}`;
  const meta = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, { signal: AbortSignal.timeout(30_000) });
  if (!meta.ok) throw new Error(`release ${tag}: HTTP ${meta.status}`);
  const assets = ((await meta.json()) as { assets: { name: string; size: number }[] }).assets
    .filter((a) => /\.tar(\.a[a-z])?$/.test(a.name))
    .map(({ name, size }) => ({ name, size }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const total = assets.reduce((s, a) => s + a.size, 0);
  console.log(`${tag}: ${assets.map((a) => a.name.replace(tag, "")).join(" + ")}, ${(total / 1e9).toFixed(2)} GB`);

  const t0 = performance.now();
  let netMs = 0;
  let bytes = 0;
  async function* stream(): AsyncGenerator<Uint8Array> {
    for (const a of assets) {
      const res = await fetch(`https://github.com/${repository}/releases/download/${tag}/${a.name}`, { headers: { "user-agent": "unheard-history/1" } });
      if (!res.ok || !res.body) throw new Error(`${a.name}: HTTP ${res.status}`);
      const reader = res.body.getReader();
      for (;;) {
        const w = performance.now();
        const { done, value } = await reader.read();
        netMs += performance.now() - w;
        if (done) break;
        bytes += value.length;
        yield value;
      }
    }
  }

  // Workers, fed as fast as they drain, never more than a few jobs each in flight.
  const pool = Array.from({ length: workers }, () => new Worker(new URL(import.meta.url), { workerData: { types, maxFt } }));
  const pending = new Map<number, (r: Result) => void>();
  for (const w of pool) w.on("message", (r: Result) => pending.get(r.id)?.(r));
  let next = 0;
  let inFlight = 0;
  let drained: (() => void) | null = null;
  const stats = { traces: 0, json: 0, points: 0, airborne: 0, kept: 0, aircraft: 0, workerMs: 0, byKind: {} as Record<string, { aircraft: number; points: number }> };
  const kindName = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]));

  const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
  const tiles = new Map<string, TileWriter>();
  const peeked: unknown[] = [];
  const settle = (r: Result) => {
    inFlight--;
    stats.traces++;
    stats.json += r.json;
    stats.points += r.points;
    stats.airborne += r.airborne;
    stats.workerMs += r.ms;
    const a = r.aircraft;
    if (a) {
      const n = r.pts.length / STRIDE;
      stats.aircraft++;
      stats.kept += n;
      const k = (stats.byKind[kindName[a.kind]] ??= { aircraft: 0, points: 0 });
      k.aircraft++;
      k.points += n;
      if (peek && peeked.length < 3) peeked.push({ ...a, first: Array.from(r.pts.subarray(0, STRIDE)), n });
      // Consecutive points in the same tile make one run of this aircraft there.
      for (let i = 0; i < n; i++) {
        const lat0 = Math.floor(r.pts[i * STRIDE + 1]);
        const lon0 = Math.floor(r.pts[i * STRIDE + 2]);
        const key = `${lat0}_${lon0}`;
        let w = tiles.get(key);
        if (!w) tiles.set(key, (w = new TileWriter(dayStart, lat0, lon0)));
        w.add(a, r.pts, i);
      }
    }
    if (drained && inFlight < workers * 4) {
      const d = drained;
      drained = null;
      d();
    }
  };
  const dispatch = async (gz: Uint8Array) => {
    if (inFlight >= workers * 8) await new Promise<void>((r) => (drained = r));
    const id = next++;
    inFlight++;
    pending.set(id, (r) => {
      pending.delete(id);
      settle(r);
    });
    const ab = gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer;
    pool[id % workers].postMessage({ id, gz: ab } satisfies Job, [ab]);
  };

  // A minimal streaming tar reader: 512-byte headers, GNU long names, pax paths.
  let buf = new Uint8Array(0);
  let need = 512;
  let state: "header" | "data" | "skip" = "header";
  let entryName = "";
  let entrySize = 0;
  let longName: string | null = null;
  let data: Uint8Array[] = [];
  let got = 0;
  let traceFiles = 0;
  const str = (b: Uint8Array) => {
    const z = b.indexOf(0);
    return new TextDecoder().decode(z >= 0 ? b.subarray(0, z) : b);
  };
  const octal = (b: Uint8Array) => {
    if (b[0] & 0x80) {
      let n = 0;
      for (let i = 1; i < b.length; i++) n = n * 256 + b[i];
      return n;
    }
    return parseInt(str(b).trim() || "0", 8);
  };
  const padded = (n: number) => Math.ceil(n / 512) * 512;
  let typeflag = "";
  let finished = false;
  outer: for await (const chunk of stream()) {
    let pos = 0;
    while (pos < chunk.length) {
      if (state === "header") {
        const take = Math.min(need - buf.length, chunk.length - pos);
        const merged = new Uint8Array(buf.length + take);
        merged.set(buf);
        merged.set(chunk.subarray(pos, pos + take), buf.length);
        buf = merged;
        pos += take;
        if (buf.length < need) continue;
        const h = buf;
        buf = new Uint8Array(0);
        if (h.every((x) => x === 0)) {
          finished = true;
          break outer;
        }
        const name = str(h.subarray(0, 100));
        const prefix = str(h.subarray(345, 500));
        entryName = longName ?? (prefix ? `${prefix}/${name}` : name);
        longName = null;
        entrySize = octal(h.subarray(124, 136));
        typeflag = String.fromCharCode(h[156] || 48);
        got = 0;
        data = [];
        const wanted = typeflag === "L" || typeflag === "x" || (typeflag === "0" && /trace_full_~?[0-9a-f]+\.json$/.test(entryName));
        state = wanted ? "data" : "skip";
        need = padded(entrySize);
        if (need === 0) {
          state = "header";
          need = 512;
        }
        continue;
      }
      const take = Math.min(need - got, chunk.length - pos);
      if (state === "data") data.push(chunk.subarray(pos, pos + Math.min(take, Math.max(0, entrySize - got))));
      got += take;
      pos += take;
      if (got < need) continue;
      if (state === "data") {
        const body = Buffer.concat(data);
        if (typeflag === "L") longName = str(body);
        else if (typeflag === "x") {
          const path = /\d+ path=([^\n]+)\n/.exec(new TextDecoder().decode(body));
          if (path) longName = path[1];
        } else {
          traceFiles++;
          await dispatch(new Uint8Array(body));
          if (peek && traceFiles >= 40) break outer;
        }
      }
      state = "header";
      need = 512;
    }
  }
  while (inFlight > 0) await new Promise<void>((r) => (drained = r));
  for (const w of pool) await w.terminate();
  const streamed = performance.now() - t0;
  if (peek) {
    console.log(JSON.stringify(peeked, null, 1).slice(0, 3000));
    console.log({ traceFiles, ...stats });
    return;
  }
  if (!finished) throw new Error(`${tag}: the tar ended without its closing blocks`);

  // Write the tiles (heavy ones cut in four, again if need be).
  const t1 = performance.now();
  const regions: Record<string, (lat: number, lon: number) => boolean> = {
    world: () => true,
    "contiguous US": (lat, lon) => lat >= 24 && lat < 50 && lon >= -125 && lon < -66,
    Europe: (lat, lon) => lat >= 35 && lat < 72 && lon >= -25 && lon < 45,
  };
  const sizes: Record<string, { tiles: number; bytes: number; points: number; propBytes: number }> = Object.fromEntries(Object.keys(regions).map((r) => [r, { tiles: 0, bytes: 0, points: 0, propBytes: 0 }]));
  const entries: Manifest["tiles"] = {};
  const queue = [...tiles.values()];
  while (queue.length) {
    const w = queue.pop()!;
    const content = w.bytes();
    const gz = gzipFixed(content);
    if (gz.length > MAX_TILE && w.size > 0.125) {
      queue.push(...w.quarters());
      continue;
    }
    const name = `${w.lat0}_${w.lon0}`;
    writeFileSync(new URL(`${name}.bin.gz`, OUT), gz);
    entries[name] = { lat0: w.lat0, lon0: w.lon0, size: w.size, runs: w.runs, points: w.points, bytes: gz.length, sha256: sha256(gz), content: sha256(content) };
    // What a propeller-and-rotor store would weigh: the same tile without the jets and the unknown.
    const propBytes = gzipFixed(w.bytes((a) => isProp(a.kind))).length;
    for (const [region, inside] of Object.entries(regions)) {
      if (!inside(w.lat0 + w.size / 2, w.lon0 + w.size / 2)) continue;
      sizes[region].tiles++;
      sizes[region].bytes += gz.length;
      sizes[region].points += w.points;
      sizes[region].propBytes += propBytes;
    }
  }
  const manifest: Manifest = {
    format: `unheard-history/v${FORMAT}`,
    build: BUILD,
    day,
    source: { repository, release: tag, assets, licence: "ODbL-1.0", attribution: "© adsb.lol contributors" },
    types: { source: "https://github.com/wiedehopf/tar1090-db", commit: TYPES_COMMIT },
    filter: `airborne, at or below ${maxFt} ft pressure altitude (geometric when no pressure altitude), with ground speed and track`,
    tiles: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))),
    totals: { tiles: Object.keys(entries).length, aircraft: stats.aircraft, points: stats.kept, bytes: sizes.world.bytes },
  };
  writeFileSync(new URL("manifest.json", OUT), JSON.stringify(manifest, null, 1) + "\n");
  const written = performance.now() - t1;

  const tileBytes = Object.values(entries)
    .map((t) => t.bytes)
    .sort((a, b) => a - b);
  const busiest = Object.entries(entries).sort((a, b) => b[1].bytes - a[1].bytes)[0];
  const q = (p: number) => tileBytes[Math.min(tileBytes.length - 1, Math.floor(p * tileBytes.length))];
  // This run's own measures, apart from the manifest (which must not change from one run to the next).
  const build = {
    day,
    tar: { bytes, seconds: Math.round(streamed / 100) / 10, waitingOnNetworkSeconds: Math.round(netMs / 100) / 10, mbPerSecond: Math.round(bytes / 1e6 / (streamed / 1000)) },
    workers,
    workerCpuSeconds: Math.round(stats.workerMs / 100) / 10,
    writeSeconds: Math.round(written / 100) / 10,
    peakMemoryMB: Math.round(process.resourceUsage().maxRSS / 1024),
    traces: stats.traces,
    jsonGB: Math.round(stats.json / 1e7) / 100,
    points: stats.points,
    airborne: stats.airborne,
    kept: stats.kept,
    aircraft: stats.aircraft,
    byKind: stats.byKind,
    tile: { count: tileBytes.length, median: q(0.5), p99: q(0.99), busiest: busiest ? { name: busiest[0], bytes: busiest[1].bytes, points: busiest[1].points } : null },
    sizes,
  };
  writeFileSync(new URL("build.json", OUT), JSON.stringify(build, null, 1) + "\n");
  console.log(JSON.stringify(build, null, 1));
}

if (isMainThread) await main();
