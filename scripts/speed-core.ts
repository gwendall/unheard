// What the analysis costs in Node, and whether a speed change moved its answers. CPU time, never
// wall time: the machine is shared, so a stage is measured several times and the lowest counts.
//
//   pnpm speed analyze [--clips 16] [--runs 3]    CPU per stage of analyze() on synthetic clips
//   pnpm speed tones <file.wav> [--runs 3]        findTones, as the check page's worker runs it
//   pnpm speed check <file.wav> [--rate 8000]     the whole check: find, take out, look again
//   pnpm speed where [--window hour|day]          whereWhen on colsto's hour (evals/.cache)
//   pnpm speed golden <out.json>                  every answer of the CI corpus, the check and where
//   pnpm speed compare <before.json> <after.json> what changed, and by how much
//   pnpm speed profile <file.cpuprofile> [--top 25] where the time went, by function
//
// A profile of any of them: node --cpu-prof --cpu-prof-dir=<dir> --import tsx scripts/speed-core.ts ...

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { decodeWav } from "../lib/bundle";
import { explainLines, ghostsOf, linesOf } from "../lib/core/explain";
import { chunksOf, cleanOut, findTones, readerOf, ridgesOf, type Tone } from "../lib/core/leak";
import { matchAll } from "../lib/core/match";
import { ANALYSIS_RATE, analyze, candidatesOf, type Recording } from "../lib/core/pipeline";
import { resample } from "../lib/core/resample";
import { buildStack } from "../lib/core/spectrogram";
import { findSegments, whereWhen, type WhereWhen } from "../lib/core/wherewhen";
import { groundAround, historyAround, indexedDays } from "../evals/lib/history";
import { syntheticScenario } from "../evals/lib/synthetic";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
const command = positional[0];
const runs = Number(flag("runs") ?? 3);

/** CPU seconds of this process, every thread (the collector's too), since `from`. */
const cpuSince = (from: NodeJS.CpuUsage) => {
  const used = process.cpuUsage(from);
  return (used.user + used.system) / 1e6;
};
const measure = async <T>(work: () => T | Promise<T>): Promise<[T, number]> => {
  const from = process.cpuUsage();
  const out = await work();
  return [out, cpuSince(from)];
};
const peakMB = () => Math.round(process.resourceUsage().maxRSS / 1024);
const fixed = (x: number, digits = 2) => x.toFixed(digits);

/** The evals' synthetic plan, heard and empty, every kind in proportion. */
function plan(heard: number) {
  return [
    ...Array.from({ length: heard }, (_, i) => ["heard", i] as const),
    ...Array.from({ length: Math.ceil(heard / 2) }, (_, i) => ["noise", 1000 + i] as const),
    ...Array.from({ length: Math.ceil(heard / 2) }, (_, i) => ["missing", 2000 + i] as const),
    ...Array.from({ length: Math.ceil(heard / 5) }, (_, i) => ["two", 3000 + i] as const),
  ];
}

// ---------------------------------------------------------------------------------------------
// analyze(), stage by stage: the same calls in the same order as lib/core/pipeline.ts.

async function benchAnalyze() {
  const clips = Number(flag("clips") ?? 16);
  const scenarios = plan(Math.ceil(clips / 2)).slice(0, clips).map(([kind, seed]) => syntheticScenario(seed, kind));
  const seconds = scenarios.reduce((sum, s) => sum + s.recording.samples.length / s.recording.sampleRate, 0);
  const stages = { stack: Infinity, matcher: Infinity, lines: Infinity, check: Infinity, total: Infinity };
  for (let run = 0; run < runs; run++) {
    const sum = { stack: 0, matcher: 0, lines: 0, check: 0, total: 0 };
    for (const { recording: rec } of scenarios) {
      const [stack, a] = await measure(() => buildStack(rec.samples, rec.sampleRate));
      const candidates = candidatesOf(rec.polls, rec.listener);
      const [first, b] = await measure(() => matchAll(stack, rec.start, candidates, rec.air));
      const [lines, c] = await measure(() => linesOf(stack));
      const [, d] = await measure(async () => {
        const out = await explainLines(stack, rec.start, candidates, rec.air, first.ranked, lines);
        ghostsOf(out.lines, stack.base.times, rec.air);
      });
      sum.stack += a;
      sum.matcher += b;
      sum.lines += c;
      sum.check += d;
      sum.total += a + b + c + d;
    }
    for (const k of Object.keys(sum) as (keyof typeof sum)[]) stages[k] = Math.min(stages[k], sum[k] / scenarios.length);
    console.log(`run ${run + 1}: per clip ${Object.entries(sum).map(([k, v]) => `${k} ${fixed(v / scenarios.length)}`).join(", ")} s CPU`);
  }
  console.log(JSON.stringify({ clips: scenarios.length, meanSeconds: Math.round(seconds / scenarios.length), cpu: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, Number(fixed(v, 3))])), peakMB: peakMB() }));
}

