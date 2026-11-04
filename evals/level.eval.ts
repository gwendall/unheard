import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import type { AircraftMeta, Poll } from "../lib/adsb";
import { decodeWav } from "../lib/bundle";
import { follow, toleranceOf, type Line } from "../lib/core/explain";
import type { Match } from "../lib/core/match";
import { analyze, ANALYSIS_RATE, type Analysis, type Recording } from "../lib/core/pipeline";
import { resample } from "../lib/core/resample";
import { computeSpectrogram, WINDOWS } from "../lib/core/spectrogram";
import { fixesOf } from "../lib/history";
import { elsewhereCase, recordedSkies, syntheticSky } from "./lib/elsewhere";
import { historyAround, indexedDays } from "./lib/history";
import { aerosonicScenarios, livermoreScenarios } from "./lib/real";

// Can the level of a tone tell the plane that made it from a plane whose curve merely follows it?
// A far plane's range barely moves, so a tone that rises and falls should not be its own, and the
// phone's gain does not matter for the shape over time. This measures that, and no verdict reads
// it: on real audio it did not separate (docs/STATUS.md, Next #2). Reads the level along the line
// a match rides on, against -20 log10(range) and the air's absorption, for the plane's own range, a
// far plane's (14.4 km, 200 m/s, closest at the line's middle) and the line's own straight flyby.
// ONLY=real,colsto,home,jet picks parts (default: all; what is not in the cache gives nothing).
// Writes evals/reports/level.md, which names no position. Never commit colsto's or AeroSonicDB's
// audio or tracks; the report holds numbers only. Never in CI: minutes of real audio.

const parts = new Set((process.env.ONLY ?? "real,colsto,home,jet").split(","));
const STEP = 2;
const SMOOTH = 2;
const MIN_SNR = 3;
const MIN_FRAMES = 16;
const FLAT = 1.5;
const K = 5;

const quant = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const p = q * (s.length - 1);
  const i = Math.floor(p);
  return s[i] + (p - i) * ((s[Math.min(s.length - 1, i + 1)] ?? s[i]) - s[i]);
};
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");

/** ISO 9613-1 at 15 °C, 70 % humidity, dB/km, log-log between octave bands. */
const BANDS = [[63, 0.12], [125, 0.41], [250, 1.04], [500, 1.93], [1000, 3.66], [2000, 9.66], [4000, 32.8]];
function absorption(f: number): number {
  if (f <= BANDS[0][0]) return BANDS[0][1] * (f / BANDS[0][0]) ** 2;
  for (let i = 1; i < BANDS.length; i++) {
    if (f > BANDS[i][0]) continue;
    const x = Math.log(f / BANDS[i - 1][0]) / Math.log(BANDS[i][0] / BANDS[i - 1][0]);
    return Math.exp(Math.log(BANDS[i - 1][1]) + x * Math.log(BANDS[i][1] / BANDS[i - 1][1]));
  }
  return BANDS[BANDS.length - 1][1];
}

type Level = { times: number[]; freq: number[]; tone: number[]; floor: number[] };

/** The stack keeps only its evidence: the powers of each of its layers, computed again for this measure. */
const powersOf = (rec: Recording) => WINDOWS.map((windowSeconds) => computeSpectrogram(rec.samples, rec.sampleRate, { windowSeconds, hopSeconds: 0.25, minHz: 20, maxHz: 3800 }).db);

