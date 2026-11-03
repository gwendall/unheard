// Scenes for the "somewhere else" eval: a voice note recorded at home, given the sky of another
// place by lib/client/elsewhere.ts, then run through analyze() four ways: at the fake spot with
// the flight data the page made, at the fake spot with the true tracks of that minute (what
// someone with the full ADS-B history would use), 3 km from the fake spot with the page's flight
// data (the curves point to a spot, not just to a city), and at home with home's own sky.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { Poll } from "../../lib/adsb";
import type { Air } from "../../lib/core/doppler";
import { fromLocal, toLocal, type Listener } from "../../lib/core/geo";
import { ANALYSIS_RATE, type Recording } from "../../lib/core/pipeline";
import { flybyFixes, type Flyby } from "../../lib/core/synth";
import { buildTrack, type Track } from "../../lib/core/track";
import { fit, loudness, planScene, type Fit, type Scene } from "../../lib/client/elsewhere";
import { pollsFrom, rng, type Rng } from "./sim";

/**
 * A voice note: phrases of 1 to 4 s, syllables of 0.1 to 0.35 s on a gliding pitch (95 to 230 Hz),
 * harmonics up to 3.8 kHz shaped by two moving formants, pauses, and the room's own hiss and rumble
 * `room` dB under the voice. RMS about 0.1.
 */
export function voiceLike(r: Rng, duration: number, rate: number, room = 40): Float32Array {
  const n = Math.round(duration * rate);
  const env = new Float32Array(n);
  const pitch = new Float32Array(n);
  const f1 = new Float32Array(n);
  const f2 = new Float32Array(n);
  const base = r.uniform(95, 230);
  let t = r.uniform(0, 0.5);
  while (t < duration) {
    const end = Math.min(duration, t + r.uniform(1, 4));
    let s = t;
    while (s < end) {
      const len = r.uniform(0.1, 0.35);
      const p0 = base * r.uniform(0.85, 1.2);
      const p1 = base * r.uniform(0.85, 1.2);
      const F1 = r.uniform(300, 800);
      const F2 = r.uniform(900, 2300);
      const a = Math.round(s * rate);
      const b = Math.min(n, Math.round((s + len) * rate));
      for (let i = a; i < b; i++) {
        const x = (i - a) / (b - a);
        env[i] = Math.sin(Math.PI * x) ** 0.6;
        pitch[i] = p0 + (p1 - p0) * x;
        f1[i] = F1;
        f2[i] = F2;
      }
      s += len + r.uniform(0, 0.06);
    }
    t = end + r.uniform(0.2, 1);
  }
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    if (!env[i]) continue;
    phase += (2 * Math.PI * pitch[i]) / rate;
    let v = 0;
    for (let k = 1; k * pitch[i] < Math.min(3800, rate / 2); k++) {
      const f = k * pitch[i];
      const shape = 1 + 3 * Math.exp(-(((f - f1[i]) / 150) ** 2)) + 2 * Math.exp(-(((f - f2[i]) / 250) ** 2));
      v += (shape / k) * Math.sin(k * phase);
    }
    out[i] = env[i] * v;
  }
  const scale = 0.1 / (loudness(out) || 1);
  const hiss = 0.1 * 10 ** (-room / 20);
  let low = 0;
  const alpha = 1 - Math.exp((-2 * Math.PI * 150) / rate);
  for (let i = 0; i < n; i++) {
    low += alpha * (r.gauss() - low);
    out[i] = out[i] * scale + hiss * (r.gauss() + 3 * low);
  }
  return out;
}

/** Home: a listener near Paris and the flights of its own sky, none of them in the voice note. */
const HOME: Listener = { lat: 48.72, lon: 2.11, elevation: 160 };