// ---------------------------------------------------------------------------------------------
// findTones, as the check page's worker runs it: every channel at the file's own rate.

const readWav = (path: string) => {
  const wav = decodeWav(new Uint8Array(readFileSync(path)));
  return { channels: [wav.samples], sampleRate: wav.sampleRate };
};

const toneOfGolden = (t: Tone): Record<string, unknown> => ({
  from: t.times[0],
  to: t.times[t.times.length - 1],
  frames: t.times.length,
  freqFirst: t.freq[0],
  freqLast: t.freq[t.freq.length - 1],
  freqSum: t.freq.reduce((a, b) => a + b, 0),
  confidence: t.confidence,
  beside: (t.beside ?? []).map(toneOfGolden),
});

async function benchTones() {
  const audio = readWav(positional[1]);
  const { read, length } = readerOf(audio);
  let best = Infinity;
  let tones = 0;
  for (let run = 0; run < runs; run++) {
    const [found, cpu] = await measure(() => findTones(read, chunksOf(length)));
    tones = found.length;
    best = Math.min(best, cpu);
    console.log(`run ${run + 1}: ${fixed(cpu)} s CPU, ${tones} tones`);
  }
  console.log(JSON.stringify({ file: positional[1], seconds: Math.round(length / ANALYSIS_RATE), cpu: Number(fixed(best, 3)), tones, peakMB: peakMB() }));
}

/**
 * The check as the page runs it, stage by stage: what the first search costs, what each round's
 * taking out and looking again cost, and how many curves and chunks each round handled. With
 * --rate, the file brought to that rate first, to see whether the cost follows it.
 */
async function benchCheck() {
  const file = readWav(positional[1]);
  const rate = Number(flag("rate") ?? file.sampleRate);
  const channels = rate === file.sampleRate ? file.channels : file.channels.map((c) => resample(c, file.sampleRate, rate));
  let best: Record<string, unknown> | null = null;
  let bestCpu = Infinity;
  for (let run = 0; run < runs; run++) {
    const audio = { channels: channels.map((c) => c.slice()), sampleRate: rate };
    const { read, length } = readerOf(audio);
    const from = process.cpuUsage();
    const tones = findTones(read, chunksOf(length));
    const find = cpuSince(from);
    const rounds: { curves: number; clean: number; again: number; chunks: number }[] = [];
    let mark = process.cpuUsage();
    let chunks = 0;
    const out = cleanOut(audio, tones, {
      onRound: (_, current) => {
        if (rounds.length) rounds[rounds.length - 1].again = cpuSince(mark);
        rounds.push({ curves: current.flatMap(ridgesOf).length, clean: 0, again: 0, chunks: 0 });
        mark = process.cpuUsage();
      },
      onWindow: (done, total) => {
        if (done < total) return;
        rounds[rounds.length - 1].clean = cpuSince(mark);
        mark = process.cpuUsage();
        chunks = 0;
      },
      find: { onChunk: (done, total) => void (chunks = total, done === total && rounds.length && (rounds[rounds.length - 1].chunks = chunks)) },
    });
    if (rounds.length) rounds[rounds.length - 1].again = cpuSince(mark);
    const total = cpuSince(from);
    const row = { find: Number(fixed(find)), clean: Number(fixed(rounds.reduce((a, r) => a + r.clean, 0))), again: Number(fixed(rounds.reduce((a, r) => a + r.again, 0))), total: Number(fixed(total)), curves: rounds.reduce((a, r) => a + r.curves, 0), rounds: rounds.map((r) => ({ ...r, clean: Number(fixed(r.clean)), again: Number(fixed(r.again)) })), cleaned: out.cleaned.length, left: out.left.length };
    console.log(`run ${run + 1}: ${JSON.stringify(row)}`);
    if (total < bestCpu) [best, bestCpu] = [row, total];
  }
  console.log(JSON.stringify({ file: positional[1].split("/").slice(-2).join("/"), rate, seconds: Math.round(channels[0].length / rate), channels: channels.length, ...best, peakMB: peakMB() }));
}

// ---------------------------------------------------------------------------------------------
// whereWhen on colsto's hour: the eval's own recording, square and history.

const COLSTO = { day: "2026-09-08", lat: 40.8, lon: -73.7, side: 100_000, air: { groundTempC: 24 } };
const colstoDir = new URL("../evals/.cache/colsto/", import.meta.url);
const hasColsto = () => existsSync(new URL("audio-8k.wav", colstoDir)) && existsSync(new URL("truth.json", colstoDir)) && indexedDays().has(COLSTO.day);

