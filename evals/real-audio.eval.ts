import { expect, it } from "vitest";
import { aerosonicScenarios, bundleScenarios, livermoreScenarios } from "./lib/real";
import { againstBaseline, countsOf, recordResults, run, summarize, writeReport, type Outcome } from "./lib/report";

// Real sound, real ADS-B. AeroSonicDB needs `node scripts/fetch-aerosonic.ts` first and Livermore
// `node scripts/fetch-livermore.ts` (cache, not committed); capture bundles live in
// evals/fixtures/real/ once a human has written their truth.
it("real recordings", async () => {
  const scenarios = [...aerosonicScenarios(), ...livermoreScenarios(), ...bundleScenarios()];
  if (!scenarios.length) {
    console.warn("no real recordings: run node scripts/fetch-aerosonic.ts and node scripts/fetch-livermore.ts");
    return;
  }
  const outcomes: Outcome[] = [];
  for (const s of scenarios) outcomes.push(await run(s));
  const summary = summarize(outcomes);
  const part = (name: string, prefix: string) => {
    const c = countsOf(outcomes.filter((o) => o.id.startsWith(prefix)));
    return `${name}: heard ${c.heard.n}, strong and right ${c.heard.strongHit}, any and right ${c.heard.anyHit}, strong but wrong ${c.heard.wrongStrong}, possible but wrong ${c.heard.wrongPossible}; nothing to find ${c.empty.n}, false strong ${c.empty.falseStrong}, false possible ${c.empty.falsePossible}.`;
  };
  writeReport("real-audio", outcomes, summary, [
    "AeroSonicDB 1.1.2 clips of 2023-03-01 (Adelaide, 60 s, 22 kHz resampled to 8 kHz) with ADS-B Exchange snapshots every 5 s (the page polls every 2 s).",
    "Each clip runs twice: as recorded, and with its aircraft taken out of the data (must not name another).",
    "The microphone position is a public spot near the recorder: tens to hundreds of metres off.",
    "Livermore (lvk-): Pathak 2026, Zenodo 23424278, CC BY 4.0. 40 smartphone recordings (48 kHz resampled to 8 kHz, 41 to 182 s) of aircraft passing 0.3 to 5.7 km away over Livermore, California, in May 2026, with each aircraft's ADS-B track (KML, a point every 3 to 20 s, MSL altitude, speed and heading from neighbouring points).",
    "Livermore data: every passage's aircraft that flew within 40 km during a recording is in that recording's data. Each recording runs again with its aircraft taken out, when another aircraft is left to name; in R21 a Cessna 172 of another passage was audible too (evals/lib/real.ts says why).",
    "Livermore microphone: not published; recovered from the published ground-track offsets L by fitting one point to all tracks (37 passages fit within 2 m rms; the 3 passages of 2026-05-09 fit a second site 6.6 km west-north-west, to 1 m). That is the position the author used; the phone itself may be a few metres away. Height from the tracks' altitude minus the published H.",
    "Livermore start time: the ridge CSV is UTC from the phone's file-name time (to about 1 s); laid on the recording's own spectrogram it gives the first sample's time to about 0.1 s; the clock's own error stays.",
    part("AeroSonicDB", "asdb-"),
    part("Livermore", "lvk-"),
  ]);
  console.log(JSON.stringify(summary));
  recordResults("real-audio", outcomes, true);
  // The corpus is whatever is in the cache: the whole holds the floor of either set alone, and
  // each set present holds its own line.
  const livermore = outcomes.filter((o) => o.id.startsWith("lvk-"));
  const problems = [...againstBaseline("real-audio", summary), ...(livermore.length ? againstBaseline("real-audio-livermore", summarize(livermore)).map((p) => `Livermore: ${p}`) : [])];
  expect(problems).toEqual([]);
});
