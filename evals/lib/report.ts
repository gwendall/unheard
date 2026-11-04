// Runs scenarios through the production analyze(), scores the answers, writes a report and
// checks it against the committed baseline (a ratchet: an eval fails when a metric gets worse).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { heardAt } from "../../lib/core/doppler";
import { curveScore, STRONG } from "../../lib/core/match";
import { analyze, type AnalysisOptions } from "../../lib/core/pipeline";
import type { Stack } from "../../lib/core/spectrogram";
import type { Scenario } from "./sim";

export type Outcome = {
  id: string;
  kind: Scenario["kind"];
  verdict: "strong" | "possible" | "none";
  answer: string | null;
  score: number | null;
  /** Best score minus the second best. */
  lead: number | null;
  /** The best match's closest range in the recording, metres. */
  closest: number | null;
  /** For heard scenarios: did the best match name the right aircraft? */
  correct: boolean | null;
  f0Error: number | null;
  clockError: number | null;
  candidates: number;
  /** How findable the sound was with a perfect model (true track, air and tone): its curve's
   * evidence over the spread of wrong tones on the same curve. Null when nothing was heard. */
  oracle: number | null;
  ms: number;
  tags: Record<string, string | number>;
};

export async function run(s: Scenario, options?: AnalysisOptions): Promise<Outcome> {
  const t0 = performance.now();
  const a = await analyze(s.recording, options);
  const ms = performance.now() - t0;
  const best = a.verdict.best;
  const answers = [s.truth.heard, ...(s.truth.alsoHeard ?? [])].filter(Boolean);
  return {
    id: s.id,
    kind: s.kind,
    verdict: a.verdict.kind,
    answer: best?.id ?? null,
    score: best ? round(best.score) : null,
    lead: best ? round(best.score - (a.verdict.ranked[1]?.score ?? 0)) : null,
    closest: best?.closest ? Math.round(best.closest.range) : null,
    correct: s.truth.heard ? answers.includes(best?.id ?? "") : null,
    f0Error: best && s.truth.f0 && best.id === s.truth.heard ? round(best.f0 - s.truth.f0) : null,
    clockError: best && s.truth.clock !== undefined && best.id === s.truth.heard ? round(best.clock - s.truth.clock) : null,
    candidates: a.seen,
    oracle: s.oracle ? round(oracleZ(a.stack, s)) : null,
    ms: Math.round(ms),
    tags: s.tags,
  };
}

const round = (x: number) => Math.round(x * 100) / 100;

/** How findable the heard sound was: its true curve's evidence over wrong tones on that curve. */
export function oracleZ(stack: Stack, s: Scenario): number {
  const o = s.oracle!;
  const factor = Array.from(stack.base.times, (t) => heardAt(o.truth, o.start + t, o.air)?.factor ?? NaN);
  const weights = o.harmonics.map((h) => h / Math.max(...o.harmonics));
  const right = curveScore(stack, factor, o.f0, weights);
  const wrong: number[] = [];
  for (let f = 40; f <= 500; f += 3.7) if (Math.abs(f - o.f0) > 5 && Math.abs(f - 2 * o.f0) > 5 && Math.abs(f - o.f0 / 2) > 5) wrong.push(curveScore(stack, factor, f, weights));
  const mean = wrong.reduce((a, b) => a + b, 0) / wrong.length;
  const sd = Math.sqrt(wrong.reduce((a, b) => a + (b - mean) ** 2, 0) / wrong.length) || 1;
  return (right - mean) / sd;
}

export type Summary = {
  heard: { n: number; strongHit: number; anyHit: number; wrongStrong: number; wrongPossible: number };
  empty: { n: number; falseStrong: number; falsePossible: number };
  msMedian: number;
};

const share = (k: number, n: number) => (n ? round(k / n) : 0);

/** What an eval found, as counts: the source of the scoreboard (evals/results.json). */
export type Counts = {
  heard: { n: number; strongHit: number; anyHit: number; wrongStrong: number; wrongPossible: number };
  empty: { n: number; falseStrong: number; falsePossible: number };
};