/** colsto's recording, its segments, and what the search reads. */
async function colstoInput(window: "hour" | "day") {
  const truth = JSON.parse(readFileSync(new URL("truth.json", colstoDir), "utf8")) as { lat: number; lon: number; start: number };
  const wav = decodeWav(new Uint8Array(readFileSync(new URL("audio-8k.wav", colstoDir))));
  const total = wav.samples.length / wav.sampleRate;
  const [{ segments }, traces] = await measure(() => findSegments(wav.samples, wav.sampleRate));
  const ground = await groundAround(COLSTO.lat, COLSTO.lon, COLSTO.side);
  const { flights } = await historyAround([COLSTO.day], COLSTO.lat, COLSTO.lon, COLSTO.side);
  const day = Math.floor(truth.start / 86_400) * 86_400;
  const span: [number, number] = window === "hour" ? [Math.floor(truth.start / 3600) * 3600, Math.floor(truth.start / 3600) * 3600 + 3600] : [day, day + 86_400 - total];
  return { segments, flights, traces, options: { window: span, area: { lat: COLSTO.lat, lon: COLSTO.lon, side: COLSTO.side }, ground, air: COLSTO.air, searched: [[0, total]] as [number, number][] } };
}

const whereGolden = (ww: WhereWhen) => ({
  confident: ww.confident,
  searched: ww.searched,
  traces: ww.traces,
  flights: ww.flights,
  candidates: ww.candidates,
  spots: ww.ms.spots,
  fits: ww.ms.fits,
  answers: ww.answers.map((a) => ({ lat: a.lat, lon: a.lon, start: a.start, score: a.score, evidence: a.evidence, worth: a.worth, wellHeard: a.wellHeard, silent: a.silent, planes: a.planes, mirror: a.mirror })),
  hypotheses: ww.hypotheses.map((h) => ({ lat: h.lat, lon: h.lon, start: h.start, loss: h.loss, hex: h.hex, trace: h.trace, evidence: h.evidence, worth: h.worth, silent: h.silent })),
});

async function benchWhere() {
  const window = (flag("window") ?? "hour") as "hour" | "day";
  if (!hasColsto()) throw new Error("colsto's recording or its day of history is missing from evals/.cache");
  const { segments, flights, traces, options } = await colstoInput(window);
  const stages = { traces, search: Infinity };
  let ms: WhereWhen["ms"] | null = null;
  for (let run = 0; run < runs; run++) {
    const [ww, cpu] = await measure(() => whereWhen(segments, flights, options));
    stages.search = Math.min(stages.search, cpu);
    ms = ww.ms;
    console.log(`run ${run + 1}: ${fixed(cpu)} s CPU, ${ww.answers.length} answers, ${ww.candidates} fits, stages (wall ms) ${JSON.stringify(ww.ms)}`);
  }
  console.log(JSON.stringify({ window, segments: segments.length, flights: flights.length, cpu: { traces: Number(fixed(stages.traces, 3)), search: Number(fixed(stages.search, 3)) }, ms, peakMB: peakMB() }));
}

// ---------------------------------------------------------------------------------------------
// The golden comparison.

const analysisGolden = async (id: string, rec: Recording) => {
  const a = await analyze(rec);
  return {
    id,
    seen: a.seen,
    kind: a.verdict.kind,
    ranked: a.verdict.ranked.map((m) => ({ id: m.id, score: m.score, f0: m.f0, clock: m.clock, borrowed: m.borrowed ?? null, closest: m.closest })),
    lines: a.lines.map((l) => ({ from: l.trace.from, to: l.trace.to, score: l.trace.score, confidence: l.trace.confidence, fall: l.trace.fall, by: l.by, borrowed: l.borrowed, shape: l.shape, beta: l.flyby.beta, T: l.flyby.T, t0: l.flyby.t0, share: l.flyby.share })),
    unexplained: a.unexplained.map((t) => [t.from, t.to]),
    ghosts: a.ghosts.map((g) => ({ from: g.from, to: g.to, hzFrom: g.hzFrom, hzTo: g.hzTo, speed: g.speed, distance: g.distance })),
  };
};

