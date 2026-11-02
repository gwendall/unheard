// Fetches the real-audio eval set into evals/.cache/aerosonic/ (never committed: AeroSonicDB is
// CC BY-NC 4.0, ADS-B Exchange samples are for evaluation only and may not be redistributed).
// See evals/DATASETS.md.
//
// For each AeroSonicDB clip recorded on 2023-03-01 (the only day with free ADS-B history at
// Adelaide): the WAV (pulled out of the 1.17 GB zip with HTTP ranges, via `uvx remotezip`), and
// every ADS-B Exchange snapshot (one per 5 s, the whole world, readsb JSON like adsb.lol's)
// from 30 s before the clip to its end, cut to 40 km around the microphone and slimmed to a Poll.
//
//   node scripts/fetch-aerosonic.ts

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { slimPoll, type Poll } from "../lib/adsb.ts";

setTimeout(() => process.exit(1), 30 * 60_000).unref();

const ROOT = new URL("../evals/.cache/aerosonic/", import.meta.url);
const ZENODO = "https://zenodo.org/api/records/10215080/files";
const DATE = "2023-03-01";
mkdirSync(ROOT, { recursive: true });

async function get(url: string): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try {
      // Zenodo answers 403 to a request without a user agent.
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { "user-agent": "unheard-evals/0.1" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function cached(name: string, url: string): Promise<Buffer> {
  const path = new URL(name, ROOT);
  if (existsSync(path)) return readFileSync(path);
  const buf = await get(url);
  writeFileSync(path, buf);
  return buf;
}

const csv = (await cached("sample_meta.csv", `${ZENODO}/sample_meta.csv/content`)).toString("utf8").trim().split("\n");
const head = csv[0].split(",");
const rows = csv.slice(1).map((line) => Object.fromEntries(line.split(",").map((v, i) => [head[i], v])));
// The published locations.json lacks its closing brace.
const locationsText = (await cached("locations.json", `${ZENODO}/locations.json/content`)).toString("utf8").trim();
const locations = JSON.parse(locationsText.endsWith("}\n}") || /}\s*}$/.test(locationsText) ? locationsText : `${locationsText}\n}`) as Record<string, { lattitude: number; longitude: number }>;
const clips = rows.filter((r) => r.date.startsWith(DATE) && r.class === "1");
console.log(`${clips.length} aircraft clips on ${DATE}`);

/** Local Adelaide wall time to UTC seconds, through the time zone database (never a fixed offset). */
function adelaideToUtc(date: string, time: string): number {
  const [y, mo, d] = date.slice(0, 10).split("-").map(Number);
  const [h, mi, s] = time.split(/[-:]/).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Australia/Adelaide", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(guess));
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (guess - (shown - guess)) / 1000;
}

const KM = 40;
async function snapshot(t: number, lat: number, lon: number): Promise<Poll> {
  const d = new Date(t * 1000);
  const name = `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}Z`;
  const slimPath = new URL(`snapshots/${name}-${lat.toFixed(3)}_${lon.toFixed(3)}.json`, ROOT);
  if (existsSync(slimPath)) return JSON.parse(readFileSync(slimPath, "utf8"));
  const raw = JSON.parse((await get(`https://samples.adsbexchange.com/readsb-hist/${DATE.replace(/-/g, "/")}/${name}.json.gz`)).toString("utf8"));
  const poll = slimPoll(raw);
  poll.aircraft = poll.aircraft.filter((a) => Math.hypot((a.lat! - lat) * 111.2, (a.lon! - lon) * 111.2 * Math.cos((lat * Math.PI) / 180)) < KM);
  mkdirSync(new URL("snapshots/", ROOT), { recursive: true });
  writeFileSync(slimPath, JSON.stringify(poll));
  return poll;
}

// Air temperature from Open-Meteo's archive (hourly), for the speed of sound.
const temps = new Map<string, number[]>();
async function temperature(lat: number, lon: number, t: number): Promise<number> {
  const key = `${lat},${lon}`;
  if (!temps.has(key)) {
    const body = JSON.parse((await cached(`weather-${lat}_${lon}.json`, `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${DATE}&end_date=${DATE}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m&timezone=GMT`)).toString("utf8"));
    temps.set(key, body.hourly.temperature_2m);
  }
  return temps.get(key)![new Date(t * 1000).getUTCHours()];
}

for (const clip of clips) {
  const file = clip.filename;
  const dir = new URL(`clips/${file.replace(/\.wav$/, "")}/`, ROOT);
  mkdirSync(dir, { recursive: true });
  const wav = new URL("audio.wav", dir);
  if (!existsSync(wav)) {
    const tmp = new URL("zip/", dir);
    const r = spawnSync("uvx", ["remotezip", "-d", tmp.pathname, `${ZENODO}/audio.zip/content`, `audio/1/${file}`], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`remotezip failed for ${file}`);
    renameSync(new URL(`audio/1/${file}`, tmp), wav);
  }
  const loc = locations[clip.location];
  const start = adelaideToUtc(clip.date, clip.time);
  const polls: Poll[] = [];
  for (let t = Math.floor((start - 30) / 5) * 5; t <= start + Number(clip.file_length || 60); t += 5) polls.push(await snapshot(t, loc.lattitude, loc.longitude));
  const meta = {
    file,
    hex: clip.hex_id.toLowerCase(),
    type: clip.typedesig,
    engine: clip.engtype,
    start,
    listener: { lat: loc.lattitude, lon: loc.longitude, elevation: 6 },
    temperatureC: await temperature(loc.lattitude, loc.longitude, start),
    audible: { from: Number(clip.offset), duration: Number(clip.duration) },
  };
  writeFileSync(new URL("meta.json", dir), JSON.stringify(meta, null, 2));
  writeFileSync(new URL("polls.json", dir), JSON.stringify(polls));
  const seen = polls.flatMap((p) => p.aircraft).some((a) => a.hex === meta.hex);
  console.log(`${file}: ${polls.length} polls, ${new Set(polls.flatMap((p) => p.aircraft.map((a) => a.hex))).size} aircraft, target ${seen ? "present" : "MISSING"}`);
}