export function countsOf(outcomes: Outcome[]): Counts {
  const heard = outcomes.filter((o) => o.correct !== null);
  const empty = outcomes.filter((o) => o.correct === null);
  return {
    heard: {
      n: heard.length,
      strongHit: heard.filter((o) => o.verdict === "strong" && o.correct).length,
      anyHit: heard.filter((o) => o.verdict !== "none" && o.correct).length,
      wrongStrong: heard.filter((o) => o.verdict === "strong" && !o.correct).length,
      wrongPossible: heard.filter((o) => o.verdict === "possible" && !o.correct).length,
    },
    empty: {
      n: empty.length,
      falseStrong: empty.filter((o) => o.verdict === "strong").length,
      falsePossible: empty.filter((o) => o.verdict === "possible").length,
    },
  };
}

export function summarize(outcomes: Outcome[]): Summary {
  const { heard, empty } = countsOf(outcomes);
  const ms = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  return {
    heard: {
      n: heard.n,
      strongHit: share(heard.strongHit, heard.n),
      anyHit: share(heard.anyHit, heard.n),
      wrongStrong: share(heard.wrongStrong, heard.n),
      wrongPossible: share(heard.wrongPossible, heard.n),
    },
    empty: { n: empty.n, falseStrong: share(empty.falseStrong, empty.n), falsePossible: share(empty.falsePossible, empty.n) },
    msMedian: ms[ms.length >> 1] ?? 0,
  };
}

export type Results = Record<string, Counts & { date: string }>;

const RESULTS = new URL("../results.json", import.meta.url);

export function readResults(): Results {
  return existsSync(RESULTS) ? (JSON.parse(readFileSync(RESULTS, "utf8")) as Results) : {};
}

/** vitest runs the eval files in parallel workers: one writer at a time (mkdir is atomic). */
function locked(fn: () => void) {
  const lock = fileURLToPath(RESULTS) + ".lock";
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (i > 600) throw new Error(`${lock} held for 30 s: remove it if no eval is running`);
      Atomics.wait(nap, 0, 0, 50);
    }
  }
  try {
    fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Writes this eval's counts into evals/results.json (committed: the scoreboard and the eval
 * delta read it). Only the default corpus counts: a run with SEEDS or PER_FILE set is a probe,
 * not the benchmark. The date moves only when the counts do.
 */
export function recordResults(name: string, outcomes: Outcome[], canonical: boolean) {
  if (!canonical) {
    console.log(`evals/results.json: ${name} not recorded (not the default corpus)`);
    return;
  }
  const counts = countsOf(outcomes);
  locked(() => {
    const all = readResults();
    const before = all[name];
    const same = before && JSON.stringify({ heard: before.heard, empty: before.empty }) === JSON.stringify(counts);
    all[name] = { ...counts, date: same ? before.date : new Date().toISOString().slice(0, 10) };
    const sorted = Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]]));
    const tmp = fileURLToPath(RESULTS) + ".tmp";
    writeFileSync(tmp, JSON.stringify(sorted, null, 2) + "\n");
    renameSync(tmp, RESULTS);
  });
}

const clearsStrong = (os: Outcome[]) =>
  os.filter((o) => (o.score ?? 0) >= STRONG.score && (o.lead ?? 0) >= STRONG.lead).map((o) => o.closest ?? 0);

const quantiles = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN);
  return `min ${q(0)} / p50 ${q(0.5)} / p90 ${q(0.9)} / max ${s[s.length - 1] ?? NaN}`;
};