async function golden() {
  const out: Record<string, unknown> = {};
  const scenarios = plan(30).slice(0, Number(flag("first") ?? 1e9));
  const analyses: unknown[] = [];
  for (const [kind, seed] of scenarios) {
    const s = syntheticScenario(seed, kind);
    analyses.push(await analysisGolden(s.id, s.recording));
    console.log(`analyze ${s.id}`);
  }
  out.analyze = analyses;
  const flyby = new URL("../e2e/fixtures/flyby.wav", import.meta.url);
  if (existsSync(flyby)) {
    const { read, length } = readerOf(readWav(flyby.pathname));
    out.tones = findTones(read, chunksOf(length)).map(toneOfGolden);
    console.log("tones");
  }
  const real = flag("real");
  if (real) {
    const file = readWav(real);
    const audio = { channels: file.channels, sampleRate: file.sampleRate };
    const { read, length } = readerOf(audio);
    const tones = findTones(read, chunksOf(length));
    const rounds: number[] = [];
    const { cleaned, left } = cleanOut(audio, tones, { onRound: (_, current) => rounds.push(current.flatMap(ridgesOf).length) });
    const samples = audio.channels[0];
    let energy = 0;
    const every: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      energy += samples[i] * samples[i];
      if (i % 20_000 === 0) every.push(samples[i]);
    }
    out.real = { tones: tones.map(toneOfGolden), rounds, cleaned: cleaned.map(toneOfGolden), left: left.map(toneOfGolden), energy, every };
    console.log("real");
  }
  if (hasColsto() && !args.includes("--no-where")) {
    const { segments, flights, options } = await colstoInput("hour");
    out.where = whereGolden(await whereWhen(segments, flights, options));
    console.log("where");
  }
  writeFileSync(positional[1], JSON.stringify(out));
  console.log(`${positional[1]}: ${analyses.length} analyses, peak ${peakMB()} MB`);
}

/** Every difference between two golden files: numbers by how far, anything else exactly. */
function compare() {
  const [a, b] = [positional[1], positional[2]].map((p) => JSON.parse(readFileSync(p, "utf8")) as unknown);
  let numbers = 0;
  let worst = 0;
  let worstAt = "";
  const hard: string[] = [];
  const near: { at: string; a: number; b: number }[] = [];
  const walk = (x: unknown, y: unknown, at: string) => {
    if (typeof x === "number" && typeof y === "number") {
      numbers++;
      const d = Math.abs(x - y);
      if (d > 0) near.push({ at, a: x, b: y });
      if (d > worst) [worst, worstAt] = [d, at];
      return;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) hard.push(`${at}: ${x.length} items, then ${y.length}`);
      for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i], `${at}[${i}]`);
      return;
    }
    if (x && y && typeof x === "object" && typeof y === "object") {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${at}.${k}`);
      return;
    }
    if (x !== y) hard.push(`${at}: ${JSON.stringify(x)} then ${JSON.stringify(y)}`);
  };
  walk(a, b, "");
  for (const line of hard.slice(0, 40)) console.log(`DIFFERENT ${line}`);
  for (const n of near.sort((p, q) => Math.abs(q.a - q.b) - Math.abs(p.a - p.b)).slice(0, 10)) console.log(`moved ${n.at}: ${n.a} then ${n.b}`);
  console.log(`${numbers} numbers compared, ${near.length} moved, largest move ${worst}${worstAt ? ` at ${worstAt}` : ""}; ${hard.length} other differences`);
  process.exit(hard.length ? 1 : 0);
}

/** Self time per function of a V8 CPU profile, heaviest first. */
function profile() {
  type Node = { id: number; hitCount: number; callFrame: { functionName: string; url: string; lineNumber: number } };
  const p = JSON.parse(readFileSync(positional[1], "utf8")) as { nodes: Node[]; samples: number[]; timeDeltas: number[] };
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const self = new Map<string, number>();
  let total = 0;
  p.samples.forEach((id, i) => {
    const { functionName, url, lineNumber } = byId.get(id)!.callFrame;
    if (functionName === "(idle)") return;
    const key = `${functionName || "(anonymous)"} ${url.split("/").pop() ?? ""}:${lineNumber + 1}`;
    const dt = p.timeDeltas[i] / 1e6;
    self.set(key, (self.get(key) ?? 0) + dt);
    total += dt;
  });
  console.log(`${total.toFixed(2)} s of samples`);
  for (const [key, s] of [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(flag("top") ?? 25))) console.log(`${s.toFixed(2).padStart(8)} s ${((100 * s) / total).toFixed(1).padStart(5)} %  ${key}`);
}

const commands: Record<string, () => void | Promise<void>> = { analyze: benchAnalyze, tones: benchTones, check: benchCheck, where: benchWhere, golden, compare, profile };
if (!command || !commands[command]) {
  console.error("usage: pnpm speed analyze | tones <wav> | where | golden <out.json> | compare <a.json> <b.json>");
  process.exit(2);
}
await commands[command]();
