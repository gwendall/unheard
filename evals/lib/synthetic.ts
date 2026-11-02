// The synthetic corpus: flybys made up from scratch, so the truth is exact and every hard case
// can be dialled in (faint, far, turning, windy, crowded sky, plane missing from the data).

import type { Listener } from "../../lib/core/geo";
import { flybyFixes, type Flyby } from "../../lib/core/synth";
import { buildTrack, type Track } from "../../lib/core/track";
import { airs, HARMONIC_PROFILES, pollsFrom, rng, scene, type Rng, type Scenario, type Sound } from "./sim";

const LISTENER: Listener = { lat: 48.72, lon: 2.11, elevation: 160 };
const DURATION = 120;

function randomFlyby(r: Rng, start: number, kind: "target" | "decoy"): Flyby {
  if (kind === "target") {
    return {
      closestAt: start + r.uniform(30, 90),
      offset: r.pick([-1, 1]) * r.uniform(150, 2500),
      heading: r.uniform(0, 360),
      speed: r.uniform(35, 90),
      altitude: LISTENER.elevation + r.uniform(200, 2000),
      turnRate: r.gauss(0.3),
    };
  }
  const jet = r.next() < 0.5;
  return {
    closestAt: start + r.uniform(-60, 180),
    offset: r.pick([-1, 1]) * r.uniform(200, 20000),
    heading: r.uniform(0, 360),
    speed: jet ? r.uniform(110, 240) : r.uniform(35, 90),
    altitude: LISTENER.elevation + (jet ? r.uniform(800, 11000) : r.uniform(200, 2500)),
    turnRate: r.gauss(0.2),
  };
}

const truthOf = (f: Flyby, from: number, to: number): Track => buildTrack(flybyFixes(LISTENER, f, from, to, 0.5), LISTENER, { smooth: false })!;

export function syntheticScenario(seed: number, kind: Scenario["kind"]): Scenario {
  const r = rng(seed * 7919 + 13);
  const start = 1_800_000_000 + seed * 1000;
  const from = start - 90;
  const to = start + DURATION + 30;
  const { real, model } = airs(r);
  const clock = r.uniform(-1.8, 1.8);

  const targets = Array.from({ length: kind === "two" ? 2 : 1 }, (_, i) => ({ hex: `t${i}${seed}`, truth: truthOf(randomFlyby(r, start, "target"), from, to) }));
  const decoys = Array.from({ length: r.int(2, 15) }, (_, i) => ({ hex: `d${i}${seed}`, truth: truthOf(randomFlyby(r, start, "decoy"), from, to) }));

  const level = Math.exp(r.uniform(Math.log(0.03), Math.log(0.3)));
  const f0 = r.uniform(60, 200);
  const sounds: Sound[] =
    kind === "noise"
      ? []
      : targets.map((t, i) => ({ truth: t.truth, f0: i ? r.uniform(60, 200) : f0, harmonics: [...r.pick(HARMONIC_PROFILES)], level: i ? Math.exp(r.uniform(Math.log(0.05), Math.log(0.3))) : level }));
  const samples = scene(r, start, DURATION, sounds, real);

  const inData = kind === "missing" ? decoys : [...targets, ...decoys];
  const polls = pollsFrom(
    r,
    LISTENER,
    inData.map((a) => ({ hex: a.hex, truth: a.truth, meta: {} })),
    start - 6,
    start + DURATION,
  );

  const heard = kind === "heard" || kind === "two" ? targets[0].hex : null;
  return {
    id: `syn-${kind}-${seed}`,
    kind,
    // The phone's clock is off by `clock`: it reports start - clock.
    recording: { samples, sampleRate: 8000, start: start - clock, listener: LISTENER, air: model, polls },
    truth: { heard, alsoHeard: kind === "two" ? [targets[1].hex] : undefined, f0: kind === "heard" ? f0 : undefined, clock },
    oracle: sounds.length ? { truth: sounds[0].truth, air: real, f0: sounds[0].f0, harmonics: sounds[0].harmonics, start } : undefined,
    tags: { level: Math.round(level * 1000) / 1000, decoys: decoys.length, wind: Math.round(Math.hypot(real.wind![0], real.wind![1])) },
  };
}
