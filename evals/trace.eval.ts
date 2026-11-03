// Blind traces (lib/core/trace.ts): how often the tone of an aircraft that was heard is found in
// the sound alone, and how often a recording with no aircraft in it yields a trace anyway.

import { mkdirSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { heardAt, type Air } from "../lib/core/doppler";
import { candidatesOf } from "../lib/core/pipeline";
import { buildStack } from "../lib/core/spectrogram";
import { findTraces, traceFit, type Trace } from "../lib/core/trace";
import type { Track } from "../lib/core/track";
import { aerosonicScenarios } from "./lib/real";
import { oracleZ } from "./lib/report";
import type { Scenario } from "./lib/sim";
import { rate } from "./lib/stats";
import { syntheticScenario } from "./lib/synthetic";

const N = Number(process.env.SEEDS ?? 30);

type Outcome = { id: string; real: boolean; heard: boolean; oracle: number | null; found: number | null; misfit: number | null; spurious: number; ms: number; traces: string };

/** Heard / emitted per frame along a track, `clock` seconds added to the phone's time. */
const curve = (times: Float64Array, track: Track, start: number, air: Air, clock = 0) => Array.from(times, (t) => heardAt(track, start + t + clock, air)?.factor ?? NaN);

/** The pitch moves enough along the trace for a fit to mean anything (a flat curve fits any flat tone). */
function moves(t: Trace, factor: number[]): boolean {
  const xs = factor.slice(t.from, t.to + 1).filter(Number.isFinite);
  return xs.length > 0 && Math.max(...xs) / Math.min(...xs) > 1.02;
}

/**
 * A trace is right when it follows the true curve (times a tone in closed form) to 0.5 % median
 * over half its frames or more. Real clips: the curve comes from ADS-B at the approximate
 * microphone, the clock within 3 s: 0.8 %, and the best of the aircraft in the data says which.
 */
function run(s: Scenario): Outcome {
  const real = s.id.startsWith("asdb");
  const stack = buildStack(s.recording.samples, s.recording.sampleRate);
  const t0 = performance.now();
  // Jets hum at 1 to 3 kHz, their fan tones above 2 kHz while they come in: the real clips are
  // searched up to 3.4 kHz, as locate does.
  const { traces } = findTraces(stack, real ? { fMax: 3400 } : {});
  const ms = Math.round(performance.now() - t0);
  const times = stack.base.times;
  const answers = [s.truth.heard, ...(s.truth.alsoHeard ?? [])];
  let found: number | null = null;
  let misfit: number | null = null;
  const parts: string[] = [];
  let spurious = 0;
  for (const t of traces) {
    let best = { id: "", misfit: Infinity };
    if (real) {
      for (const c of candidatesOf(s.recording.polls, s.recording.listener)) {
        for (let clock = -3; clock <= 3; clock += 0.25) {
          const factor = curve(times, c.track, s.recording.start, s.recording.air, clock);
          const fit = traceFit(t, factor);
          if (fit.covered > 0.5 && moves(t, factor) && fit.misfit < best.misfit) best = { id: c.id, misfit: fit.misfit };
        }
      }
    } else if (s.oracle) {
      const factor = curve(times, s.oracle.truth, s.oracle.start, s.oracle.air);
      const fit = traceFit(t, factor);
      // The trace may follow a harmonic, or the fundamental of a profile whose first harmonic is weak.
      const harmonic = [0.5, 1, 1.5, 2, 3, 4].some((r) => Math.abs(fit.f0 / s.oracle!.f0 / r - 1) < 0.01);
      // The aircraft heard, whether it is in the data or not ("missing"): a blind search cannot tell.
      if (harmonic && fit.covered > 0.5 && moves(t, factor)) best = { id: "heard", misfit: fit.misfit };
    }
    const right = (best.id === "heard" || answers.includes(best.id)) && best.misfit < (real ? 0.008 : 0.005);
    if (right && (found === null || t.confidence > found)) [found, misfit] = [t.confidence, best.misfit];
    if (!right) spurious++;
    const follows = real && best.misfit < 0.008 ? ` follows ${best.id} (${(best.misfit * 100).toFixed(2)} %)` : "";
    parts.push(`${t.freq[t.from].toFixed(0)}->${t.freq[t.to].toFixed(0)} Hz at ${times[t.from].toFixed(0)}-${times[t.to].toFixed(0)} s c=${t.confidence.toFixed(1)}${follows}${right ? " (right)" : ""}`);
  }
  const oracle = s.oracle ? Math.round(oracleZ(stack, s) * 10) / 10 : null;
  return { id: s.id, real, heard: real || !!s.oracle, oracle, found, misfit, spurious, ms, traces: parts.join("; ") };
}

it("blind traces", () => {
  const plan: [Scenario["kind"], number, number][] = [["heard", 0, N], ["noise", 1000, N], ["missing", 2000, Math.ceil(N / 2)], ["two", 3000, Math.ceil(N / 5)]];
  const outcomes = plan.flatMap(([kind, base, n]) => Array.from({ length: n }, (_, i) => run(syntheticScenario(base + i, kind))));
  // Each real clip once: the clips with their aircraft taken out of the data are the same sound.
  outcomes.push(...aerosonicScenarios().filter((x) => !x.id.startsWith("asdb-missing")).map(run));

  const count = (xs: Outcome[], f: (o: Outcome) => boolean) => xs.filter(f).length;
  const heard = outcomes.filter((o) => !o.real && o.heard);
  const empty = outcomes.filter((o) => !o.real && !o.heard);
  const real = outcomes.filter((o) => o.real);
  const findable = heard.filter((o) => (o.oracle ?? 0) >= 6);
  const ms = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  const summary = {
    findable: { n: findable.length, found: count(findable, (o) => o.found !== null) },
    empty: { n: empty.length, falseTrace: count(empty, (o) => o.spurious > 0) },
    real: { n: real.length, found: count(real, (o) => o.found !== null) },
    msMedian: ms[ms.length >> 1] ?? 0,
  };
  const bucket = (name: string, lo: number, hi: number) => {
    const b = heard.filter((o) => (o.oracle ?? 0) >= lo && (o.oracle ?? 0) < hi);
    return `| synthetic heard, oracle ${name} | ${b.length} | ${rate(count(b, (o) => o.found !== null), b.length)} | ${rate(count(b, (o) => o.spurious > 0), b.length)} |`;
  };
  const lines = [
    "# Eval trace",
    "",
    `${new Date().toISOString()}, ${outcomes.length} scenarios, median ${summary.msMedian} ms per search (synthetic 40 to 400 Hz over 120 s, real 40 to 3400 Hz over 60 s).`,
    "- Right: the trace follows the true curve times a tone in closed form, median distance under 0.5 % (synthetic, exact curve) or 0.8 % (real: ADS-B at the approximate microphone, clock within 3 s), over half its frames, where the curve falls by 2 % or more.",
    "- Synthetic: heard, missing (heard, not in the data: the same for a blind search), two (only the first aircraft's curve is known: the second one's trace counts as following nothing), noise (hum, rumble, passing cars, bursts, no aircraft). Oracle: how findable the sound was with a perfect model.",
    "- Real: a trace the labelled aircraft does not explain may be a real tone all the same (another aircraft, a vehicle, an engine on the ground).",
    "",
    "| | n | right trace found | a trace that follows nothing heard |",
    "|---|---|---|---|",
    bucket("< 4", -Infinity, 4),
    bucket("4 to 6", 4, 6),
    bucket("6 to 10", 6, 10),
    bucket(">= 10", 10, Infinity),
    `| synthetic, no aircraft | ${empty.length} | | ${rate(summary.empty.falseTrace, empty.length)} |`,
    `| real (AeroSonicDB) | ${real.length} | ${rate(summary.real.found, real.length)} | ${rate(count(real, (o) => o.spurious > 0), real.length)} |`,
    "",
    `Confidence of right traces: ${outcomes.filter((o) => o.found !== null).map((o) => o.found!.toFixed(1)).join(", ")}`,
    "",
    "| id | oracle | found | misfit % | spurious | ms | traces |",
    "|---|---|---|---|---|---|---|",
    ...outcomes.map((o) => `| ${o.id} | ${o.oracle ?? ""} | ${o.found?.toFixed(1) ?? ""} | ${o.misfit === null ? "" : (o.misfit * 100).toFixed(2)} | ${o.spurious} | ${o.ms} | ${o.traces} |`),
  ];
  const dir = new URL("./reports/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("trace.md", dir), lines.join("\n") + "\n");
  writeFileSync(new URL("trace.json", dir), JSON.stringify({ summary, outcomes }, null, 2));
  console.log(JSON.stringify(summary));
  // Guards on the default corpus, a margin under the run of 2026-11-03 (13 of 21 findable, 1 of
  // 30 noise; 7 of the 9 real clips): a change that loses the traces of loud flybys or jets, or
  // finds them in noise, fails here. The real clips only run where AeroSonicDB is cached.
  if (process.env.SEEDS !== undefined) return;
  expect(summary.findable.found / Math.max(1, summary.findable.n)).toBeGreaterThanOrEqual(0.5);
  expect(summary.empty.falseTrace / Math.max(1, summary.empty.n)).toBeLessThanOrEqual(0.1);
  if (summary.real.n > 0) expect(summary.real.found / summary.real.n).toBeGreaterThanOrEqual(0.6);
});