/** Power in a band around the line, the noise beside it taken out, per other frame, averaged over 2 s; the layer by the line's slope, as the matcher reads. */
function levelOf(a: Analysis, powers: Float32Array[], line: Line): Level {
  const { base, layers } = a.stack;
  const trace = line.trace;
  const raw = { tone: [] as number[], floor: [] as number[], freq: [] as number[], times: [] as number[] };
  for (let k = 0; k < base.frames; k += STEP) {
    const f = trace.freq[k];
    raw.times.push(base.times[k]);
    raw.freq.push(f);
    if (!Number.isFinite(f)) {
      raw.tone.push(NaN);
      raw.floor.push(NaN);
      continue;
    }
    const a0 = Number.isFinite(trace.freq[k - STEP]) ? trace.freq[k - STEP] : f;
    const b0 = Number.isFinite(trace.freq[k + STEP]) ? trace.freq[k + STEP] : f;
    const slope = Math.log2(Math.abs((b0 - a0) / (2 * STEP * (base.times[1] - base.times[0]))) + 1e-9);
    const li = Math.min(layers.length - 1, Math.max(0, Math.round(1 + 0.5 * slope)));
    const { spec, index, window } = layers[li];
    const db = powers[li];
    const reach = Math.max(1, Math.ceil(Math.max(0.5, 0.0015 * f) / spec.binHz));
    const centre = Math.round((f - spec.minHz) / spec.binHz);
    if (centre - reach < 0 || centre + reach >= spec.bins) {
      raw.tone.push(NaN);
      raw.floor.push(NaN);
      continue;
    }
    const at = index[k] * spec.bins;
    let sum = 0;
    for (let b = centre - reach; b <= centre + reach; b++) sum += 10 ** (db[at + b] / 10);
    const beside: number[] = [];
    const wide = reach + Math.max(8, Math.ceil((0.02 * f) / spec.binHz));
    for (let b = Math.max(0, centre - wide); b <= Math.min(spec.bins - 1, centre + wide); b++) if (Math.abs(b - centre) > reach + 1) beside.push(db[at + b]);
    // The median of a power is 0.693 of its mean; 10.67 / N^2 turns a Hann window's band power into an amplitude squared.
    const noise = ((2 * reach + 1) * 10 ** (quant(beside, 0.5) / 10)) / 0.693;
    const scale = 10.67 / (window * ANALYSIS_RATE) ** 2;
    raw.tone.push(Math.max(0, sum - noise) * scale);
    raw.floor.push(noise * scale);
  }
  const smooth = (xs: number[]) =>
    xs.map((_, i) => {
      let s = 0;
      let c = 0;
      for (let j = Math.max(0, i - SMOOTH); j <= Math.min(xs.length - 1, i + SMOOTH); j++) {
        if (Number.isNaN(xs[j])) continue;
        s += xs[j];
        c++;
      }
      return c && s > 0 ? 10 * Math.log10(s / c) : c ? -200 : NaN;
    });
  return { times: raw.times, freq: raw.freq, tone: smooth(raw.tone), floor: smooth(raw.floor) };
}

type Read = { swing: number; ranges: { rms: number; swing: number }[] };

/** The level's swing (10th to 90th percentile, a tone under its floor counted at the floor) and how each range explains the frames it stands out on. */
function read(l: Level, ranges: number[][], from = 0, to = l.times.length - 1): Read | null {
  const up: number[] = [];
  const clipped: number[] = [];
  for (let i = from; i <= to; i++) {
    if (!Number.isFinite(l.tone[i]) || !Number.isFinite(l.floor[i]) || !Number.isFinite(l.freq[i]) || ranges.some((r) => !Number.isFinite(r[i]))) continue;
    if (l.tone[i] - l.floor[i] >= MIN_SNR) up.push(i);
    clipped.push(Math.max(l.tone[i], l.floor[i]));
  }
  if (up.length < MIN_FRAMES) return null;
  return {
    swing: quant(clipped, 0.9) - quant(clipped, 0.1),
    ranges: ranges.map((r) => {
      const lost = (i: number) => 20 * Math.log10(r[i]) + (absorption(l.freq[i]) * r[i]) / 1000;
      const mid = quant(up.map((i) => l.tone[i] + lost(i)), 0.5);
      const all: number[] = [];
      for (let i = from; i <= to; i++) if (Number.isFinite(r[i]) && Number.isFinite(l.freq[i])) all.push(-lost(i));
      return { rms: Math.sqrt(up.reduce((s, i) => s + (l.tone[i] + lost(i) - mid) ** 2, 0) / up.length), swing: quant(all, 0.9) - quant(all, 0.1) };
    }),
  };
}

/** The straight flyby's range per frame, from the line's own fit (flybyFit), at the speed of sound in beta. */
function flybyRange(line: Line, times: number[]): number[] {
  const { beta, T, t0 } = line.flyby;
  let tau = times[0] - beta * T;
  return times.map((t) => {
    for (let n = 0; n < 20; n++) {
      const u = (tau - t0) / T;
      const q = Math.sqrt(1 + u * u);
      const step = (tau + beta * T * q - t) / (1 + (beta * u) / q);
      tau -= step;
      if (Math.abs(step) < 1e-5) break;
    }
    return beta * 340 * T * Math.sqrt(1 + ((tau - t0) / T) ** 2);
  });
}

/** The line a match follows the most. */
function rideOf(a: Analysis, m: Match<AircraftMeta>): Line | null {
  let best: Line | null = null;
  let most = 0;
  for (const line of a.lines) {
    const n = follow(line.trace, m.f0, m.factor, toleranceOf(line.trace)).count;
    if (n > most) {
      most = n;
      best = line;
    }
  }
  return best;
}