function homePolls(r: Rng, start: number, duration: number): Poll[] {
  const aircraft = Array.from({ length: r.int(2, 12) }, (_, i) => {
    const jet = r.next() < 0.5;
    const flyby: Flyby = {
      closestAt: start + r.uniform(-60, duration + 60),
      offset: r.pick([-1, 1]) * r.uniform(200, 15000),
      heading: r.uniform(0, 360),
      speed: jet ? r.uniform(110, 240) : r.uniform(35, 90),
      altitude: HOME.elevation + (jet ? r.uniform(800, 11000) : r.uniform(200, 2500)),
      turnRate: r.gauss(0.2),
    };
    return { hex: `h${i}`, truth: truthOf(HOME, flyby, start - 120, start + duration + 60), meta: {} };
  });
  return pollsFrom(r, HOME, aircraft, start - 6, start + duration);
}

const truthOf = (at: Listener, f: Flyby, from: number, to: number): Track => buildTrack(flybyFixes(at, f, from, to, 0.5), at, { smooth: false })!;

/** Another place's sky: the polls the page makes (three, 3 s apart) and the true tracks of the minutes around. */
export type Sky = { name: string; centre: Listener; air: Air; live: Poll[]; history: (from: number, to: number) => Poll[] };

const TYPES: [string, string][] = [
  ["EC35", "A7"],
  ["AS50", "A7"],
  ["R44", "A7"],
  ["C172", "A1"],
  ["P28A", "A1"],
  ["SR22", "A1"],
  ["AT72", "A2"],
  ["DH8D", "A2"],
  ["A320", "A3"],
  ["B738", "A3"],
];

/** Made-up flights over a city: one low near the centre in the last two minutes, others anywhere within 25 km. */
export function syntheticSky(seed: number): Sky {
  const r = rng(seed * 104_729 + 7);
  const centre: Listener = { lat: 37.9755, lon: 23.7348, elevation: 70 };
  const last = 1_800_000_000 + seed * 1000;
  const flights = Array.from({ length: r.int(3, 12) }, (_, i) => {
    const [type, category] = i === 0 ? r.pick(TYPES.slice(0, 8)) : r.pick(TYPES);
    const jet = category === "A3";
    const flyby: Flyby = {
      closestAt: i === 0 ? last - r.uniform(-20, 100) : last + r.uniform(-300, 200),
      offset: r.pick([-1, 1]) * (i === 0 ? r.uniform(0, 5000) : r.uniform(500, 25000)),
      heading: r.uniform(0, 360),
      speed: jet ? r.uniform(80, 200) : category === "A7" ? r.uniform(30, 70) : r.uniform(45, 110),
      altitude: centre.elevation + (jet ? r.uniform(600, 9000) : category === "A7" ? r.uniform(150, 700) : r.uniform(300, 2500)),
      turnRate: r.next() < 0.3 ? r.gauss(1) : r.gauss(0.1),
    };
    return { hex: `s${seed}x${i}`, truth: truthOf(centre, flyby, last - 600, last + 300), meta: { t: type, category, flight: `TST${i}${seed}` } };
  });
  const live = pollsFrom(r, centre, flights, last - 6, last + 0.5, 3, 0);
  return { name: "synthetic", centre, air: { groundTempC: r.uniform(5, 30) }, live, history: (from, to) => pollsFrom(rng(seed), centre, flights, from, to, 2, 0.05) };
}

const SKY_DIR = new URL("../fixtures/sky/", import.meta.url);
/** Rough ground height of each recorded area, metres (as evals/lib/tracks.ts). */
const GROUND: Record<string, number> = { phoenix: 340, daytona: 10 };

