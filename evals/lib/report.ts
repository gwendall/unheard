// Runs scenarios through the production analyze(), scores the answers, writes a report and
// checks it against the committed baseline (a ratchet: an eval fails when a metric gets worse).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { heardAt } from "../../lib/core/doppler";
import { curveScore } from "../../lib/core/match";
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

function oracleZ(stack: Stack, s: Scenario): number {
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

export function summarize(outcomes: Outcome[]): Summary {
  const heard = outcomes.filter((o) => o.correct !== null);
  const empty = outcomes.filter((o) => o.correct === null);
  const ms = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  return {
    heard: {
      n: heard.length,
      strongHit: share(heard.filter((o) => o.verdict === "strong" && o.correct).length, heard.length),
      anyHit: share(heard.filter((o) => o.verdict !== "none" && o.correct).length, heard.length),
      wrongStrong: share(heard.filter((o) => o.verdict === "strong" && !o.correct).length, heard.length),
      wrongPossible: share(heard.filter((o) => o.verdict === "possible" && !o.correct).length, heard.length),
    },
    empty: {
      n: empty.length,
      falseStrong: share(empty.filter((o) => o.verdict === "strong").length, empty.length),
      falsePossible: share(empty.filter((o) => o.verdict === "possible").length, empty.length),
    },
    msMedian: ms[ms.length >> 1] ?? 0,
  };
}

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