export function writeReport(name: string, outcomes: Outcome[], summary: Summary, notes: string[] = []): string {
  const dir = new URL("../reports/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const empty = outcomes.filter((o) => o.correct === null);
  const heard = outcomes.filter((o) => o.correct !== null);
  const lines = [
    `# Eval ${name}`,
    "",
    `${new Date().toISOString()}, ${outcomes.length} scenarios, median ${summary.msMedian} ms per analysis.`,
    ...notes.map((n) => `- ${n}`),
    "",
    "| | n | strong and right | any and right | strong but wrong | possible but wrong |",
    "|---|---|---|---|---|---|",
    `| heard | ${summary.heard.n} | ${summary.heard.strongHit} | ${summary.heard.anyHit} | ${summary.heard.wrongStrong} | ${summary.heard.wrongPossible} |`,
    "",
    "| | n | false strong | false possible |",
    "|---|---|---|---|",
    `| nothing to find | ${summary.empty.n} | ${summary.empty.falseStrong} | ${summary.empty.falsePossible} |`,
    "",
    // Real recordings have no oracle (no exact truth curve): the table is for synthetic sound only.
    ...(heard.some((o) => o.oracle !== null)
      ? [
          "Heard, by how findable the sound was (oracle score with a perfect model):",
          "",
          "| oracle | n | strong and right | any and right | wrong |",
          "|---|---|---|---|---|",
          ...[[-Infinity, 4], [4, 6], [6, 10], [10, Infinity]].map(([lo, hi]) => {
            const b = heard.filter((o) => o.oracle !== null && o.oracle >= lo && o.oracle < hi);
            return `| ${lo === -Infinity ? "< 4" : hi === Infinity ? ">= 10" : `${lo} to ${hi}`} | ${b.length} | ${b.filter((o) => o.verdict === "strong" && o.correct).length} | ${b.filter((o) => o.verdict !== "none" && o.correct).length} | ${b.filter((o) => o.verdict !== "none" && !o.correct).length} |`;
          }),
          "",
        ]
      : []),
    "Calibration (best score, lead over the second):",
    `- nothing to find: score ${quantiles(empty.map((o) => o.score ?? 0))}; lead ${quantiles(empty.map((o) => o.lead ?? 0))}`,
    `- heard, right answer: score ${quantiles(heard.filter((o) => o.correct).map((o) => o.score ?? 0))}`,
    `- heard, wrong answer: score ${quantiles(heard.filter((o) => !o.correct).map((o) => o.score ?? 0))}`,
    "",
    "Calibration of STRONG.range (closest range of the best, metres, where its score and lead pass STRONG):",
    `- right answer: ${quantiles(clearsStrong(heard.filter((o) => o.correct)))}`,
    `- wrong answer: ${quantiles(clearsStrong(heard.filter((o) => !o.correct)))}`,
    `- nothing to find: ${quantiles(clearsStrong(empty))}`,
    "",
    "| id | verdict | answer | right | score | lead | oracle | f0 err | clock err | aircraft | tags |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...outcomes.map((o) => `| ${o.id} | ${o.verdict} | ${o.answer ?? ""} | ${o.correct ?? ""} | ${o.score ?? ""} | ${o.lead ?? ""} | ${o.oracle ?? ""} | ${o.f0Error ?? ""} | ${o.clockError ?? ""} | ${o.candidates} | ${Object.entries(o.tags).map(([k, v]) => `${k}=${v}`).join(" ")} |`),
  ];
  const md = lines.join("\n") + "\n";
  writeFileSync(new URL(`${name}.md`, dir), md);
  writeFileSync(new URL(`${name}.json`, dir), JSON.stringify({ summary, outcomes }, null, 2));
  return md;
}

export type Baseline = Record<string, { strongHitMin?: number; anyHitMin?: number; wrongStrongMax?: number; falseStrongMax?: number }>;

/** Problems with this summary against evals/baseline.json, empty when it holds. */
export function againstBaseline(name: string, summary: Summary): string[] {
  const all = JSON.parse(readFileSync(new URL("../baseline.json", import.meta.url), "utf8")) as Baseline;
  const b = all[name];
  if (!b) return [];
  const out: string[] = [];
  if (b.strongHitMin !== undefined && summary.heard.strongHit < b.strongHitMin) out.push(`strong and right ${summary.heard.strongHit} < ${b.strongHitMin}`);
  if (b.anyHitMin !== undefined && summary.heard.anyHit < b.anyHitMin) out.push(`any and right ${summary.heard.anyHit} < ${b.anyHitMin}`);
  if (b.wrongStrongMax !== undefined && summary.heard.wrongStrong > b.wrongStrongMax) out.push(`strong but wrong ${summary.heard.wrongStrong} > ${b.wrongStrongMax}`);
  if (b.falseStrongMax !== undefined && summary.empty.falseStrong > b.falseStrongMax) out.push(`false strong ${summary.empty.falseStrong} > ${b.falseStrongMax}`);
  return out;
}