type Curve = { id: string; plane: string; near: number; level: Level; own: number[]; fly: number[]; far: number[]; score: number };

function curveOf(id: string, a: Analysis, rec: Recording, m: Match<AircraftMeta>): Curve | null {
  const line = rideOf(a, m);
  if (!line) return null;
  const level = levelOf(a, powersOf(rec), line);
  const own = level.times.map((_, i) => m.range[i * STEP]);
  const middle = a.spec.times[(line.trace.from + line.trace.to) >> 1];
  return { id, plane: m.id, near: m.closest?.range ?? NaN, level, own, fly: flybyRange(line, level.times), far: level.times.map((t) => Math.hypot(14_400, 200 * (t - middle))), score: m.score };
}

type Named = { id: string; verdict: string; score: number; plane: string; type: string; f0: number; near: number; known: number; seconds: number; row: Row | null };

type Row = { id: string; length: number; flat: boolean; near: number; swing: number; own: number; rmsOwn: number; rmsFly: number; rmsFar: number; farSwing: number };

function rowsOf(c: Curve, lengths: number[]): Row[] {
  const out: Row[] = [];
  const n = c.level.times.length;
  const hop = c.level.times[1] - c.level.times[0];
  const add = (length: number, from: number, to: number) => {
    const r = read(c.level, [c.own, c.fly, c.far], from, to);
    if (!r) return;
    const [own, fly, far] = r.ranges;
    out.push({ id: c.id, length, flat: own.swing < FLAT, near: c.near, swing: r.swing, own: own.swing, rmsOwn: own.rms, rmsFly: fly.rms, rmsFar: far.rms, farSwing: far.swing });
  };
  add(0, 0, n - 1);
  for (const length of lengths) {
    const w = Math.round(length / hop);
    for (let from = 0; from + w <= n; from += Math.round(10 / hop)) add(length, from, from + w - 1);
  }
  return out;
}

/** Second candidate: the level between two planes' lines against the ranges between them, where both read. */
function correlation(a: Curve, b: Curve): number {
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < a.level.times.length; i++) {
    const up = (c: Curve) => c.level.tone[i] - c.level.floor[i] >= MIN_SNR && Number.isFinite(c.level.freq[i]) && Number.isFinite(c.own[i]);
    if (!up(a) || !up(b)) continue;
    const lost = (c: Curve) => 20 * Math.log10(c.own[i]) + (absorption(c.level.freq[i]) * c.own[i]) / 1000;
    x.push(a.level.tone[i] - b.level.tone[i]);
    y.push(lost(b) - lost(a));
  }
  if (x.length < MIN_FRAMES) return NaN;
  const mean = (v: number[]) => v.reduce((s, q) => s + q, 0) / v.length;
  const [mx, my] = [mean(x), mean(y)];
  let [xy, xx, yy] = [0, 0, 0];
  for (let i = 0; i < x.length; i++) {
    xy += (x[i] - mx) * (y[i] - my);
    xx += (x[i] - mx) ** 2;
    yy += (y[i] - my) ** 2;
  }
  return xy / Math.sqrt(xx * yy + 1e-9);
}

async function colstoCuts(each: (id: string, rec: Recording) => Promise<void>) {
  const dir = new URL("./.cache/colsto/", import.meta.url);
  if (!existsSync(new URL("audio-8k.wav", dir)) || !indexedDays().has("2026-09-08")) return;
  const truth = JSON.parse(readFileSync(new URL("truth.json", dir), "utf8")) as { lat: number; lon: number; start: number };
  const wav = decodeWav(new Uint8Array(readFileSync(new URL("audio-8k.wav", dir))));
  const { flights } = await historyAround(["2026-09-08"], truth.lat, truth.lon, 40_000);
  const listener = { lat: truth.lat, lon: truth.lon, elevation: 30 };
  const LENGTH = 150;
  for (let from = 0; from + LENGTH <= wav.samples.length / wav.sampleRate; from += 120) {
    const start = truth.start + from;
    const polls: Poll[] = flights
      .flatMap((f) =>
        fixesOf(f, start - 40, start + LENGTH + 10).map((x) => ({
          now: x.t * 1000,
          aircraft: [{ hex: f.hex, t: f.type, r: f.registration, lat: x.lat, lon: x.lon, alt_geom: x.altitude / 0.3048, gs: Math.hypot(x.velocity[0], x.velocity[1]) * (3600 / 1852), track: ((Math.atan2(x.velocity[0], x.velocity[1]) * 180) / Math.PI + 360) % 360, geom_rate: x.velocity[2] * (60 / 0.3048), seen_pos: 0 }],
        })),
      )
      .sort((a, b) => a.now - b.now);
    await each(`colsto-${from}`, { samples: wav.samples.slice(Math.round(from * wav.sampleRate), Math.round((from + LENGTH) * wav.sampleRate)), sampleRate: wav.sampleRate, start, listener, air: { groundTempC: 24 }, polls });
  }
}

