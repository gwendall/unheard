// Real tracks, made-up sound: ADS-B recorded around a busy light-aircraft area with
// scripts/record-sky.ts (evals/fixtures/sky/), real turns, climbs and the real polling cadence
// of adsb.lol under its rate limit. The sound is synthesised from the track smoothed over every
// poll; the page only gets every other poll, so it has to rebuild the track from half the data.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { collect, type Poll } from "../../lib/adsb";
import { fromLocal, toLocal, type Listener } from "../../lib/core/geo";
import { ANALYSIS_RATE } from "../../lib/core/pipeline";
import { buildTrack, stateAt } from "../../lib/core/track";
import { airs, HARMONIC_PROFILES, rng, scene, type Scenario } from "./sim";

const DIR = new URL("../fixtures/sky/", import.meta.url);
const DURATION = 120;
/** Rough ground height of each recorded area, metres. */
const GROUND: Record<string, number> = { phoenix: 340, daytona: 10 };

function load(file: string): { name: string; polls: Poll[] } {
  const raw = readFileSync(new URL(file, DIR));
  const text = (file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  return { name: lines[0].header.name, polls: lines.slice(1) };
}

export function trackScenarios(perFile = 40, seed = 1): Scenario[] {
  if (!existsSync(DIR)) return [];
  const out: Scenario[] = [];
  for (const file of readdirSync(DIR).filter((f) => /\.jsonl(\.gz)?$/.test(f)).sort()) {
    const { name, polls } = load(file);
    const r = rng(seed + file.length);
    const ground = GROUND[name] ?? 0;
    const seen = collect(polls);
    // Low and slow: what a listener can hear and what flies around light-aircraft fields.
    const targets = [...seen.values()].filter((s) => s.fixes.length >= 30 && s.fixes.every((f) => f.altitude - ground < 1800 && Math.hypot(f.velocity[0], f.velocity[1]) < 85));
    for (let i = 0; i < perFile && targets.length; i++) {
      const target = r.pick(targets);
      const fixes = target.fixes;
      const span = fixes[fixes.length - 1].t - fixes[0].t;
      if (span < DURATION + 40) continue;
      const tc = fixes[0].t + 70 + r.next() * (span - 140);
      // A listener beside the path at tc, then everything in its local frame.
      const origin: Listener = { lat: fixes[0].lat, lon: fixes[0].lon, elevation: ground };
      const local = buildTrack(fixes, origin)!;
      const s = stateAt(local, tc);
      if (!s) continue;
      const speed = Math.hypot(s.v[0], s.v[1]) || 1;
      const side = r.pick([-1, 1]) * r.uniform(300, 2500);
      const spot = fromLocal(origin, s.p[0] + (side * s.v[1]) / speed, s.p[1] - (side * s.v[0]) / speed);
      const listener: Listener = { ...spot, elevation: ground };
      const truth = buildTrack(fixes, listener)!;
      const h = stateAt(truth, tc);
      if (!h || h.p[2] < 150) continue;
      const start = tc - r.uniform(40, 80);
      const clock = r.uniform(-1.8, 1.8);
      const { real, model } = airs(r);
      const f0 = r.uniform(60, 200);
      const level = Math.exp(r.uniform(Math.log(0.05), Math.log(0.3)));
      const harmonics = [...r.pick(HARMONIC_PROFILES)];
      const samples = scene(r, start, DURATION, [{ truth, f0, harmonics, level }], real);
      // The page's view: every other poll in the window, from 6 s before the start.
      const view = polls.filter((p, k) => p.now / 1000 >= start - 6 && p.now / 1000 <= start + DURATION && k % 2 === i % 2);
      const near = view.map((p) => ({ now: p.now, aircraft: p.aircraft.filter((a) => {
        const q = toLocal(listener, a.lat!, a.lon!, 0);
        return Math.hypot(q[0], q[1]) < 30_000;
      }) }));
      out.push({
        id: `trk-${name}-${i}`,
        kind: "heard",
        recording: { samples, sampleRate: ANALYSIS_RATE, start: start - clock, listener, air: model, polls: near },
        truth: { heard: target.meta.hex, f0, clock },
        oracle: { truth, air: real, f0, harmonics, start },
        tags: { type: target.meta.type ?? "", level: Math.round(level * 1000) / 1000, side: Math.round(side), polls: near.length },
      });
    }
  }
  return out;
}