/** Real polls recorded from adsb.lol (evals/fixtures/sky): three around a random moment, the rest as the true history. */
export function recordedSkies(count: number, seed = 1): Sky[] {
  if (!existsSync(SKY_DIR)) return [];
  const out: Sky[] = [];
  for (const file of readdirSync(SKY_DIR).filter((f) => /\.jsonl(\.gz)?$/.test(f)).sort()) {
    const raw = readFileSync(new URL(file, SKY_DIR));
    const lines = (file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
    const header = lines[0].header as { name: string; lat: number; lon: number };
    const centre: Listener = { lat: header.lat, lon: header.lon, elevation: GROUND[header.name] ?? 0 };
    // What the API route answers: within 16 nautical miles of the centre.
    const near = (p: Poll): Poll => ({ now: p.now, aircraft: p.aircraft.filter((a) => a.lat !== undefined && a.lon !== undefined && Math.hypot(...toLocal(centre, a.lat, a.lon, 0).slice(0, 2)) < 29_600) });
    const polls = (lines.slice(1) as Poll[]).map(near);
    const r = rng(seed + file.length);
    for (let i = 0, tries = 0; i < count && tries < count * 20; tries++) {
      // Three polls about 3 s apart, at a moment with ten minutes of recording around it.
      const k = r.int(0, polls.length - 1);
      const lastAt = polls[k].now;
      if (lastAt - polls[0].now < 300_000 || polls[polls.length - 1].now - lastAt < 60_000) continue;
      // The recording has gaps: only polls of the last 8 s count, as the page's would.
      const recent = (back: number) => polls.findLast((p) => p.now <= lastAt - back && p.now >= lastAt - 8000);
      const live = [...new Set([recent(6000), recent(3000), polls[k]])].filter((p): p is Poll => !!p);
      if (live.length < 3) continue;
      out.push({
        name: `${header.name}-${i++}`,
        centre,
        air: { groundTempC: 20 },
        live,
        history: (from, to) => polls.filter((p) => p.now >= from * 1000 && p.now <= to * 1000),
      });
    }
  }
  return out;
}

export type ElsewhereCase = {
  id: string;
  scene: Scene;
  /** The voice note as made at home, at the analysis rate. */
  voice: Float32Array;
  /** The faintest planting the page's analysis names strongly: its level, the mix, that analysis. */
  fit: Fit;
  /** All the planted planes together against the voice note, dB. */
  underVoice: number;
  /** At the fake spot with the true tracks of that minute, 3 km from it, and at home. */
  real: Recording;
  aside: Recording;
  home: Recording;
};

export async function elsewhereCase(sky: Sky, seed: number): Promise<ElsewhereCase | null> {
  const r = rng(seed * 31 + 3);
  const duration = r.pick([30, 45, 60]);
  const scene = planScene(sky.live, sky.centre, duration, sky.air, { seed });
  if (!scene) return null;
  const voice = voiceLike(r, duration, ANALYSIS_RATE, r.uniform(30, 55));
  const found = await fit(voice, scene);
  const aside = r.uniform(0, 2 * Math.PI);
  const planes = found.samples.map((v, i) => v - voice[i]);
  const base = { samples: found.samples, sampleRate: ANALYSIS_RATE, start: scene.start, air: sky.air };
  return {
    id: `${sky.name}-${seed}`,
    scene,
    voice,
    fit: found,
    underVoice: 20 * Math.log10(loudness(planes) / loudness(voice)),
    real: { ...base, listener: scene.spot, polls: sky.history(scene.start - 50, scene.start + duration) },
    aside: { ...base, listener: { ...fromLocal(scene.spot, 3000 * Math.sin(aside), 3000 * Math.cos(aside)), elevation: scene.spot.elevation }, polls: scene.polls },
    home: { ...base, listener: HOME, polls: homePolls(r, scene.start, duration) },
  };
}

/**
 * Whether two hexes in these polls are one aircraft: adsb.lol lists some twice, once from the
 * aircraft and once as a TIS-B copy (`~hex`), on the same path. Within 500 m of each other in
 * most of the polls that have both.
 */
export function twins(polls: Poll[], a: string, b: string): boolean {
  let both = 0;
  let close = 0;
  for (const p of polls) {
    const x = p.aircraft.find((c) => c.hex === a);
    const y = p.aircraft.find((c) => c.hex === b);
    if (x?.lat === undefined || x.lon === undefined || y?.lat === undefined || y.lon === undefined) continue;
    both++;
    const [e, n] = toLocal({ lat: x.lat, lon: x.lon, elevation: 0 }, y.lat, y.lon, 0);
    if (Math.hypot(e, n) < 500) close++;
  }
  return both > 0 && close >= 0.8 * both;
}
