import { expect, it } from "vitest";
import { againstBaseline, run, summarize, writeReport, type Outcome } from "./lib/report";
import { trackScenarios } from "./lib/tracks";

// Real ADS-B tracks recorded with scripts/record-sky.ts, made-up sound. PER_FILE=n scenarios
// per recording (default 40).
it("real tracks", async () => {
  const scenarios = trackScenarios(Number(process.env.PER_FILE ?? 40));
  if (!scenarios.length) {
    console.warn("no sky recordings in evals/fixtures/sky: run pnpm record-sky");
    return;
  }
  const outcomes: Outcome[] = [];
  for (const s of scenarios) outcomes.push(await run(s));
  const summary = summarize(outcomes);
  writeReport("real-tracks", outcomes, summary, ["Real tracks (adsb.lol, polled under its rate limit), made-up sound; the page sees every other poll and every aircraft within 30 km."]);
  console.log(JSON.stringify(summary));
  expect(againstBaseline("real-tracks", summary)).toEqual([]);
});
