// Where and when (lib/core/wherewhen.ts): the Livermore phone recordings searched blind, with
// only their UTC day or hour and a square of the Bay Area (100 km, then 300 km), against a day of
// adsb.lol history (scripts/history-index.ts). How far the best spot lands from the truth, how
// far its start time, how often the confidence flag is right, what a search costs.
//
//   SIDES=100000,300000 WINDOWS=day,hour ONLY=lvk-N86LP_R01 pnpm eval evals/wherewhen
//   ONLY=singles | pairs | colsto (or a list of them) runs one part.
//
// Needs evals/.cache/livermore (node scripts/fetch-livermore.ts) and the recording days indexed
// (node scripts/history-index.ts 2026-05-16 ...). The microphone positions are recomputed from
// the cache, never written here (one of them may be a private address).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { decodeWav } from "../lib/bundle";
import { expect, it } from "vitest";
import { offsetOf } from "../lib/core/locate";
import { findSegments, whereWhen, type WhereWhen } from "../lib/core/wherewhen";
import { groundAround, historyAround, indexedDays } from "./lib/history";
import { livermoreScenarios } from "./lib/real";

const SIDES = (process.env.SIDES ?? "100000,300000").split(",").map(Number);
const ONLY = process.env.ONLY?.split(",");
/** `day`: the UTC day. `hour`: the UTC hour holding the true start (what a file's date tells). */
const WINDOWS = (process.env.WINDOWS ?? "day,hour").split(",") as ("day" | "hour")[];
/** The earliest and latest start searched, for a recording `length` seconds long. */
const windowOf = (kind: "day" | "hour", start: number, length: number): [number, number] => {
  if (kind === "hour") return [Math.floor(start / 3600) * 3600, Math.floor(start / 3600) * 3600 + 3600];
  const day = Math.floor(start / 86_400) * 86_400;
  return [day, day + 86_400 - length];
};
/** CPU seconds spent while a search runs (this thread and the collector's). */
const cpuOf = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
  const before = process.cpuUsage();
  const out = await work();
  const used = process.cpuUsage(before);
  return [out, (used.user + used.system) / 1e6];
};
/** Each part writes its own report (the parts can run at once): evals/reports/wherewhen-<part>-<km>.md. */
const reportOf = (part: string, ext = "md") => new URL(`./reports/wherewhen-${part}-${SIDES.map((x) => x / 1000).join("-")}-${WINDOWS.join("-")}.${ext}`, import.meta.url);
/** The Bay Area: the squares are centred on Oakland, not on the recordings (about 40 km east). */
const BAY = { lat: 37.75, lon: -122.2 };

type Outcome = {
  id: string;
  side: number;
  window: "day" | "hour";
  cpu: number;
  traces: number;
  flights: number;
  candidates: number;
  /** Metres from the best answer to the truth, null when nothing was found. */
  error: number | null;
  /** Seconds from the best answer's start to the truth's. */
  timeError: number | null;
  /** Rank of the first answer within 250 m and 30 s of the truth, 0 if none. */
  rank: number;
  /** Rank of the first hypothesis (before the fine search) within 500 m and 30 s, 0 if none. */
  hypothesis: number;
  mirror: number | null;
  /** The best answer lies out on the water (lib/core/sea.ts). */
  atSea: boolean;
  rightAircraft: boolean | null;
  score: number | null;
  evidence: number | null;
  confident: boolean;
  ms: WhereWhen["ms"];
  bytes: number;
  probe: WhereWhen["probe"];
  flybys: WhereWhen["flybys"];
};

/** A full run takes hours (40 recordings, two squares): past vitest's half hour. */
const HOURS = 6 * 3_600_000;

const quantile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
/** Vitest keeps the console to itself: the run's lines go to evals/reports/wherewhen.log. */
const LOG = new URL("./reports/wherewhen.log", import.meta.url);
mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
const log = (line: string) => appendFileSync(LOG, line + "\n");

