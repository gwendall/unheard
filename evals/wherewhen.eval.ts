// Where and when (lib/core/wherewhen.ts): the Livermore phone recordings searched blind, with
// only their UTC day and a square of the Bay Area (100 km, then 300 km), against a day of
// adsb.lol history (scripts/history-index.ts). How far the best spot lands from the truth, how
// far its start time, and how often the confidence flag is right.
//
//   SIDES=100000,300000 ONLY=lvk-N86LP_R01 pnpm eval evals/wherewhen
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
/** Each part writes its own report (the parts can run at once): evals/reports/wherewhen-<part>-<km>.md. */
const reportOf = (part: string, ext = "md") => new URL(`./reports/wherewhen-${part}-${SIDES.map((x) => x / 1000).join("-")}.${ext}`, import.meta.url);
/** The Bay Area: the squares are centred on Oakland, not on the recordings (about 40 km east). */
const BAY = { lat: 37.75, lon: -122.2 };

type Outcome = {
  id: string;
  side: number;
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
      const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
      const { flights, bytes } = await historyAround([day], BAY.lat, BAY.lon, side);
      const { segments, searched } = findSegments(s.recording.samples, s.recording.sampleRate);
      const duration = s.recording.samples.length / s.recording.sampleRate;
      const ww = await whereWhen(segments, flights, { window: [dayStart, dayStart + 86_400 - duration], area: { ...BAY, side }, ground, air: s.recording.air, searched, probe: { lat: truth.lat, lon: truth.lon, start: s.recording.start }, onProgress: process.env.PROGRESS ? progress(s.id) : undefined });
      const best = ww.answers[0] ?? null;
      const dist = (p: { lat: number; lon: number }) => Math.hypot(...offsetOf(truth, p.lat, p.lon));
      const answers = [s.truth.heard, ...(s.truth.alsoHeard ?? [])];
      const o: Outcome = {
        id: s.id,
        side,
        traces: ww.traces,
        flights: ww.flights,
        candidates: ww.candidates,
        error: best ? Math.round(dist(best)) : null,
        timeError: best ? Math.round((best.start - s.recording.start) * 10) / 10 : null,
        rank: ww.answers.findIndex((a) => dist(a) <= 250 && Math.abs(a.start - s.recording.start) <= 30) + 1,
        hypothesis: ww.hypotheses.findIndex((h) => dist(h) <= 500 && Math.abs(h.start - s.recording.start) <= 30) + 1,
        mirror: best?.mirror ? Math.round(dist(best.mirror)) : null,
        rightAircraft: best ? best.planes.some((p) => answers.includes(p.hex)) : null,
        score: best ? Math.round(best.score * 10) / 10 : null,
        evidence: best ? Math.round(best.evidence * 100) / 100 : null,
        confident: ww.confident,
        ms: ww.ms,
        bytes,
        probe: ww.probe,
        flybys: ww.flybys,
      };
      outcomes.push(o);
      for (const h of ww.flybys) log(`  trace ${Math.round(h.from)}-${Math.round(h.to)} s, closest at ${Math.round(h.closest)} s, ${Math.round(h.f0)} Hz, ${h.speeds.join("-")} m/s, ${h.distances.join("-")} m, ${h.candidates} candidates`);
      log(`${o.id} ${side / 1000} km: ${o.error ?? "-"} m, ${o.timeError ?? "-"} s, rank ${o.rank}, hyp ${o.hypothesis}, evidence ${o.evidence}, score ${o.score}, ${o.confident ? "confident" : "unsure"}, ${ww.candidates} candidates, ${ww.flights} flights, ${ww.ms.total} ms, probe ${JSON.stringify(ww.probe)}`);
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
    return `| ${name} | ${n} | ${num(quantile(errors, 0.5))} | ${num(quantile(errors, 0.9))} | ${pct(within(100), n)} | ${pct(within(500), n)} | ${pct(within(1000), n)} | ${num(quantile(times, 0.5))} | ${pct(xs.filter((o) => o.rank > 0).length, n)} | ${pct(xs.filter((o) => o.hypothesis > 0).length, n)} | ${pct(xs.filter((o) => o.rightAircraft).length, n)} | ${conf.length ? `${confRight} of ${conf.length}` : "0"} | ${pct(confRight + unsureWrong, n)} | ${num(quantile(ms, 0.5))} / ${num(quantile(ms, 0.9))} |`;
  };
  const lines = [
    "# Eval where and when",
    "",
    `${new Date().toISOString()}, ${outcomes.length} runs: the Livermore phone recordings (Pathak 2026, CC BY 4.0) searched with only their UTC day and a square of the Bay Area centred on Oakland, against that day of adsb.lol history (ODbL 1.0, © adsb.lol contributors).`,
    "- Error: metres from the best answer to the microphone; within N m counts only answers whose start is also within 30 s. Time: |start error|, seconds.",
    "- Truth in answers: an answer within 250 m and 30 s. Truth in hypotheses: one of the 50 best spots and times before the fine search within 500 m and 30 s.",
    "- Flag right: confident and within 1 km, or unsure and not. Time: wall time of the search in Node on the founder's Mac (shared, heavily loaded), the spectrogram and traces left out.",
    "",
    "| square | n | median m | p90 m | <= 100 m | <= 500 m | <= 1 km | time s p50 | truth in answers | truth in hypotheses | right aircraft | confident and right | flag right | ms p50 / p90 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...SIDES.map((side) => row(`${side / 1000} km`, outcomes.filter((o) => o.side === side))),
    "",
    "| id | square km | traces | flights | candidates | error m | time s | rank | hypothesis | mirror m | right aircraft | evidence | score | confident | ms (shape, smooth, candidates, coarse, joint, fine) | tiles kB |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...outcomes.map((o) => `| ${o.id} | ${o.side / 1000} | ${o.traces} | ${o.flights} | ${o.candidates} | ${o.error ?? ""} | ${o.timeError ?? ""} | ${o.rank} | ${o.hypothesis} | ${o.mirror ?? ""} | ${o.rightAircraft ?? ""} | ${o.evidence ?? ""} | ${o.score ?? ""} | ${o.confident} | ${o.ms.total} (${o.ms.shape}, ${o.ms.smooth}, ${o.ms.candidates}, ${o.ms.coarse}, ${o.ms.joint}, ${o.ms.fine}) | ${Math.round(o.bytes / 1000)} |`),
  ];
  writeFileSync(reportOf("singles"), lines.join("\n") + "\n");
  writeFileSync(reportOf("singles", "json"), JSON.stringify({ outcomes }, null, 1));
  console.log(lines.slice(0, 10 + SIDES.length).join("\n"));
  expect(outcomes.length).toBeGreaterThan(0);
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
  const outcomes: { error: number | null; timeError: number | null; rank: number; confident: boolean; ms: number }[] = [];
  for (const side of SIDES) {
    const ground = await groundAround(BAY.lat, BAY.lon, side);
    for (const [a, b] of pairs) {
      const ra = a.recording;
      const rb = b.recording;
      const day = new Date(ra.start * 1000).toISOString().slice(0, 10);
      const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
      const { flights } = await historyAround([day], BAY.lat, BAY.lon, side);
      const sa = findSegments(ra.samples, ra.sampleRate);
      const sb = findSegments(rb.samples, rb.sampleRate);
      const off = rb.start - ra.start;
      const segments = [...sa.segments, ...sb.segments.map((g) => ({ ...g, offset: g.offset + off }))];
      const end = off + rb.samples.length / rb.sampleRate;
      const searched: [number, number][] = [[0, ra.samples.length / ra.sampleRate], [off, end]];
      const truth = ra.listener;
      const ww = await whereWhen(segments, flights, { window: [dayStart, dayStart + 86_400 - end], area: { ...BAY, side }, ground, air: ra.air, searched, probe: { lat: truth.lat, lon: truth.lon, start: ra.start } });
      const best = ww.answers[0];
      const error = best ? Math.round(Math.hypot(...offsetOf(truth, best.lat, best.lon))) : null;
      const timeError = best ? Math.round((best.start - ra.start) * 10) / 10 : null;
      // The first answer within 250 m and 30 s of the truth, 0 if none.
      const rank = ww.answers.findIndex((x) => Math.hypot(...offsetOf(truth, x.lat, x.lon)) <= 250 && Math.abs(x.start - ra.start) <= 30) + 1;
      outcomes.push({ error, timeError, rank, confident: ww.confident, ms: ww.ms.total });
      const id = `${a.id.slice(4)} + ${b.id.slice(4)}`;
      log(`pair ${id} ${side / 1000} km: ${error} m, ${timeError} s, rank ${rank}, ${ww.confident ? "confident" : "unsure"}, ${ww.candidates} candidates, ${ww.ms.total} ms, probe ${JSON.stringify(ww.probe)}`);
      rows.push(`| ${id} | ${Math.round(off / 60)} | ${side / 1000} | ${ww.traces} | ${ww.candidates} | ${error ?? "-"} | ${timeError ?? "-"} | ${rank} | ${best ? best.evidence.toFixed(2) : "-"} | ${[...new Set(best?.planes.map((p) => p.registration || p.hex))].join(", ") ?? ""} | ${ww.confident} | ${ww.ms.total} |`);
    }
  }
  const n = outcomes.length;
  const within = (m: number) => outcomes.filter((o) => (o.error ?? Infinity) <= m && Math.abs(o.timeError ?? Infinity) <= 30).length;
  const conf = outcomes.filter((o) => o.confident);
  const flagRight = outcomes.filter((o) => o.confident === ((o.error ?? Infinity) <= 1000 && Math.abs(o.timeError ?? Infinity) <= 30)).length;
  const lines = [
    "",
    "## Two recordings at one spot (Livermore, same site and day, under 30 minutes apart)",
    "",
    `${pairs.length} pairs, ${n} runs: within 100 m ${pct(within(100), n)}, 500 m ${pct(within(500), n)}, 1 km ${pct(within(1000), n)} (start within 30 s); truth among the answers ${pct(outcomes.filter((o) => o.rank > 0).length, n)}; confident ${conf.length}, of which right ${conf.filter((o) => (o.error ?? Infinity) <= 1000).length}; flag right ${pct(flagRight, n)}; median ${num(quantile(outcomes.map((o) => o.ms), 0.5))} ms.`,
    "",
    "| pair | minutes apart | square km | traces | candidates | error m | time error s | truth's rank | evidence | planes | confident | ms |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ];
  writeFileSync(reportOf("pairs"), "# Eval where and when\n" + lines.join("\n") + "\n");
}, HOURS);

