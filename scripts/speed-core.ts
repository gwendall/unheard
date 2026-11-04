// What the analysis costs in Node, and whether a speed change moved its answers. CPU time, never
// wall time: the machine is shared, so a stage is measured several times and the lowest counts.
//
//   pnpm speed analyze [--clips 16] [--runs 3]    CPU per stage of analyze() on synthetic clips
//   pnpm speed tones <file.wav> [--runs 3]        findTones, as the check page's worker runs it
//   pnpm speed check <file.wav> [--rate 8000] [--stereo] [--parts 5]  the whole check as the page's
//                                                 worker runs it, phase by phase, and cut for that many workers
//   pnpm speed where [--window hour|day]          whereWhen on colsto's hour (evals/.cache)
//   pnpm speed golden <out.json> [--real <wav>] [--parts 5]  every answer of the CI corpus, the check and where
//   pnpm speed compare <before.json> <after.json> what changed, and by how much
//   pnpm speed profile <file.cpuprofile> [--top 25] where the time went, by function
//
// A profile of any of them: node --cpu-prof --cpu-prof-dir=<dir> --import tsx scripts/speed-core.ts ...

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { decodeWav } from "../lib/bundle";
import { explainLines, ghostsOf, linesOf } from "../lib/core/explain";
import { chunksOf, cleanOut, curvesOf, findChunk, findTones, findTonesWith, inline, readerOf, takeOutOf, type Audio, type Pieces, type Tone } from "../lib/core/leak";
import { matchAll } from "../lib/core/match";
import { ANALYSIS_RATE, analyze, candidatesOf, type Recording } from "../lib/core/pipeline";
import { resample } from "../lib/core/resample";
import type { Curve } from "../lib/core/scrub";
import { memorySource, memoryStore, readInto, storedSound, takeOutOfFile } from "../lib/core/stream";
import { buildStack } from "../lib/core/spectrogram";
import { shapeOf } from "../lib/core/flyby";
import { scanPart } from "../lib/core/tracks";
import { findSegments, whereWhen, type WherePieces, type WhereWhen } from "../lib/core/wherewhen";
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

/** The check as the page's worker runs it: the file into a store, find, the rounds, then the file's own sound. */
async function checkAsThePage(file: Audio, pieces: Pieces, mark: (phase: string) => void = () => {}) {
  const source = memorySource(file);
  const store = memoryStore();
  mark("read");
  const { length } = await readInto(source, store);
  mark("find");
  const tones = await findTonesWith(pieces, store.read, chunksOf(length));
  const rounds: Curve[][] = [];
  const { cleaned } = await cleanOut(storedSound(store, length, ANALYSIS_RATE, pieces), tones, {
    pieces,
    onRound: (round, current) => {
      rounds.push(curvesOf(current));
      mark(`take out ${round}`);
    },
    onWindow: (done, total) => {
      if (done === total) mark(`look again ${rounds.length - 1}`);
    },
  });
  mark("write");
  const sound = createHash("sha256");
  const every: number[] = [];
  let energy = 0;
  let frames = 0;
  const left = await takeOutOfFile(source, rounds, store, length, (block) => {
    for (const ch of block) sound.update(new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength));
    for (let i = 0; i < block[0].length; i++, frames++) {
      energy += block[0][i] * block[0][i];
      if (frames % 20_000 === 0) every.push(block[0][i]);
    }
  }, { pieces, find: { onChunk: (done) => void (done === 0 && mark("look again last")) } });
  mark("end");
  return {
    tones: tones.map(toneOfGolden),
    rounds: rounds.map((r) => r.length),
    cleaned: cleaned.map(toneOfGolden),
    left: left.map(toneOfGolden),
    frames,
    energy,
    every,
    sound: sound.digest("hex"),
    store: createHash("sha256").update(new Uint8Array(store.read(0, length).buffer)).digest("hex"),
  };
}

