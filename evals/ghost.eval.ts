import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ghostLines } from "../lib/core/explain";
import { analyze } from "../lib/core/pipeline";
import { ghostCases, ghostReport, matchedCurve, oracleCurve, rowOf, summaryOf, type Row, type TruthCurve } from "./lib/ghost";
import { oracleZ } from "./lib/report";

// How far the lines no aircraft of the data explains can be believed: on recordings with nothing
// to find, how often the page would tell one; with the heard plane in the data, how often its own
// line stays unexplained; with that plane left out, how often the line told is its line.
// ONLY=synthetic,tracks,voice,ambient,real picks parts (default: all, what is not in the cache
// gives nothing); SEEDS=n widens the synthetic corpus, VOICES=n the voice notes. Rows land in
// evals/reports/ghost-<TAG>.jsonl (RESUME=1 skips the ids already there), the report in ghost.md.
// The ratchet is the "ghost" entry of evals/baseline.json on the default synthetic, track and voice
// corpora, "ghost-real" when real audio is in the cache.

const parts = new Set((process.env.ONLY ?? "synthetic,tracks,voice,ambient,real").split(","));
const SEEDS = Number(process.env.SEEDS ?? 30);
const VOICES = Number(process.env.VOICES ?? 30);
const PER_FILE = Number(process.env.PER_FILE ?? 40);
const TAG = process.env.TAG ?? "all";

it("ghost planes", async () => {
  const dir = new URL("./reports/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`ghost-${TAG}.jsonl`, dir);
  const rows: Row[] = [];
  if (process.env.RESUME && existsSync(file)) rows.push(...readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row));
  else writeFileSync(file, "");
  const done = new Set(rows.map((r) => r.id));
  const curves = new Map<string, TruthCurve | null>();
  const scores = new Map<string, number | null>();
  for (const c of ghostCases(parts, SEEDS, PER_FILE, VOICES)) {
    // A left-out run reads its heard run's curve: on a resume, the pairs are run again.
    if (done.has(c.id) && !c.target) continue;
    const t0 = performance.now();
    const a = await analyze(c.recording);
    const ms = performance.now() - t0;
    let truth: TruthCurve | null = c.scenario ? oracleCurve(c.scenario, a.spec.times) : null;
    if (c.target) {
      truth = matchedCurve(a, c.recording, c.target);
      curves.set(c.id, truth);
      scores.set(c.id, a.verdict.ranked.find((m) => m.id === c.target)?.score ?? null);
      if (done.has(c.id)) continue;
    }
    if (c.pairOf) truth = curves.get(c.pairOf) ?? null;
    const findable = c.scenario?.oracle ? oracleZ(a.stack, c.scenario) : c.target ? (scores.get(c.id) ?? null) : c.pairOf ? (scores.get(c.pairOf) ?? null) : null;
    const told = new Set(ghostLines(a.lines, a.spec.times, c.recording.air).map((g) => g.line));
    const row: Row = {
      id: c.id,
      corpus: c.corpus,
      group: c.group,
      seen: a.seen,
      verdict: a.verdict.kind,
      duration: c.recording.samples.length / c.recording.sampleRate,
      findable: findable === null ? null : Math.round(findable * 100) / 100,
      pass: truth?.pass ?? null,
      truthKnown: !!truth,
      lines: a.lines.map((l) => rowOf(a, c.recording, l, truth, told.has(l))),
      ms: Math.round(ms),
    };
    rows.push(row);
    appendFileSync(file, JSON.stringify(row) + "\n");
  }
  const summary = summaryOf(rows);
  writeFileSync(new URL("ghost.md", dir), ghostReport(rows, summary));
  console.log(JSON.stringify(summary.all));
  const baseline = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8")) as Record<string, Record<string, number>>;
  const wide = process.env.SEEDS !== undefined || process.env.VOICES !== undefined || process.env.PER_FILE !== undefined || process.env.ONLY !== undefined;
  const check = (name: string, s: { emptyRate: number; heardRate: number; leftRate: number }) => {
    const b = baseline[name];
    if (!b || wide) return;
    expect(s.emptyRate, `${name}: told with nothing to find`).toBeLessThanOrEqual(b.emptyMax);
    expect(s.heardRate, `${name}: told with the plane heard in the data`).toBeLessThanOrEqual(b.heardMax);
    expect(s.leftRate, `${name}: its line told with the plane left out`).toBeGreaterThanOrEqual(b.leftMin);
  };
  check("ghost", summary.generated);
  if (summary.real.left.n) check("ghost-real", summary.real);
});