/** The fake microphone's recording of the E2E (scripts/make-e2e-fixture.ts) with the plane heard left out, its polls from the first sample on, as the page's would be. */
async function jetCuts(each: (id: string, rec: Recording) => Promise<void>) {
  const dir = new URL("../e2e/fixtures/", import.meta.url);
  if (!existsSync(new URL("flyby.wav", dir))) return;
  const wav = decodeWav(new Uint8Array(readFileSync(new URL("flyby.wav", dir))));
  const fixture = JSON.parse(readFileSync(new URL("flyby-polls.json", dir), "utf8")) as { listener: Recording["listener"]; target: string; polls: { poll: Poll }[] };
  const samples = resample(wav.samples, wav.sampleRate, ANALYSIS_RATE);
  const T0 = 1_800_000_000;
  const without = fixture.polls.map((p) => ({ now: p.poll.now, aircraft: p.poll.aircraft.filter((a) => a.hex !== fixture.target) }));
  for (const [from, shift, length] of [[0, 0, 50], [2, 0, 50], [0, 0.7, 50]]) {
    const start = T0 + from + shift;
    const polls = without.filter((p) => p.now / 1000 <= start + length && p.now / 1000 >= start).filter((_, i) => i % 2 === 0);
    await each(`e2e-${from}-${shift}-${length}`, { samples: samples.slice(Math.round(from * ANALYSIS_RATE), Math.round((from + length) * ANALYSIS_RATE)), sampleRate: ANALYSIS_RATE, start, listener: fixture.listener, air: { groundTempC: 15 }, polls });
  }
}