/**
 * The check's pieces cut as the page's workers cut them, run here. With `shuffle`, those that could
 * run together do so back to front: their order must not matter.
 */
function checkParts(size: number, shuffle: boolean) {
  const costs: number[] = [];
  let asked = 0;
  const run = async <T>(work: () => T): Promise<T> => {
    if (shuffle) for (let wait = 2 * (size - asked++ % size); wait > 0; wait--) await null;
    const from = process.cpuUsage();
    const out = work();
    costs.push(cpuSince(from));
    return out;
  };
  const pieces: Pieces = {
    size,
    chunk: (samples, start, rate, options, onShare) => run(() => findChunk(samples, start, rate, options, onShare)),
    takeOut: (job, onShare) => run(() => takeOutOf(job, onShare)),
  };
  return { pieces, costs };
}

/** How long pieces take over `workers`, each to the first one free. */
function overWorkers(costs: number[], workers: number) {
  const free = new Array<number>(workers).fill(0);
  for (const cost of costs) free[free.indexOf(Math.min(...free))] += cost;
  return Math.max(0, ...free);
}

const bandOf = (file: { channels: Float32Array[]; sampleRate: number }): Audio => {
  const rate = Number(flag("rate") ?? file.sampleRate);
  const mono = rate === file.sampleRate ? file.channels : file.channels.map((c) => resample(c, file.sampleRate, rate));
  // Two channels that are not the same sound: each costs its own taking out.
  return { channels: args.includes("--stereo") ? [mono[0], Float32Array.from(mono[0], (x, i) => 0.5 * x + 0.5 * (mono[0][i + 1] ?? 0))] : mono, sampleRate: rate };
};

/** What each phase of the page's check costs, in one thread and cut for `--parts` workers. */
async function benchCheck() {
  const file = bandOf(readWav(positional[1]));
  const workers = Number(flag("parts") ?? 5);
  let best: Record<string, unknown> | null = null;
  let bestCpu = Infinity;
  for (let run = 0; run < runs; run++) {
    const { pieces, costs } = checkParts(workers, false);
    const phases: { phase: string; cpu: number; pieces: number[] }[] = [];
    const from = process.cpuUsage();
    let mark = process.cpuUsage();
    const close = () => {
      const last = phases.at(-1);
      if (last) {
        last.cpu = cpuSince(mark);
        last.pieces = costs.splice(0);
      }
      mark = process.cpuUsage();
    };
    const out = await checkAsThePage({ channels: file.channels.map((c) => c.slice()), sampleRate: file.sampleRate }, pieces, (phase) => {
      close();
      phases.push({ phase, cpu: 0, pieces: [] });
    });
    close();
    const total = cpuSince(from);
    // A phase's own work besides its pieces stays on the job's thread; its pieces go over the workers.
    const cut = phases.reduce((sum, p) => sum + Math.max(0, p.cpu - p.pieces.reduce((a, x) => a + x, 0)) + overWorkers(p.pieces, workers), 0);
    const row = {
      oneThread: Number(fixed(total)),
      overWorkers: Number(fixed(cut)),
      workers,
      phases: phases.filter((p) => p.cpu > 0.01).map((p) => `${p.phase} ${fixed(p.cpu)}${p.pieces.length ? ` (${p.pieces.length} pieces, slowest ${fixed(Math.max(...p.pieces))})` : ""}`),
      rounds: out.rounds,
      left: out.left.length,
    };
    console.log(`run ${run + 1}: ${row.oneThread} s`);
    if (total < bestCpu) [best, bestCpu] = [row, total];
  }
  console.log(JSON.stringify({ file: positional[1].split("/").slice(-2).join("/"), rate: file.sampleRate, channels: file.channels.length, seconds: Math.round(file.channels[0].length / file.sampleRate), ...best, peakMB: peakMB() }));
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

/**
 * The search cut as the page's workers cut it (`--parts <n>`), each part run here after the last:
 * what each costs, so what the slowest would cost on its own core, and the same answers.
 */
function partsRunner(size: number): { pieces: WherePieces; costs: { shapes: number[]; parts: number[] } } {
  const costs = { shapes: [] as number[], parts: [] as number[] };
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const out = turn.then(work);
    turn = out;
    return out;
  };
  return {
    costs,
    pieces: {
      size,
      shape: (t, y, c) =>
        inTurn(async () => {
          const [shape, cpu] = await measure(() => shapeOf(t, y, c));
          costs.shapes.push(cpu);
          return shape;
        }),
      part: (tones, paths, jets, options, longest, onShare) =>
        inTurn(async () => {
          const [part, cpu] = await measure(() => scanPart(tones, paths, jets, { ...options, onProgress: (done, total) => onShare(done / total) }, longest));
          costs.parts.push(cpu);
          return part;
        }),
    },
  };
}

