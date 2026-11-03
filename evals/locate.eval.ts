// Locate me (lib/core/locate.ts): how far the best spot lands from where the recording was made,
// with the phone's position given only as the 10 km cell around it.

import { mkdirSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { fromLocal } from "../lib/core/geo";
import { locate, offsetOf, serverArea, type Area, type Location } from "../lib/core/locate";
import type { Recording } from "../lib/core/pipeline";
import { buildStack } from "../lib/core/spectrogram";
import { stateAt } from "../lib/core/track";
import { aerosonicScenarios } from "./lib/real";
import { oracleZ } from "./lib/report";
import { rng, type Scenario } from "./lib/sim";
import { syntheticScenario } from "./lib/synthetic";

const N = Number(process.env.SEEDS ?? 30);

type Outcome = {
  id: string;
  set: string;
  oracle: number | null;
  /** Metres from the best spot to the truth; null when nothing was located. */
  error: number | null;
  /** Along and across the heard aircraft's track at its closest point (synthetic only). */
  along: number | null;
  across: number | null;
  /** Metres from the mirror spot to the truth. */
  mirror: number | null;
  /** Rank (1-based) of the first spot within 250 m of the truth, 0 when none. */
  rank: number;
  rightAircraft: boolean | null;
  score: number | null;
  clock: number | null;
  traces: number;
  aircraft: number;
  /** Wall time of locate (the stack, built by analyze() anyway, left out), and its CPU time. */
  ms: number;
  cpu: number;
};

/** The square the server would search: its centre anywhere within 5 km of the truth, as a 0.1° cell. */
function areaAround(truth: { lat: number; lon: number }, seed: number): Area {
  const r = rng(seed * 31 + 7);
  const c = fromLocal({ lat: truth.lat, lon: truth.lon, elevation: 0 }, r.uniform(-5000, 5000), r.uniform(-5000, 5000));
  return { lat: c.lat, lon: c.lon, side: 20_000 };
}

async function run(s: Scenario, set: string, area: Area, shiftClock = false): Promise<Outcome> {
  const truth = s.recording.listener;
  // The listener's own position never reaches locate: only the area's centre.
  const rec: Recording = { ...s.recording, listener: { ...truth, lat: area.lat, lon: area.lon } };
  const exact = shiftClock && s.truth.clock !== undefined;
  if (exact) rec.start += s.truth.clock!;
  const stack = buildStack(rec.samples, rec.sampleRate);
  const cpu = process.cpuUsage();
  const loc: Location = await locate(rec, area, { stack, clockSpread: exact ? 0.25 : undefined });
  const used = process.cpuUsage(cpu);
  const [te, tn] = offsetOf(area, truth.lat, truth.lon);
  const dist = (p: { e: number; n: number } | null) => (p ? Math.hypot(p.e - te, p.n - tn) : null);
  const best = loc.spots[0] ?? null;
  let along: number | null = null;
  let across: number | null = null;
  const o = s.oracle;
  if (best && o) {
    // The heard aircraft's heading where it passed closest to the truth.
    let closest = { r: Infinity, v: [0, 1, 0] as number[] };
    for (let t = o.start; t <= o.start + 120; t += 0.5) {
      const st = stateAt(o.truth, t);
      if (st && Math.hypot(st.p[0], st.p[1]) < closest.r) closest = { r: Math.hypot(st.p[0], st.p[1]), v: st.v };
    }
    const sp = Math.hypot(closest.v[0], closest.v[1]) || 1;
    const de = best.e - te;
    const dn = best.n - tn;
    along = Math.round((de * closest.v[0] + dn * closest.v[1]) / sp);
    across = Math.round((-de * closest.v[1] + dn * closest.v[0]) / sp);
  }
  const answers = [s.truth.heard, ...(s.truth.alsoHeard ?? [])].filter(Boolean);
  const rank = loc.spots.findIndex((p) => (dist(p) ?? Infinity) <= 250) + 1;
  return {
    id: s.id,
    set,
    oracle: o ? Math.round(oracleZ(stack, s) * 10) / 10 : null,
    error: best ? Math.round(dist(best)!) : null,
    along,
    across,
    mirror: loc.mirror ? Math.round(dist(loc.mirror)!) : null,
    rank,
    rightAircraft: best ? answers.includes(best.aircraft) : null,
    score: best ? Math.round(best.score * 10) / 10 : null,
    clock: best ? best.clock : null,
    traces: loc.traces.length,
    aircraft: loc.aircraft,
    ms: loc.ms,
    cpu: Math.round((used.user + used.system) / 1000),
  };
}

const quantile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const pct = (k: number, n: number) => (n ? `${Math.round((100 * k) / n)} %` : "");
/** A quantile that falls on a run that located nothing reads "-". */
const metres = (x: number) => (Number.isFinite(x) ? String(x) : "-");

function row(name: string, xs: Outcome[]) {
  const n = xs.length;
  // Nothing located counts as missed by any distance.
  const errors = xs.map((o) => o.error ?? Infinity);
  const within = (m: number) => errors.filter((e) => e <= m).length;
  const mirrored = xs.filter((o) => (o.error ?? Infinity) > 250 && o.mirror !== null && o.mirror <= 250).length;
  const ms = xs.map((o) => o.ms);
  const cpu = xs.map((o) => o.cpu);
  return `| ${name} | ${n} | ${pct(xs.filter((o) => o.error !== null).length, n)} | ${metres(quantile(errors, 0.5))} | ${metres(quantile(errors, 0.9))} | ${pct(within(100), n)} | ${pct(within(250), n)} | ${pct(within(1000), n)} | ${pct(mirrored, n)} | ${pct(xs.filter((o) => o.rank > 0).length, n)} | ${pct(xs.filter((o) => o.rightAircraft).length, n)} | ${quantile(ms, 0.5)} / ${quantile(ms, 0.9)} | ${quantile(cpu, 0.5)} |`;
}

it("locate me", async () => {
  const outcomes: Outcome[] = [];
  for (let i = 0; i < N; i++) {
    const s = syntheticScenario(i, "heard");
    const area = areaAround(s.recording.listener, i);
    outcomes.push(await run(s, "synthetic, one aircraft", area));
    outcomes.push(await run(s, "same, phone clock exact", area, true));
  }
  for (let i = 0; i < Math.ceil(N / 2); i++) {
    const s = syntheticScenario(3000 + i, "two");
    outcomes.push(await run(s, "synthetic, two aircraft", areaAround(s.recording.listener, 3000 + i)));
  }
  // The 10 real flybys: 9 clips, and the one whose labelled helicopter is left out of the data
  // while a second one is heard.
  for (const s of aerosonicScenarios().filter((x) => x.kind === "heard")) outcomes.push(await run(s, "real (AeroSonicDB)", serverArea(s.recording.listener)));

  const sets = [...new Set(outcomes.map((o) => o.set))];
  const one = outcomes.filter((o) => o.set === "synthetic, one aircraft");
  const buckets: [string, number, number][] = [
    ["< 4", -Infinity, 4],
    ["4 to 6", 4, 6],
    ["6 to 10", 6, 10],
    [">= 10", 10, Infinity],
  ];
  const header = ["| set | n | located | median m | p90 m | <= 100 m | <= 250 m | <= 1 km | truth is the mirror | truth in top 5 | right aircraft | ms p50 / p90 | cpu ms p50 |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  const lines = [
    "# Eval locate",
    "",
    `${new Date().toISOString()}, ${outcomes.length} runs.`,
    "- The search covers a 20 km square around the 0.1° cell the server sees (synthetic: centred anywhere within 5 km of the truth); the listener's own position is never passed in.",
    "- Distances from the best spot to the truth. Nothing located counts as missed at every distance ('-': the quantile falls on such a run). 'Truth is the mirror': the best spot is more than 250 m off and the mirror spot within 250 m.",
    "- 'Phone clock exact': the same recordings with the clock known to 0.25 s instead of swept over ±2 s. Along one straight track, a clock error of dt moves the spot by speed x dt along it.",
    "- Real: the microphone position itself is only known to tens or hundreds of metres (a public spot near the recorder).",
    "- Time: locate alone in Node on the founder's Mac, shared with other work (wall), and the CPU time it used; the spectrogram stack (built by analyze() anyway) is left out.",
    "",
    ...header,
    ...sets.map((name) => row(name, outcomes.filter((o) => o.set === name))),
    "",
    "Synthetic, one aircraft, by how findable the sound was (oracle score with a perfect model):",
    "",
    ...header,
    ...buckets.map(([name, lo, hi]) => row(`oracle ${name}`, one.filter((o) => (o.oracle ?? 0) >= lo && (o.oracle ?? 0) < hi))),
    "",
    "Every run, by the best spot's evidence score (how much to trust an answer):",
    "",
    ...header,
    ...([["< 5", -Infinity, 5], ["5 to 8", 5, 8], ["8 to 12", 8, 12], [">= 12", 12, Infinity]] as [string, number, number][]).map(([name, lo, hi]) =>
      row(`score ${name}`, outcomes.filter((o) => o.score !== null && o.score >= lo && o.score < hi)),
    ),
    "",
    "| id | set | oracle | error m | along m | across m | mirror m | rank | right aircraft | score | clock | traces | aircraft | ms |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...outcomes.map((o) => `| ${o.id} | ${o.set} | ${o.oracle ?? ""} | ${o.error ?? ""} | ${o.along ?? ""} | ${o.across ?? ""} | ${o.mirror ?? ""} | ${o.rank} | ${o.rightAircraft ?? ""} | ${o.score ?? ""} | ${o.clock ?? ""} | ${o.traces} | ${o.aircraft} | ${o.ms} |`),
  ];
  const dir = new URL("./reports/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("locate.md", dir), lines.join("\n") + "\n");
  writeFileSync(new URL("locate.json", dir), JSON.stringify({ outcomes }, null, 2));
  console.log(lines.slice(0, 8 + sets.length + 2).join("\n"));
  // A guard on the default corpus, a margin under the run of 2026-11-03 (6 of 6 within 1 km):
  // loud single flybys must still land close.
  if (process.env.SEEDS !== undefined) return;
  const loud = one.filter((o) => (o.oracle ?? 0) >= 10);
  expect(loud.filter((o) => (o.error ?? Infinity) <= 1000).length).toBeGreaterThanOrEqual(Math.floor(loud.length / 2));
});
