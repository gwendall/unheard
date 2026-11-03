// Fetches the Livermore set into evals/.cache/livermore/ (never committed, about 130 MB): 40
// smartphone recordings of light aircraft over Livermore, California, in May 2026, each with its
// ADS-B track (KML), by Praveen Pathak, Zenodo record 23424278, CC BY 4.0. See evals/DATASETS.md.
//
// Every file is checked against the size and MD5 the Zenodo API publishes, then each zip is
// unpacked into its own empty directory under extracted/. Downloads are data: nothing in them is
// ever run, and member paths that leave their directory are refused.
//
//   node scripts/fetch-livermore.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

setTimeout(() => process.exit(1), 30 * 60_000).unref();

const RECORD = "23424278";
const ROOT = new URL("../evals/.cache/livermore/", import.meta.url);
const DOWNLOADS = new URL("downloads/", ROOT);
const EXTRACTED = new URL("extracted/", ROOT);
// The four "Raw data_*" zips and the results table; the PDFs and the HTML tool are not needed.
const WANTED = (key: string) => key.endsWith(".zip") || key === "final_results_40_cases.csv";
// Zenodo answers 403 to a request without a user agent.
const HEADERS = { "user-agent": "unheard-evals/0.1" };

mkdirSync(DOWNLOADS, { recursive: true });
mkdirSync(EXTRACTED, { recursive: true });

type ZenodoFile = { key: string; size: number; checksum: string; links: { self: string } };

const res = await fetch(`https://zenodo.org/api/records/${RECORD}`, { headers: HEADERS, signal: AbortSignal.timeout(60_000) });
if (!res.ok) throw new Error(`Zenodo API: HTTP ${res.status}`);
const record = (await res.json()) as { metadata: { license?: { id: string } }; files: ZenodoFile[] };
if (record.metadata.license?.id !== "cc-by-4.0") throw new Error(`unexpected license ${record.metadata.license?.id}: read evals/DATASETS.md before using this set`);
writeFileSync(new URL("record.json", ROOT), JSON.stringify(record, null, 1));

function md5Of(path: URL): string {
  return createHash("md5").update(readFileSync(path)).digest("hex");
}

/** Downloads one file, streamed, unless a copy with the right size and MD5 is already there. */
async function download(file: ZenodoFile): Promise<URL> {
  const dest = new URL(file.key.replace(/[^\w.-]+/g, "_"), DOWNLOADS);
  const md5 = file.checksum.replace(/^md5:/, "");
  if (existsSync(dest) && statSync(dest).size === file.size && md5Of(dest) === md5) return dest;
  for (let attempt = 1; ; attempt++) {
    const tmp = new URL(`${dest.pathname.split("/").pop()}.part`, DOWNLOADS);
    try {
      const r = await fetch(file.links.self, { headers: HEADERS, signal: AbortSignal.timeout(15 * 60_000) });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status} ${file.key}`);
      const hash = createHash("md5");
      let size = 0;
      const tap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          hash.update(chunk);
          size += chunk.length;
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(r.body as import("node:stream/web").ReadableStream), tap, createWriteStream(tmp));
      const got = hash.digest("hex");
      if (size !== file.size || got !== md5) throw new Error(`${file.key}: ${size} bytes md5 ${got}, Zenodo says ${file.size} bytes md5 ${md5}`);
      renameSync(tmp, dest);
      console.log(`${file.key}: ${(size / 1e6).toFixed(1)} MB, md5 ok`);
      return dest;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((ok) => setTimeout(ok, 3000 * attempt));
    }
  }
}

/** Unpacks a zip into its own new directory, after checking that no member path leaves it. */
function unzip(zip: URL, name: string) {
  const dest = new URL(`${name}/`, EXTRACTED);
  const done = new URL(".done", dest);
  if (existsSync(done)) return;
  const list = spawnSync("unzip", ["-Z1", fileURLToPath(zip)], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (list.status !== 0) throw new Error(`unzip -Z1 ${name}: ${list.stderr}`);
  const bad = list.stdout.split("\n").filter((p) => p.startsWith("/") || p.split(/[\\/]/).includes(".."));
  if (bad.length) throw new Error(`${name}: refusing member paths ${bad.slice(0, 3).join(", ")}`);
  if (existsSync(dest)) throw new Error(`${fileURLToPath(dest)} exists but was not finished: move it away and run again`);
  mkdirSync(dest);
  const r = spawnSync("unzip", ["-q", "-n", fileURLToPath(zip), "-d", fileURLToPath(dest), "-x", "__MACOSX/*"], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`unzip ${name} failed`);
  writeFileSync(done, "ok\n");
}

for (const file of record.files.filter((f) => WANTED(f.key))) {
  const path = await download(file);
  if (file.key.endsWith(".zip")) unzip(path, file.key.replace(/\.zip$/, "").replace(/[^\w.-]+/g, "_"));
}

// Air temperature over the recording days, hourly, from Open-Meteo's archive, for the speed of
// sound. Asked for the town (0.1 degree), not for the recorder's spot.
const weather = new URL("weather.json", ROOT);
if (!existsSync(weather)) {
  const days = readFileSync(new URL("final_results_40_cases.csv", DOWNLOADS), "utf8").match(/\d{4}-\d{2}-\d{2}T/g)!.map((d) => d.slice(0, 10)).sort();
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=37.7&longitude=-121.8&start_date=${days[0]}&end_date=${days[days.length - 1]}&hourly=temperature_2m&timezone=GMT`;
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`Open-Meteo: HTTP ${r.status}`);
  writeFileSync(weather, JSON.stringify(await r.json()));
  console.log(`weather.json: ${days[0]} to ${days[days.length - 1]}`);
}
console.log(`ready in ${fileURLToPath(ROOT)}`);
