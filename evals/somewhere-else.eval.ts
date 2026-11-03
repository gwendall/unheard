import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { analyze, type Analysis } from "../lib/core/pipeline";
import type { Poll } from "../lib/adsb";
import { elsewhereCase, recordedSkies, syntheticSky, twins, type ElsewhereCase } from "./lib/elsewhere";

// "Somewhere else" (lib/client/elsewhere.ts): a voice note recorded at home, given the sky of
// another place, read back by the production analyze() three ways. At the fake spot with the
// flight data the page made: does it name the planted plane? At the fake spot with the true
// tracks of that minute, as someone with the full ADS-B history would check: does the planted
// curve hold up? 3 km from the fake spot: do the curves point to a spot, not just to a city? At
// home with home's own sky: does anything get named? SEEDS=n scenes of each sky (synthetic and
// recorded adsb.lol, default 15). The ratchet is the "somewhere-else" entry of evals/baseline.json.

const N = Number(process.env.SEEDS ?? 15);

type Read = { verdict: Analysis["verdict"]["kind"]; answer: string | null; score: number | null; lead: number | null; primary: boolean; planted: boolean };

/** `polls` are the flight data this read was made with: a TIS-B twin of a planted aircraft is that aircraft. */
function read(a: Analysis, c: ElsewhereCase, polls: Poll[]): Read {
  const best = a.verdict.best;
  const is = (hex: string) => !!best && (best.id === hex || twins(polls, hex, best.id));
  const second = a.verdict.ranked[1]?.score ?? 0;
  return {
    verdict: a.verdict.kind,
    answer: best?.id ?? null,
    score: best ? Math.round(best.score * 100) / 100 : null,
    lead: best ? Math.round((best.score - second) * 100) / 100 : null,
    primary: is(c.scene.planted[0].meta.hex),
    planted: c.scene.planted.some((p) => is(p.meta.hex)),
  };
}

type Row = { id: string; kind: string; range: number; height: number; shift: number; planted: number; above: number; underVoice: number; ours: Read; real: Read; aside: Read; home: Read; ms: number };

it("somewhere else", async () => {
  const skies = [...Array.from({ length: N }, (_, i) => syntheticSky(i + 1)), ...recordedSkies(N)];
  const rows: Row[] = [];
  let none = 0;
  for (const [i, sky] of skies.entries()) {
    const t0 = performance.now();
    const c = await elsewhereCase(sky, i + 1);
    if (!c) {
      none++;
      continue;
    }
    const [ours, real, aside, home] = [c.fit.analysis, await analyze(c.real), await analyze(c.aside), await analyze(c.home)];
    const p = c.scene.planted[0];
    rows.push({
      id: c.id,
      kind: p.kind,
      range: Math.round(p.closest.range),
      height: Math.round(p.closest.height),
      shift: c.scene.shift,
      planted: c.scene.planted.length,
      above: c.fit.above,
      underVoice: Math.round(c.underVoice * 10) / 10,
      ours: read(ours, c, c.scene.polls),
      real: read(real, c, c.real.polls),
      aside: read(aside, c, c.aside.polls),
      home: read(home, c, c.home.polls),
      ms: Math.round(performance.now() - t0),
    });
  }
  const share = (f: (r: Row) => boolean) => Math.round((rows.filter(f).length / Math.max(1, rows.length)) * 100) / 100;
  const summary = {
    scenes: rows.length,
    noPlane: none,
    ours: { strongPrimary: share((r) => r.ours.verdict === "strong" && r.ours.primary), anyPrimary: share((r) => r.ours.verdict !== "none" && r.ours.primary), wrongStrong: share((r) => r.ours.verdict === "strong" && !r.ours.planted) },
    real: { strongPrimary: share((r) => r.real.verdict === "strong" && r.real.primary), anyPrimary: share((r) => r.real.verdict !== "none" && r.real.primary), wrongStrong: share((r) => r.real.verdict === "strong" && !r.real.planted) },
    aside: { strongPrimary: share((r) => r.aside.verdict === "strong" && r.aside.primary), anyPrimary: share((r) => r.aside.verdict !== "none" && r.aside.primary) },
    home: { strong: share((r) => r.home.verdict === "strong"), possible: share((r) => r.home.verdict === "possible") },
    underVoiceMedian: [...rows.map((r) => r.underVoice)].sort((a, b) => a - b)[rows.length >> 1] ?? null,
  };
  const dir = new URL("./reports/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const md = [
    "# Eval somewhere-else",
    "",
    `${new Date().toISOString()}, ${rows.length} scenes (${none} skies with no plane low enough), voice notes of 30 to 60 s.`,
    "",
    "| read at | flight data | strong, the planted plane | named, the planted plane | strong, a plane not planted |",
    "|---|---|---|---|---|",
    `| fake spot | the page's (dead reckoning from 3 polls) | ${summary.ours.strongPrimary} | ${summary.ours.anyPrimary} | ${summary.ours.wrongStrong} |`,
    `| fake spot | the true tracks of that minute | ${summary.real.strongPrimary} | ${summary.real.anyPrimary} | ${summary.real.wrongStrong} |`,
    `| 3 km from the fake spot | the page's | ${summary.aside.strongPrimary} | ${summary.aside.anyPrimary} | |`,
    "",
    `At home with home's own sky: strong ${summary.home.strong}, possible ${summary.home.possible} (nothing there to find). Planted planes ${summary.underVoiceMedian} dB under the voice (median).`,
    "",
    "| id | kind | closest m | height m | shift s | planted | dB over background | dB under voice | ours | real | 3 km away | home | ms |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => {
      const cell = (x: Read) => `${x.verdict} ${x.score ?? ""}${x.primary ? " (it)" : x.planted ? " (other planted)" : x.answer ? " (not planted)" : ""}`;
      return `| ${r.id} | ${r.kind} | ${r.range} | ${r.height} | ${r.shift} | ${r.planted} | ${r.above} | ${r.underVoice} | ${cell(r.ours)} | ${cell(r.real)} | ${cell(r.aside)} | ${cell(r.home)} | ${r.ms} |`;
    }),
  ].join("\n");
  writeFileSync(new URL("somewhere-else.md", dir), md + "\n");
  writeFileSync(new URL("somewhere-else.json", dir), JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary));
  // The page's own proof never names strongly a plane it did not plant. The rest is a ratchet:
  // with the true tracks, a plane of that sky that was not planted can borrow a planted line
  // (docs/STATUS.md, Next), which still points to that place and that minute.
  expect(summary.ours.wrongStrong).toBe(0);
  const b = (JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8")) as Record<string, Record<string, number>>)["somewhere-else"];
  if (process.env.SEEDS === undefined && b) {
    expect(summary.ours.strongPrimary).toBeGreaterThanOrEqual(b.strongMin);
    expect(summary.real.strongPrimary).toBeGreaterThanOrEqual(b.trueTracksStrongMin);
    expect(summary.real.wrongStrong).toBeLessThanOrEqual(b.trueTracksWrongStrongMax);
    expect(summary.aside.strongPrimary).toBeLessThanOrEqual(b.asideStrongMax);
    expect(summary.home.strong).toBeLessThanOrEqual(b.homeStrongMax);
  }
});