/**
 * colsto's own recording (the "full recording" linked under his video, one hour, Oyster Bay, NY,
 * 2026-09-08): `yt-dlp -x` of https://youtu.be/4CxVxuMVkMc into evals/.cache/colsto/, resampled
 * to 8 kHz mono as audio-8k.wav, with truth.json (the public reference coordinate and start
 * dopplerprint transcribed from the video). Never committed. Searched blind: traces found chunk
 * by chunk over the whole hour, the UTC day, a square of Long Island centred off the truth.
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
  const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
  const LONG_ISLAND = { lat: 40.8, lon: -73.7 };
  const lines = ["", "## colsto's recording (Oyster Bay, NY, 2026-09-08, one hour)", "", `${found.length} traces found over the hour in ${traceMs} ms: ${found.join("; ")}.`, "", "| square | flights | candidates | error m | time error s | evidence | flyovers heard well | confident | planes | ms |", "|---|---|---|---|---|---|---|---|---|---|"];
  for (const side of SIDES) {
    const ground = await groundAround(LONG_ISLAND.lat, LONG_ISLAND.lon, side);
    const { flights } = await historyAround([day], LONG_ISLAND.lat, LONG_ISLAND.lon, side);
    const ww = await whereWhen(segments, flights, { window: [dayStart, dayStart + 86_400 - total], area: { ...LONG_ISLAND, side }, ground, air: { groundTempC: 24 }, searched: [[0, total]], probe: truth, onProgress: process.env.PROGRESS ? progress("colsto") : undefined });
    const best = ww.answers[0];
    const error = best ? Math.round(Math.hypot(...offsetOf(truth, best.lat, best.lon))) : null;
    const dt = best ? Math.round((best.start - truth.start) * 10) / 10 : null;
    log(`colsto ${side / 1000} km: ${error} m, ${dt} s, evidence ${best?.evidence.toFixed(2)}, ${ww.confident}, ${ww.candidates} candidates, probe ${JSON.stringify(ww.probe)}, ${ww.ms.total} ms`);
    for (const a of ww.answers) log(`  ${Math.round(Math.hypot(...offsetOf(truth, a.lat, a.lon)))} m, ${Math.round(a.start - truth.start)} s, evidence ${a.evidence.toFixed(2)} (${a.wellHeard} well), score ${a.score.toFixed(1)}, ${[...new Set(a.planes.map((p) => `${p.hex} ${p.type}`))].join(" ")}, silent ${a.silent.length}`);
    lines.push(`| ${side / 1000} km | ${ww.flights} | ${ww.candidates} | ${error ?? "-"} | ${dt ?? "-"} | ${best ? best.evidence.toFixed(2) : "-"} | ${best?.wellHeard ?? "-"} | ${ww.confident} | ${[...new Set(best?.planes.map((p) => `${p.hex} ${p.type}`))].join(", ") ?? ""} | ${ww.ms.total} |`);
  }
  writeFileSync(reportOf("colsto"), "# Eval where and when\n" + lines.join("\n") + "\n");
}, HOURS);