async function benchWhere() {
  const window = (flag("window") ?? "hour") as "hour" | "day";
  if (!hasColsto()) throw new Error("colsto's recording or its day of history is missing from evals/.cache");
  const { segments, flights, traces, options } = await colstoInput(window);
  const stages = { traces, search: Infinity };
  let ms: WhereWhen["ms"] | null = null;
  for (let run = 0; run < runs; run++) {
    // CPU by stage, from the search's own progress: `ms` is wall time, and the machine is shared.
    const byStage: Record<string, number> = {};
    let stage = "";
    let mark = process.cpuUsage();
    const close = () => {
      const { user, system } = process.cpuUsage(mark);
      if (stage) byStage[stage] = Number(fixed((byStage[stage] ?? 0) + (user + system) / 1e6));
      mark = process.cpuUsage();
    };
    const cut = flag("parts") ? partsRunner(Number(flag("parts"))) : null;
    const [ww, cpu] = await measure(() => whereWhen(segments, flights, { ...options, pieces: cut?.pieces, onProgress: (s) => { if (s !== stage) { close(); stage = s; } } }));
    close();
    if (cut) console.log(`cut in ${cut.costs.parts.length}: parts ${cut.costs.parts.map((x) => fixed(x)).join(" ")} s, shapes ${fixed(cut.costs.shapes.reduce((a, x) => a + x, 0))} s in all`);
    stages.search = Math.min(stages.search, cpu);
    ms = ww.ms;
    console.log(`run ${run + 1}: ${fixed(cpu)} s CPU, ${ww.answers.length} answers, ${ww.candidates} fits, CPU by stage ${JSON.stringify(byStage)}, stages (wall ms) ${JSON.stringify(ww.ms)}`);
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
  const scenarios = args.includes("--where-only") ? [] : plan(30).slice(0, Number(flag("first") ?? 1e9));
  const analyses: unknown[] = [];
  for (const [kind, seed] of scenarios) {
    const s = syntheticScenario(seed, kind);
    analyses.push(await analysisGolden(s.id, s.recording));
    console.log(`analyze ${s.id}`);
  }
  out.analyze = analyses;
  const flyby = new URL("../e2e/fixtures/flyby.wav", import.meta.url);
  if (existsSync(flyby) && !args.includes("--where-only")) {
    const { read, length } = readerOf(readWav(flyby.pathname));
    out.tones = findTones(read, chunksOf(length)).map(toneOfGolden);
    console.log("tones");
  }
  const real = flag("real");
  if (real) {
    const parts = flag("parts");
    out.real = await checkAsThePage(bandOf(readWav(real)), parts ? checkParts(Number(parts), true).pieces : inline);
    console.log("real");
  }
  if (hasColsto() && !args.includes("--no-where")) {
    const { segments, flights, options } = await colstoInput("hour");
    out.where = whereGolden(await whereWhen(segments, flights, { ...options, pieces: flag("parts") ? partsRunner(Number(flag("parts"))).pieces : undefined }));
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