it("the level of a tone against the range of a plane", async () => {
  const right: Row[] = [];
  let shortest = Infinity;
  const wrong: Named[] = [];
  const strongs: Named[] = [];
  const pairs: string[] = [];
  const known = (a: Analysis, m: Match<AircraftMeta>) => m.range.reduce((n, r) => n + (Number.isFinite(r) ? 1 : 0), 0) * (a.spec.times[1] - a.spec.times[0]);
  const rowOf = (id: string, a: Analysis, rec: Recording, m: Match<AircraftMeta>): Named => {
    const c = curveOf(id, a, rec, m);
    const r = c && rowsOf(c, [])[0];
    return { id, verdict: a.verdict.kind, score: m.score, plane: m.id, type: m.meta.type ?? "?", f0: m.f0, near: m.closest?.range ?? NaN, known: known(a, m), seconds: a.spec.times[a.spec.times.length - 1] + 1, row: r || null };
  };
  const wrongOf = async (id: string, rec: Recording) => {
    const a = await analyze(rec);
    const m = a.verdict.ranked[0];
    if (m && m.score >= 6.5) wrong.push(rowOf(id, a, rec, m));
  };
  if (parts.has("real")) {
    for (const s of [...aerosonicScenarios(), ...livermoreScenarios()]) {
      if (s.truth.heard === null) {
        await wrongOf(s.id, s.recording);
        continue;
      }
      const a = await analyze(s.recording);
      const m = a.verdict.ranked[0];
      if (m?.id !== s.truth.heard || m.score < 9) continue;
      shortest = Math.min(shortest, known(a, m));
      const c = curveOf(s.id, a, s.recording, m);
      if (c) right.push(...rowsOf(c, [60, 45, 30]));
      const other = a.verdict.ranked[1];
      const c2 = other && other.score >= 6.5 ? curveOf(s.id, a, s.recording, other) : null;
      if (c && c2) pairs.push(`${s.id}: with ${other.meta.type ?? other.id} at ${f1(other.score)}, level difference against range difference, correlation ${f2(correlation(c, c2))}`);
    }
  }
  // Its hour has no truth for most planes: its strongs are shown, never used for a margin.
  if (parts.has("colsto")) await colstoCuts(async (id, rec) => {
    const a = await analyze(rec);
    if (a.verdict.kind === "strong") strongs.push(rowOf(id, a, rec, a.verdict.best!));
  });
  if (parts.has("jet")) await jetCuts(wrongOf);
  if (parts.has("home")) {
    const N = Number(process.env.SEEDS ?? 15);
    for (const [i, sky] of [...Array.from({ length: N }, (_, n) => syntheticSky(n + 1)), ...recordedSkies(N)].entries()) {
      const c = await elsewhereCase(sky, i + 1);
      if (c) await wrongOf(`home-${c.id}`, c.home);
    }
  }

  const whole = right.filter((r) => r.length === 0);
  const pct = (xs: Row[], f: (r: Row) => number) => `${f1(quant(xs.map(f), 0.5))} / ${f1(quant(xs.map(f), 0.9))} / ${f1(Math.max(...xs.map(f)))}`;
  const windows = [0, 60, 45, 30].map((length) => {
    const here = right.filter((r) => r.length === length);
    const flat = here.filter((r) => r.flat);
    const v1 = Math.max(...here.map((r) => r.swing - K * r.own));
    const v2 = Math.max(...here.map((r) => r.rmsOwn - r.rmsFly));
    const name = length ? `${length} s` : "whole";
    return {
      length,
      v1,
      v2,
      line: `| ${name} | ${new Set(here.map((r) => r.id)).size} | ${here.length} | ${pct(here, (r) => r.swing)} | ${flat.length ? pct(flat, (r) => r.swing) : "-"} | ${f1(v1)} | ${f2(here.filter((r) => r.swing - K * r.farSwing > v1).length / here.length)} | ${f2(v2)} | ${f2(here.filter((r) => r.rmsFar - r.rmsFly > v2).length / here.length)} |`,
    };
  });
  const TABLE = "| id | verdict | plane | score | tone Hz | closest m | curve known s | level swing | range swing | rms own | rms flyby | V1 whole | V2 whole | V1 30 s | V2 30 s |";
  const TABLE_RULE = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const yes = (x: boolean) => (x ? "caught" : "no");
  const cells = (w: Named) => {
    const head = `| ${w.id} | ${w.verdict} | ${w.type} | ${f2(w.score)} | ${f1(w.f0)} | ${Math.round(w.near)} | ${f1(w.known)} of ${f1(w.seconds)}`;
    const r = w.row;
    if (!r) return `${head} | no line to read | | | | | | | |`;
    const [a, b] = [windows[0], windows[3]];
    return `${head} | ${f1(r.swing)} | ${f1(r.own)} | ${f1(r.rmsOwn)} | ${f1(r.rmsFly)} | ${yes(r.swing - K * r.own > a.v1)} | ${yes(r.rmsOwn - r.rmsFly > a.v2)} | ${yes(r.swing - K * r.own > b.v1)} | ${yes(r.rmsOwn - r.rmsFly > b.v2)} |`;
  };
  const md = [
    "# Eval level",
    "",
    `${new Date().toISOString()}. Right: the plane heard, best, score 9 or more, on real audio. V1: level swing past ${K} times the range's, margin set to lose none of them. V2: the line's own flyby explains the level better than the plane's range, in dB rms, the same. "Far" is how often each would catch a far plane's range on those same real lines.`,
    "",
    `Whole recordings: level swing over range swing ${f1(quant(whole.map((r) => r.swing / r.own), 0.5))} (median), ${f1(quant(whole.map((r) => r.swing / r.own), 0.9))} (p90), ${f1(Math.max(...whole.map((r) => r.swing / r.own)))} (max). dB rms around own range ${f1(quant(whole.map((r) => r.rmsOwn), 0.5))}, a far plane's ${f1(quant(whole.map((r) => r.rmsFar), 0.5))}, the flyby's ${f1(quant(whole.map((r) => r.rmsFly), 0.5))}.`,
    "",
    "| window | recordings | windows | level swing p50 / p90 / max, dB | the same where the range moves under 1.5 dB | V1 margin | V1 far | V2 margin | V2 far |",
    "|---|---|---|---|---|---|---|---|---|",
    ...windows.map((w) => w.line),
    "",
    `Two planes read in one recording: ${pairs.length} (${pairs.join("; ") || "none"}).`,
    "",
    `The shortest curve known of a right plane above: ${f1(shortest)} s.`,
    "",
    "Wrong planes (score 6.5 or more with nothing of theirs to hear), against the whole-recording margins and the 30 s ones:",
    "",
    TABLE,
    TABLE_RULE,
    ...wrong.map(cells),
    "",
    "colsto's hour, every strong (2.5 minutes every 2 minutes, flights at or under 10,000 ft; no truth for most planes):",
    "",
    TABLE,
    TABLE_RULE,
    ...strongs.map(cells),
  ].join("\n");
  const dir = new URL("./reports/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("level.md", dir), md + "\n");
  console.log(md);
}, 14_400_000);
