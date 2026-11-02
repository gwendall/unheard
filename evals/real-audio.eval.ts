import { expect, it } from "vitest";
import { aerosonicScenarios, bundleScenarios } from "./lib/real";
import { againstBaseline, recordResults, run, summarize, writeReport, type Outcome } from "./lib/report";

// Real sound, real ADS-B. AeroSonicDB needs `node scripts/fetch-aerosonic.ts` first (cache, not
// committed); capture bundles live in evals/fixtures/real/ once a human has written their truth.
it("real recordings", async () => {
  const scenarios = [...aerosonicScenarios(), ...bundleScenarios()];
  if (!scenarios.length) {
    console.warn("no real recordings: run node scripts/fetch-aerosonic.ts");
    return;
  }
  const outcomes: Outcome[] = [];
  for (const s of scenarios) outcomes.push(await run(s));
  const summary = summarize(outcomes);
  writeReport("real-audio", outcomes, summary, [
    "AeroSonicDB 1.1.2 clips of 2023-03-01 (Adelaide, 60 s, 22 kHz resampled to 8 kHz) with ADS-B Exchange snapshots every 5 s (the page polls every 2 s).",
    "Each clip runs twice: as recorded, and with its aircraft taken out of the data (must not name another).",
    "The microphone position is a public spot near the recorder: tens to hundreds of metres off.",
  ]);
  console.log(JSON.stringify(summary));
  recordResults("real-audio", outcomes, true);
  expect(againstBaseline("real-audio", summary)).toEqual([]);
});
