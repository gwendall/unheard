import { expect, it } from "vitest";
import { againstBaseline, recordResults, run, summarize, writeReport, type Outcome } from "./lib/report";
import { syntheticScenario } from "./lib/synthetic";

// SEEDS=n widens the corpus (default 30 per kind for heard, fewer for the rest).
const N = Number(process.env.SEEDS ?? 30);
const plan = [
  ...Array.from({ length: N }, (_, i) => ["heard", i] as const),
  ...Array.from({ length: Math.ceil(N / 2) }, (_, i) => ["noise", 1000 + i] as const),
  ...Array.from({ length: Math.ceil(N / 2) }, (_, i) => ["missing", 2000 + i] as const),
  ...Array.from({ length: Math.ceil(N / 5) }, (_, i) => ["two", 3000 + i] as const),
];

it("synthetic corpus", async () => {
  const outcomes: Outcome[] = [];
  for (const [kind, seed] of plan) outcomes.push(await run(syntheticScenario(seed, kind)));
  const summary = summarize(outcomes);
  writeReport("synthetic", outcomes, summary, ["Made-up flybys: exact truth, clock error, wind and forecast air, noisy sparse ADS-B, hum, passing cars, bursts."]);
  console.log(JSON.stringify(summary));
  recordResults("synthetic", outcomes, process.env.SEEDS === undefined || N === 30);
  expect(againstBaseline("synthetic", summary)).toEqual([]);
});