/** Progress in the log, with the time since the search started. */
const progress = (id: string) => {
  const t0 = performance.now();
  let last = "";
  return (stage: string, done: number, total: number) => {
    if (stage !== last || (stage === "coarse" && done % 50_000 === 0)) log(`  ${id} ${stage} ${done}/${total} at ${Math.round(performance.now() - t0)} ms`);
    last = stage;
  };
};
/** The floors this eval holds to, for the 100 km square alone (evals/baseline.json). */
const floors = (JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8")) as Record<string, Record<string, number> | undefined>).wherewhen;
const ratcheted = SIDES.length === 1 && SIDES[0] === 100_000;
const pct = (k: number, n: number) => (n ? `${Math.round((100 * k) / n)} %` : "-");
const num = (x: number) => (Number.isFinite(x) ? String(Math.round(x)) : "-");

it("where and when", async () => {
  const days = indexedDays();
  if (ONLY?.every((x) => x === "colsto" || x === "pairs")) return;
  const scenarios = livermoreScenarios().filter((s) => s.kind === "heard" && !s.id.includes("missing") && (!ONLY || ONLY.includes("singles") || ONLY.includes(s.id)));
  if (!scenarios.length) return console.log("No Livermore recordings in evals/.cache: node scripts/fetch-livermore.ts");
  const outcomes: Outcome[] = [];
  for (const side of SIDES) {
    const ground = await groundAround(BAY.lat, BAY.lon, side);
    for (const s of scenarios) {
      const truth = s.recording.listener;
      const day = new Date(s.recording.start * 1000).toISOString().slice(0, 10);
      if (!days.has(day)) {
        log(`${s.id}: ${day} not indexed`);
        continue;
      }
      const { flights, bytes } = await historyAround([day], BAY.lat, BAY.lon, side);
      const { segments, searched } = findSegments(s.recording.samples, s.recording.sampleRate);
      const duration = s.recording.samples.length / s.recording.sampleRate;
      for (const window of WINDOWS) {
        const [ww, cpu] = await cpuOf(() => whereWhen(segments, flights, { window: windowOf(window, s.recording.start, duration), area: { ...BAY, side }, ground, air: s.recording.air, searched, probe: { lat: truth.lat, lon: truth.lon, start: s.recording.start }, onProgress: process.env.PROGRESS ? progress(s.id) : undefined }));
        const best = ww.answers[0] ?? null;
        const dist = (p: { lat: number; lon: number }) => Math.hypot(...offsetOf(truth, p.lat, p.lon));
        const answers = [s.truth.heard, ...(s.truth.alsoHeard ?? [])];
        const o: Outcome = {
          id: s.id,
          side,
          window,
          cpu,
          traces: ww.traces,
          flights: ww.flights,
          candidates: ww.candidates,
          error: best ? Math.round(dist(best)) : null,
          timeError: best ? Math.round((best.start - s.recording.start) * 10) / 10 : null,
          rank: ww.answers.findIndex((a) => dist(a) <= 250 && Math.abs(a.start - s.recording.start) <= 30) + 1,
          hypothesis: ww.hypotheses.findIndex((h) => dist(h) <= 500 && Math.abs(h.start - s.recording.start) <= 30) + 1,
          mirror: best?.mirror ? Math.round(dist(best.mirror)) : null,
          atSea: !!best?.atSea,
          rightAircraft: best ? best.planes.some((p) => answers.includes(p.hex)) : null,
          score: best ? Math.round(best.score * 10) / 10 : null,
          evidence: best ? Math.round(best.worth * 10) / 10 : null,
          confident: ww.confident,
          ms: ww.ms,
          bytes,
          probe: ww.probe,
          flybys: ww.flybys,
        };
        outcomes.push(o);
        log(`${o.id} ${side / 1000} km ${window}: ${o.error ?? "-"} m, ${o.timeError ?? "-"} s, rank ${o.rank}, hyp ${o.hypothesis}, ${o.atSea ? "at sea, " : ""}worth ${o.evidence} of ${ww.searched.toFixed(1)}, score ${o.score}, ${o.confident ? "confident" : "unsure"}, ${ww.candidates} fits, ${ww.flights} flights, ${cpu.toFixed(1)} s CPU, ${Math.round(process.memoryUsage().rss / 2 ** 20)} MB, probe ${JSON.stringify({ ...ww.probe, truth: undefined })}`);
      }
    }
  }

  const row = (name: string, xs: Outcome[]) => {
    const n = xs.length;
    const errors = xs.map((o) => o.error ?? Infinity);
    const within = (m: number) => xs.filter((o) => (o.error ?? Infinity) <= m && Math.abs(o.timeError ?? Infinity) <= 30).length;
    const times = xs.filter((o) => o.timeError !== null).map((o) => Math.abs(o.timeError!));
    const conf = xs.filter((o) => o.confident);
    const confRight = conf.filter((o) => (o.error ?? Infinity) <= 1000).length;
    const unsureWrong = xs.filter((o) => !o.confident && (o.error ?? Infinity) > 1000).length;
    const ms = xs.map((o) => o.ms.total);
    const cpu = xs.map((o) => o.cpu);
    return `| ${name} | ${n} | ${num(quantile(errors, 0.5))} | ${num(quantile(errors, 0.9))} | ${pct(within(250), n)} | ${pct(within(1000), n)} | ${num(quantile(times, 0.5))} | ${pct(xs.filter((o) => o.rank > 0).length, n)} | ${pct(xs.filter((o) => o.hypothesis > 0).length, n)} | ${pct(xs.filter((o) => o.rightAircraft).length, n)} | ${conf.length ? `${confRight} of ${conf.length}` : "0"} | ${pct(confRight + unsureWrong, n)} | ${num(quantile(cpu, 0.5))} / ${num(quantile(cpu, 0.9))} / ${num(quantile(ms, 0.5))} |`;
  };
  const lines = [
    "# Eval where and when",
    "",
    `${new Date().toISOString()}, ${outcomes.length} runs: the Livermore phone recordings (Pathak 2026, CC BY 4.0) searched with only their UTC day or hour and a square of the Bay Area centred on Oakland, against that day of adsb.lol history (ODbL 1.0, © adsb.lol contributors).`,
    "- Error: metres from the best answer to the microphone; within N m counts only answers whose start is also within 30 s. Time: |start error|, seconds.",
    "- Truth in answers: an answer within 250 m and 30 s. Truth in hypotheses: one of the 50 best spots and times before the fine search within 500 m and 30 s.",
    "- Flag right: confident and within 1 km, or unsure and not. CPU: seconds of the search in Node on a shared machine, p50 and p90, then wall ms (the Mac is shared), the spectrogram and traces left out.",
    "",
    "| square, window | n | median m | p90 m | <= 250 m | <= 1 km | time s p50 | truth in answers | truth in hypotheses | right aircraft | confident and right | flag right | CPU s p50 / p90 / wall ms |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...SIDES.flatMap((side) => WINDOWS.map((w) => row(`${side / 1000} km, ${w}`, outcomes.filter((o) => o.side === side && o.window === w)))),
    "",
    "| id | square km | window | traces | flights | fits | error m | time s | rank | hypothesis | mirror m | right aircraft | worth | score | confident | CPU s | ms (shape, smooth, scan, join, joint, fine) | tiles kB |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...outcomes.map((o) => `| ${o.id} | ${o.side / 1000} | ${o.window} | ${o.traces} | ${o.flights} | ${o.candidates} | ${o.error ?? ""} | ${o.timeError ?? ""} | ${o.rank} | ${o.hypothesis} | ${o.mirror ?? ""} | ${o.rightAircraft ?? ""} | ${o.evidence ?? ""} | ${o.score ?? ""} | ${o.confident} | ${o.cpu.toFixed(1)} | ${o.ms.total} (${o.ms.shape}, ${o.ms.smooth}, ${o.ms.scan}, ${o.ms.join}, ${o.ms.joint}, ${o.ms.fine}) | ${Math.round(o.bytes / 1000)} |`),
  ];
  writeFileSync(reportOf("singles"), lines.join("\n") + "\n");
  writeFileSync(reportOf("singles", "json"), JSON.stringify({ outcomes }, null, 1));
  console.log(lines.slice(0, 8 + SIDES.length * WINDOWS.length).join("\n"));
  expect(outcomes.length).toBeGreaterThan(0);
  // A flag raised must be right.
  expect(outcomes.filter((o) => o.confident && ((o.error ?? Infinity) > 1000 || Math.abs(o.timeError ?? Infinity) > 30)).length).toBe(0);
}, HOURS);

/**
 * Two flyovers at one spot, from real audio: two Livermore recordings made at the same site on the
 * same day, less than 30 minutes apart, read as one recording with a gap between them (silence
 * counts only in the two stretches). The truth is the site and the first one's start.
 */
it("where and when: two recordings at one spot", async () => {
  if (ONLY && !ONLY.includes("pairs")) return;
  const days = indexedDays();
  const heard = livermoreScenarios()
    .filter((s) => s.kind === "heard" && !s.id.includes("missing"))
    .sort((a, b) => a.recording.start - b.recording.start);
  const pairs: [(typeof heard)[number], (typeof heard)[number]][] = [];
  for (let i = 0; i + 1 < heard.length; i++) {
    const [a, b] = [heard[i], heard[i + 1]];
    const dayOf = (x: typeof a) => new Date(x.recording.start * 1000).toISOString().slice(0, 10);
    const gap = b.recording.start - (a.recording.start + a.recording.samples.length / a.recording.sampleRate);
    if (a.tags.site === b.tags.site && dayOf(a) === dayOf(b) && gap <= 1800 && days.has(dayOf(a))) pairs.push([a, b]);
  }
  const rows: string[] = [];
  const outcomes: { window: string; error: number | null; timeError: number | null; rank: number; confident: boolean; cpu: number; ms: number }[] = [];
  for (const side of SIDES) {
    const ground = await groundAround(BAY.lat, BAY.lon, side);
    for (const [a, b] of pairs) {
      const ra = a.recording;
      const rb = b.recording;
      const day = new Date(ra.start * 1000).toISOString().slice(0, 10);
      const { flights } = await historyAround([day], BAY.lat, BAY.lon, side);
      const sa = findSegments(ra.samples, ra.sampleRate);
      const sb = findSegments(rb.samples, rb.sampleRate);
      const off = rb.start - ra.start;
      const segments = [...sa.segments, ...sb.segments.map((g) => ({ ...g, offset: g.offset + off }))];
      const end = off + rb.samples.length / rb.sampleRate;
      const searched: [number, number][] = [[0, ra.samples.length / ra.sampleRate], [off, end]];
      const truth = ra.listener;
      for (const window of WINDOWS) {
        const [ww, cpu] = await cpuOf(() => whereWhen(segments, flights, { window: windowOf(window, ra.start, end), area: { ...BAY, side }, ground, air: ra.air, searched, probe: { lat: truth.lat, lon: truth.lon, start: ra.start } }));
        const best = ww.answers[0];
        const error = best ? Math.round(Math.hypot(...offsetOf(truth, best.lat, best.lon))) : null;
        const timeError = best ? Math.round((best.start - ra.start) * 10) / 10 : null;
        // The first answer within 250 m and 30 s of the truth, 0 if none.
        const rank = ww.answers.findIndex((x) => Math.hypot(...offsetOf(truth, x.lat, x.lon)) <= 250 && Math.abs(x.start - ra.start) <= 30) + 1;
        outcomes.push({ window, error, timeError, rank, confident: ww.confident, cpu, ms: ww.ms.total });
        const id = `${a.id.slice(4)} + ${b.id.slice(4)}`;
        log(`pair ${id} ${side / 1000} km ${window}: ${error} m, ${timeError} s, rank ${rank}, ${best?.atSea ? "at sea, " : ""}worth ${best?.worth.toFixed(1)} of ${ww.searched.toFixed(1)}, ${ww.confident ? "confident" : "unsure"}, ${ww.candidates} fits, ${cpu.toFixed(1)} s CPU, ${Math.round(process.memoryUsage().rss / 2 ** 20)} MB, probe ${JSON.stringify({ ...ww.probe, truth: undefined })}`);
        rows.push(`| ${id} | ${Math.round(off / 60)} | ${side / 1000} | ${window} | ${ww.traces} | ${ww.candidates} | ${error ?? "-"} | ${timeError ?? "-"} | ${rank} | ${best ? best.worth.toFixed(1) : "-"} of ${ww.searched.toFixed(1)} | ${[...new Set(best?.planes.map((p) => p.registration || p.hex))].join(", ") ?? ""} | ${ww.confident} | ${cpu.toFixed(1)} |`);
      }
    }
  }
  const part = (window: string) => {
    const xs = outcomes.filter((o) => o.window === window);
    const n = xs.length;
    const within = (m: number) => xs.filter((o) => (o.error ?? Infinity) <= m && Math.abs(o.timeError ?? Infinity) <= 30).length;
    const conf = xs.filter((o) => o.confident);
    const flagRight = xs.filter((o) => o.confident === ((o.error ?? Infinity) <= 1000 && Math.abs(o.timeError ?? Infinity) <= 30)).length;
    return `${window}: ${n} runs, median ${num(quantile(xs.map((o) => o.error ?? Infinity), 0.5))} m, time ${num(quantile(xs.map((o) => Math.abs(o.timeError ?? Infinity)), 0.5))} s; within 250 m ${pct(within(250), n)}, 1 km ${pct(within(1000), n)} (start within 30 s); truth among the answers ${pct(xs.filter((o) => o.rank > 0).length, n)}; confident ${conf.length}, of which right ${conf.filter((o) => (o.error ?? Infinity) <= 1000).length}; flag right ${pct(flagRight, n)}; median ${num(quantile(xs.map((o) => o.cpu), 0.5))} s CPU.`;
  };
  const lines = [
    "",
    "## Two recordings at one spot (Livermore, same site and day, under 30 minutes apart)",
    "",
    `${pairs.length} pairs.`,
    "",
    ...WINDOWS.flatMap((w) => [`- ${part(w)}`]),
    "",
    "| pair | minutes apart | square km | window | traces | fits | error m | time error s | truth's rank | worth of searched | planes | confident | CPU s |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ];
  writeFileSync(reportOf("pairs"), "# Eval where and when\n" + lines.join("\n") + "\n");
  const right = (o: (typeof outcomes)[number]) => (o.error ?? Infinity) <= 1000 && Math.abs(o.timeError ?? Infinity) <= 30;
  // A flag raised must be right. The rest is a ratchet.
  expect(outcomes.filter((o) => o.confident && !right(o)).length).toBe(0);
  if (ratcheted && floors) for (const w of WINDOWS) expect(outcomes.filter((o) => o.window === w && right(o)).length).toBeGreaterThanOrEqual(floors[`pairs-${w}-1km`] ?? 0);
}, HOURS);

/**
 * colsto's own recording (the "full recording" linked under his video, one hour,
 * 2026-09-08): `yt-dlp -x` of https://youtu.be/4CxVxuMVkMc into evals/.cache/colsto/, resampled
 * to 8 kHz mono as audio-8k.wav, with truth.json (the public reference coordinate and start
 * dopplerprint transcribed from the video). Never committed. Searched blind: traces found chunk
 * by chunk over the whole hour, the UTC day, a square centred off the truth. Then 16
 * minutes of it (the test on production that gave an answer at sea), and the hour with the water
 * brought to the truth: a recording from a boat stays first or second.
 */
it("where and when: colsto's recording", async () => {
  if (ONLY && !ONLY.includes("colsto")) return;
  const dir = new URL("./.cache/colsto/", import.meta.url);
  if (!existsSync(new URL("audio-8k.wav", dir)) || !existsSync(new URL("truth.json", dir)) || !indexedDays().has("2026-09-08")) return console.log("colsto: audio, truth or 2026-09-08 history missing");
  const truth = JSON.parse(readFileSync(new URL("truth.json", dir), "utf8")) as { lat: number; lon: number; start: number };
  const wav = decodeWav(new Uint8Array(readFileSync(new URL("audio-8k.wav", dir))));
  const rate = wav.sampleRate;
  const total = wav.samples.length / rate;
  const t0 = performance.now();
  const { segments } = findSegments(wav.samples, rate);
  const traceMs = Math.round(performance.now() - t0);
  const found = segments.flatMap((g) => g.traces.map((tr) => `${Math.round(g.offset + g.stack.base.times[tr.from])}-${Math.round(g.offset + g.stack.base.times[tr.to])} s ${Math.round(tr.freq[tr.from])}->${Math.round(tr.freq[tr.to])} Hz (${tr.confidence.toFixed(1)})`));
  log(`colsto: ${found.length} traces in ${traceMs} ms: ${found.join(", ")}`);
  const day = "2026-09-08";
  const LONG_ISLAND = { lat: 40.8, lon: -73.7 };
  const lines = ["", "## colsto's recording (2026-09-08, one hour)", "", `${found.length} traces found over the hour in ${traceMs} ms: ${found.join("; ")}.`, "", "| square | cut | window | flights | fits | error m | time error s | at sea | truth's rank | worth of searched | flyovers heard well | confident | planes | CPU s |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const side of SIDES) {
    const ground = await groundAround(LONG_ISLAND.lat, LONG_ISLAND.lon, side);
    const { flights } = await historyAround([day], LONG_ISLAND.lat, LONG_ISLAND.lon, side);
    // The hour as it is, 16 minutes from +9 min, and the hour with the sea around the truth.
    const cut = findSegments(wav.samples.subarray(540 * rate, 1500 * rate), rate).segments;
    const boat = (lat: number, lon: number) => (Math.hypot(...offsetOf(truth, lat, lon)) < 3000 ? 0 : ground(lat, lon));
    const runs = [
      ...WINDOWS.map((window) => ({ name: "the hour", window, segs: segments, here: truth, length: total, floor: ground })),
      ...WINDOWS.map((window) => ({ name: "16 min from +9 min", window, segs: cut, here: { ...truth, start: truth.start + 540 }, length: 960, floor: ground })),
      { name: "the hour from a boat", window: "hour" as const, segs: segments, here: truth, length: total, floor: boat },
    ];
    for (const { name, window, segs, here, length, floor } of runs) {
      const [ww, cpu] = await cpuOf(() => whereWhen(segs, flights, { window: windowOf(window, here.start, length), area: { ...LONG_ISLAND, side }, ground: floor, air: { groundTempC: 24 }, searched: [[0, length]], probe: here, onProgress: process.env.PROGRESS ? progress("colsto") : undefined }));
      const best = ww.answers[0];
      const error = best ? Math.round(Math.hypot(...offsetOf(here, best.lat, best.lon))) : null;
      const dt = best ? Math.round((best.start - here.start) * 10) / 10 : null;
      const rank = ww.answers.findIndex((a) => Math.hypot(...offsetOf(here, a.lat, a.lon)) <= 250 && Math.abs(a.start - here.start) <= 30) + 1;
      log(`colsto ${name} ${side / 1000} km ${window}: ${error} m, ${dt} s, rank ${rank}, ${best?.atSea ? "at sea, " : ""}worth ${best?.worth.toFixed(1)} of ${ww.searched.toFixed(1)}, ${ww.confident}, ${ww.candidates} fits, ${cpu.toFixed(1)} s CPU, ${Math.round(process.memoryUsage().rss / 2 ** 20)} MB, probe ${JSON.stringify({ ...ww.probe, truth: undefined })}`);
      for (const a of ww.answers) log(`  ${Math.round(Math.hypot(...offsetOf(here, a.lat, a.lon)))} m, ${Math.round(a.start - here.start)} s, ${a.atSea ? "at sea, " : ""}worth ${a.worth.toFixed(1)}, evidence ${a.evidence.toFixed(2)} (${a.wellHeard} well), score ${a.score.toFixed(1)}, ${[...new Set(a.planes.map((p) => `${p.hex} ${p.type}`))].join(" ")}, silent ${a.silent.length}`);
      if (ww.confident) expect(error ?? Infinity).toBeLessThanOrEqual(1000);
      if (ratcheted && name === "the hour" && floors?.[`colsto-${window}-metres`]) expect(error ?? Infinity).toBeLessThanOrEqual(floors[`colsto-${window}-metres`]);
      // Down, never out: the truth is on the water here, and it keeps its place near the top.
      if (floor === boat) {
        const kept = ww.answers.findIndex((a) => Math.hypot(...offsetOf(here, a.lat, a.lon)) <= 1000 && Math.abs(a.start - here.start) <= 30) + 1;
        expect(kept).toBeGreaterThan(0);
        expect(kept).toBeLessThanOrEqual(2);
        expect(ww.answers[kept - 1].atSea).toBe(true);
      }
      lines.push(`| ${side / 1000} km | ${name} | ${window} | ${ww.flights} | ${ww.candidates} | ${error ?? "-"} | ${dt ?? "-"} | ${best?.atSea ? "yes" : "no"} | ${rank} | ${best ? best.worth.toFixed(1) : "-"} of ${ww.searched.toFixed(1)} | ${best?.wellHeard ?? "-"} | ${ww.confident} | ${[...new Set(best?.planes.map((p) => `${p.hex} ${p.type}`))].join(", ") ?? ""} | ${cpu.toFixed(1)} |`);
    }
  }
  writeFileSync(reportOf("colsto"), "# Eval where and when\n" + lines.join("\n") + "\n");
}, HOURS);
