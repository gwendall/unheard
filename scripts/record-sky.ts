// Records real ADS-B around a point, polled exactly as the page polls it (same API, same slimming),
// to evals/fixtures/sky/<name>-<time>.jsonl.gz: one Poll per line. The real-track evals replay
// these: every poll is the truth, a sparser and noisier subset is what the page sees.
// adsb.lol answers 429 past about one request per second per address: one recorder at a time,
// every `every` seconds, and a pause of 10 s after a 429.
//
//   node scripts/record-sky.ts <name> <lat> <lon> [minutes=20] [radiusNm=30] [every=1.5]

import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { slimPoll } from "../lib/adsb.ts";

const [name, lat, lon, minutes = "20", radius = "30", every = "1.5"] = process.argv.slice(2);
if (!name || !lat || !lon) {
  console.error("usage: node scripts/record-sky.ts <name> <lat> <lon> [minutes] [radiusNm]");
  process.exit(2);
}
const end = Date.now() + Number(minutes) * 60_000;
// Hard budget from inside: never outlive the recording by more than a minute.
setTimeout(() => process.exit(1), Number(minutes) * 60_000 + 60_000).unref();

const dir = new URL("../evals/fixtures/sky/", import.meta.url);
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:]/g, "");
// Plain lines first, so a cut run keeps every poll it made; compressed once finished.
const path = new URL(`${name}-${stamp}.jsonl`, dir);
const header = { name, lat: Number(lat), lon: Number(lon), radiusNm: Number(radius), source: "api.adsb.lol/v2/point" };
writeFileSync(path, JSON.stringify({ header }) + "\n");

let polls = 0;
let failures = 0;
while (Date.now() < end) {
  const t = Date.now();
  try {
    const res = await fetch(`https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`, { signal: AbortSignal.timeout(4000) });
    if (res.status === 429) {
      failures++;
      console.error(`${new Date().toISOString()} 429, pausing 10 s`);
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const poll = slimPoll(await res.json());
    // Only what can be heard: below 20,000 ft.
    poll.aircraft = poll.aircraft.filter((a) => (typeof a.alt_baro === "number" ? a.alt_baro : 0) < 20000 && a.alt_baro !== "ground");
    appendFileSync(path, JSON.stringify(poll) + "\n");
    polls++;
    if (polls % 60 === 0) console.log(`${new Date().toISOString()} ${polls} polls, ${poll.aircraft.length} aircraft, ${failures} failures`);
  } catch (e) {
    failures++;
    if (failures % 10 === 1) console.error(`poll failed: ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, Math.max(0, Number(every) * 1000 - (Date.now() - t))));
}
const gz = new URL(`${name}-${stamp}.jsonl.gz`, dir);
writeFileSync(gz, gzipSync(readFileSync(path)));
unlinkSync(path);
console.log(`done: ${polls} polls, ${failures} failures -> ${gz.pathname}`);
