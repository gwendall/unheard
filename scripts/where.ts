// Where and when was this recorded? From the command line, on any machine with Node 22:
//
//   pnpm where <audio> --day 2026-09-08 --near 40.8,-73.7 [--radius 50] [--from 18:00 --to 23:00]
//                      [--history <folder or URL>] [--temp 15]
//
// The audio: WAV, or anything ffmpeg reads when ffmpeg is installed. The day is UTC; --from and
// --to narrow the window the recording may have started in (UTC). The search covers a square of
// twice the radius around --near. The flight history comes from --history (default
// evals/.cache/history/); a day missing from a local folder is built there first (about 3 GB
// streamed from adsb.lol, a few minutes). The ground's height comes from the open terrain tiles
// (cached in evals/.cache/terrain/).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeWav } from "../lib/bundle";
import { ANALYSIS_RATE } from "../lib/core/pipeline";
import { findSegments, flybys, whereWhen } from "../lib/core/wherewhen";
import { httpFetcher, loadFlights, type Fetcher } from "../lib/history";
import { groundOf } from "../lib/terrain";
import { cachedTiles, fileFetcher } from "../evals/lib/history";
import { resample } from "../lib/core/resample";

setTimeout(() => process.exit(1), 60 * 60_000).unref();

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const audio = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
const day = flag("day");
const near = flag("near")?.split(",").map(Number);
if (!audio || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !near || near.length !== 2 || near.some((x) => !Number.isFinite(x))) {
  console.error("usage: pnpm where <audio> --day YYYY-MM-DD --near lat,lon [--radius km] [--from HH:MM --to HH:MM] [--history folder|url] [--temp °C]");
  process.exit(2);
}
const radius = Number(flag("radius") ?? 50) * 1000;
const history = flag("history") ?? fileURLToPath(new URL("../evals/.cache/history/", import.meta.url));

/** Mono samples at the analysis rate. */
function readAudio(path: string): Float32Array {
  if (/\.wav$/i.test(path)) {
    const wav = decodeWav(new Uint8Array(readFileSync(path)));
    return resample(wav.samples, wav.sampleRate, ANALYSIS_RATE);
  }
  const ff = spawnSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", String(ANALYSIS_RATE), "-f", "s16le", "-"], { maxBuffer: 2 ** 31 });
  if (ff.error || ff.status !== 0) throw new Error(`${path}: not a WAV and ffmpeg could not read it (${ff.error?.message ?? ff.stderr.toString().trim()})`);
  const pcm = new Int16Array(ff.stdout.buffer, ff.stdout.byteOffset, ff.stdout.byteLength >> 1);
  return Float32Array.from(pcm, (x) => x / 32768);
}

const t0 = performance.now();
const samples = readAudio(resolve(audio));
const duration = samples.length / ANALYSIS_RATE;
console.log(`${audio}: ${Math.round(duration)} s`);

// The history: a URL, or a local folder where a missing day is built on demand.
let fetcher: Fetcher;
if (/^https?:\/\//.test(history)) fetcher = httpFetcher(history);
else {
  const dir = pathToFileURL(resolve(history) + "/");
  if (!existsSync(new URL(`${day}/manifest.json`, dir))) {
    console.log(`${day} is not in ${fileURLToPath(dir)}: building it (about 3 GB streamed from adsb.lol)`);
    const built = spawnSync(process.execPath, [fileURLToPath(new URL("./history-index.ts", import.meta.url)), day, "--out", fileURLToPath(dir)], { stdio: "inherit" });
    if (built.status !== 0) throw new Error(`could not build ${day}`);
  }
  fetcher = fileFetcher(dir);
}

const { segments, searched } = findSegments(samples, ANALYSIS_RATE);
const air = { groundTempC: Number(flag("temp") ?? 15) };
// What each tone says on its own: when it passed closest, how fast and how far.
const heard = flybys(segments, air);
console.log(`${heard.length} aircraft tones${heard.length ? ":" : "."}`);
for (const h of heard) console.log(`  ${Math.round(h.from)} to ${Math.round(h.to)} s: closest at ${Math.round(h.closest)} s, ${Math.round(h.f0)} Hz at rest, ${h.speeds.join(" to ")} m/s, ${h.distances.join(" to ")} m away`);
if (!heard.length) process.exit(0);

const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
const at = (hhmm: string | undefined, fallback: number) => (hhmm ? dayStart + Number(hhmm.split(":")[0]) * 3600 + Number(hhmm.split(":")[1] ?? 0) * 60 : fallback);
const window: [number, number] = [at(flag("from"), dayStart), at(flag("to"), dayStart + 86_400 - duration)];
const area = { lat: near[0], lon: near[1], side: 2 * radius };
// A recording that starts late in the day may run into the next one.
const days = [day, ...(window[1] + duration > dayStart + 86_400 ? [new Date((dayStart + 86_400) * 1000).toISOString().slice(0, 10)] : [])];
const { flights, bytes, missing } = await loadFlights(fetcher, days, area);
if (missing.includes(day)) throw new Error(`${day}: no history at ${history}`);
const ground = await groundOf(cachedTiles(), area.lat, area.lon, area.side);
console.log(`${flights.length} aircraft in the history around (${Math.round(bytes / 1e5) / 10} MB of tiles)`);

const ww = await whereWhen(segments, flights, { window, area, ground, air, searched });
const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000", "");
console.log(ww.answers.length ? `\n${ww.confident ? "Found" : "Best guesses (not sure)"}:` : "\nNothing fits.");
for (const [i, a] of ww.answers.entries()) {
  // One line per aircraft, with the tone the fine search measured when it has one.
  const byHex = new Map<string, (typeof a.planes)[number]>();
  for (const p of a.planes) if (!byHex.has(p.hex) || p.f0) byHex.set(p.hex, p);
  const planes = [...byHex.values()].map((p) => `${p.registration || p.hex} (${p.type || "?"}${p.f0 ? `, ${p.f0} Hz` : ""})`).join(", ");
  console.log(`${i + 1}. ${a.lat.toFixed(5)}, ${a.lon.toFixed(5)}  started ${iso(a.start)}  ${a.wellHeard} flyover(s) heard well (evidence ${a.evidence.toFixed(2)})  ${planes}${a.mirror ? `  mirror ${a.mirror.lat.toFixed(5)}, ${a.mirror.lon.toFixed(5)}` : ""}${a.silent.length ? `  silent: ${a.silent.join(" ")}` : ""}`);
}
console.log(`\n${ww.candidates} candidates from ${ww.flights} aircraft, ${Math.round((performance.now() - t0) / 100) / 10} s. Flight data © adsb.lol contributors (ODbL 1.0).`);
