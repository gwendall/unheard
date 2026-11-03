// The check page (app/[lang]/check): does a recording give away where it was made, and once its
// tones are taken out, does it still? For every recording, the page's own path with no flight
// data (lib/core/stream.ts: the sound read into a store at the analysis rate, findTones chunk by
// chunk and the rounds on that store, then the rounds' curves out of the sound at its own rate,
// block by block), then analyze() with the flight data, before and after: a recording whose tones
// were found and taken out must no longer be named, strong or possible.

import { mkdirSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { analyze, ANALYSIS_RATE } from "../lib/core/pipeline";
import { chunksOf, cleanOut, curvesOf, findTones, readerOf, ROUNDS, type Audio } from "../lib/core/leak";
import type { Curve } from "../lib/core/scrub";
import { memorySource, memoryStore, readInto, storedSound, takeOutOfFile } from "../lib/core/stream";
import { aerosonicScenarios, livermoreScenarios } from "./lib/real";
import type { Scenario } from "./lib/sim";
import { rate } from "./lib/stats";
import { syntheticScenario } from "./lib/synthetic";

const N = Number(process.env.SEEDS ?? 30);

type Named = { kind: "strong" | "possible" | "none"; id: string | null; score: number };
type Outcome = { id: string; kind: string; real: boolean; heard: boolean; tones: number; confidences: number[]; cleaned: number; before: Named; after: Named | null; left: number | null; leftConfidences: number[]; ms: number };

async function named(s: Scenario, samples: Float32Array): Promise<Named> {
  const { verdict } = await analyze({ ...s.recording, samples });
  return { kind: verdict.kind, id: verdict.kind === "none" ? null : (verdict.best?.id ?? null), score: verdict.best?.score ?? 0 };
}

function tonesOf(audio: Audio) {
  const { read, length } = readerOf(audio);
  return findTones(read, chunksOf(length));
}

async function run(s: Scenario): Promise<Outcome> {
  const real = s.id.startsWith("asdb") || s.id.startsWith("lvk");
  const audio: Audio = s.native ? { channels: [s.native.samples.slice()], sampleRate: s.native.sampleRate } : { channels: [s.recording.samples.slice()], sampleRate: s.recording.sampleRate };
  const before = await named(s, s.recording.samples);
  const t0 = performance.now();
  const source = memorySource(audio);
  const store = memoryStore();
  const { length: stored } = await readInto(source, store);
  const tones = findTones(store.read, chunksOf(stored));
  let after: Named | null = null;
  let left: number[] | null = null;
  let cleaned = 0;
  if (tones.length) {
    // What "Take them out" does: rounds of take out and look again on the store, then their curves
    // out of the sound at its own rate, which is what comes out of the page.
    const rounds: Curve[][] = [];
    const out = cleanOut(storedSound(store, stored), tones, { onRound: (_, found) => rounds.push(curvesOf(found)) });
    cleaned = out.cleaned.length;
    const blocks: Float32Array[] = [];
    await takeOutOfFile(source, rounds, store, stored, (block) => void blocks.push(block[0].slice()));
    const whole = new Float32Array(blocks.reduce((n, b) => n + b.length, 0));
    blocks.reduce((at, b) => (whole.set(b, at), at + b.length), 0);
    const result: Audio = { channels: [whole], sampleRate: audio.sampleRate };
    const { read, length } = readerOf(result, ANALYSIS_RATE);
    after = await named(s, read(0, length));
    // What is left, searched over the whole file.
    left = tonesOf(result).map((t) => Math.round(t.confidence * 10) / 10);
  }
  const ms = Math.round(performance.now() - t0);
  const round = (xs: { confidence: number }[]) => xs.map((t) => Math.round(t.confidence * 10) / 10);
  return { id: s.id, kind: s.kind, real, heard: real || !!s.oracle, tones: tones.length, confidences: round(tones), cleaned, before, after, left: left?.length ?? null, leftConfidences: left ?? [], ms };
}

const show = (n: Named | null) => (n === null ? "" : n.kind === "none" ? `none (${n.score.toFixed(1)})` : `${n.kind} ${n.id} (${n.score.toFixed(1)})`);

/** The corpus's report (evals/reports/leak-<name>.md and .json), and its summary. */
function report(name: string, title: string, outcomes: Outcome[]) {
  const count = (xs: Outcome[], f: (o: Outcome) => boolean) => xs.filter(f).length;
  const isNamed = (n: Named | null) => !!n && n.kind !== "none";
  const traced = outcomes.filter((o) => o.tones > 0);
  const summary = {
    n: outcomes.length,
    traced: traced.length,
    namedBefore: count(traced, (o) => isNamed(o.before)),
    namedAfter: count(traced, (o) => isNamed(o.after)),
    strongAfter: count(traced, (o) => o.after?.kind === "strong"),
    tonesLeft: count(traced, (o) => (o.left ?? 0) > 0),
    // Named from the flight data, but the check found no tone: what it says "no tone found" to.
    namedUntraced: count(outcomes, (o) => o.tones === 0 && isNamed(o.before)),
    untraced: outcomes.length - traced.length,
  };
  const group = (label: string, xs: Outcome[]) => {
    const t = xs.filter((o) => o.tones > 0);
    return `| ${label} | ${xs.length} | ${t.length} | ${count(t, (o) => isNamed(o.before))} | ${count(t, (o) => isNamed(o.after))} | ${count(t, (o) => (o.left ?? 0) > 0)} | ${count(xs, (o) => o.tones === 0 && isNamed(o.before))} |`;
  };
  const kinds = [...new Set(outcomes.map((o) => o.kind))];
  const lines = [
    `# Eval leak, ${title}`,
    "",
    `${new Date().toISOString()}, ${outcomes.length} recordings, median ${[...outcomes.map((o) => o.ms)].sort((a, b) => a - b)[outcomes.length >> 1]} ms per check (find, take out, look again).`,
    `- The check page's path with no flight data: tones found chunk by chunk (lib/core/leak.ts: 40 to 400 Hz, each ridge whole; the lines up to 3.4 kHz in a chunk that holds one go out with them), each taken out along its curve (scrub, the band filled with noise) on a copy at the analysis rate, the changed chunks searched again and what they show taken out too, up to ${ROUNDS} rounds, then every curve out of the sound at its own rate, block by block. Tones left: the whole of that sound searched once more.`,
    "- Named: analyze() with the flight data says strong or possible (any aircraft). Must be 0 after cleaning.",
    "- Named without a tone: the flight data names an aircraft, but the check found no tone to take out: what \"no aircraft tone found\" can miss.",
    "",
    "| | recordings | tones found | named before | named after | tones left | named without a tone |",
    "|---|---|---|---|---|---|---|",
    ...kinds.map((k) => group(k, outcomes.filter((o) => o.kind === k))),
    "",
    `Named after cleaning, of recordings with a tone: ${rate(summary.namedAfter, summary.traced)}.`,
    "",
    "| id | tones | confidence | taken out | before | after | left (confidence) | ms |",
    "|---|---|---|---|---|---|---|---|",
    ...outcomes.map((o) => `| ${o.id} | ${o.tones} | ${o.confidences.join(", ")} | ${o.tones ? o.cleaned : ""} | ${show(o.before)} | ${show(o.after)} | ${o.left === null ? "" : `${o.left}${o.left ? ` (${o.leftConfidences.join(", ")})` : ""}`} | ${o.ms} |`),
  ];
  const dir = new URL("./reports/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(`leak-${name}.md`, dir), lines.join("\n") + "\n");
  writeFileSync(new URL(`leak-${name}.json`, dir), JSON.stringify({ summary, outcomes }, null, 2));
  console.log(name, JSON.stringify(summary));
  return summary;
}

async function check(name: string, title: string, scenarios: Scenario[]) {
  if (!scenarios.length) {
    console.warn(`leak ${name}: no recordings (see evals/DATASETS.md)`);
    return;
  }
  const outcomes: Outcome[] = [];
  for (const s of scenarios) outcomes.push(await run(s));
  // Once its tones are out, a recording the check found them in is named by nobody.
  expect(report(name, title, outcomes).namedAfter).toBe(0);
}

// One test per corpus, each with its own report: `pnpm eval evals/leak -t livermore` runs one.
// Each with two hours: on a loaded Mac the 9 AeroSonicDB clips took 28 minutes.
const BUDGET = { timeout: 7_200_000 };

it("synthetic", BUDGET, async () => {
  const plan: [Scenario["kind"], number, number][] = [["heard", 0, N], ["noise", 1000, N], ["missing", 2000, Math.ceil(N / 2)], ["two", 3000, Math.ceil(N / 5)]];
  await check("synthetic", `synthetic (SEEDS=${N})`, plan.flatMap(([kind, base, n]) => Array.from({ length: n }, (_, i) => syntheticScenario(base + i, kind))));
});

it("aerosonic", BUDGET, async () => {
  await check("aerosonic", "AeroSonicDB (Adelaide, 60 s clips at 22 kHz)", aerosonicScenarios().filter((x) => !x.id.startsWith("asdb-missing")));
});

// 40 phone recordings at 48 kHz, cleaned at that rate: the longest corpus.
it("livermore", BUDGET, async () => {
  await check("livermore", "phones at Livermore (48 kHz, 41 to 182 s)", livermoreScenarios().filter((x) => !x.id.startsWith("lvk-missing")));
});
