// Scenarios and measurements for the ghost eval (evals/ghost.eval.ts): how far the lines no
// aircraft of the data explains (analyze().unexplained) can be believed. Three groups: nothing to
// find (no aircraft in the sound), heard (the plane is in the sound and in the data), left out
// (the plane is in the sound, not in the data). Every run goes through the production analyze().

import { heardAt } from "../../lib/core/doppler";
import { GHOST, readLine, sameCurve, toleranceOf, type Line } from "../../lib/core/explain";
import { norm } from "../../lib/core/geo";
import { candidatesOf, type Analysis, type Recording } from "../../lib/core/pipeline";
import { stateAt } from "../../lib/core/track";
import { ambientScenarios } from "./ambient";
import { voiceAlone } from "./elsewhere";
import { aerosonicScenarios, bundleScenarios, livermoreScenarios } from "./real";
import { rng, scene, type Scenario } from "./sim";
import { syntheticScenario } from "./synthetic";
import { trackScenarios } from "./tracks";

export type Group = "empty" | "heard" | "left";
export type Corpus = "synthetic" | "tracks" | "voice" | "ambient" | "aerosonic" | "livermore" | "capture";

export type GhostCase = {
  id: string;
  corpus: Corpus;
  group: Group;
  recording: Recording;
  /** Real audio: the heard run whose matched curve is this left-out run's truth. */
  pairOf?: string;
  /** Real audio: the aircraft of the data whose matched curve is the truth. */
  target?: string;
  scenario?: Scenario;
};

export type Pass = { range: number; speed: number };

export type LineRow = {
  confidence: number;
  seconds: number;
  /** Aircraft of the data that explain it (the production check). */
  by: number;
  /** Share of it the free flyby follows, and the most of it any aircraft of the data follows at a tone of its own. */
  share: number;
  shape: number;
  /** Read as a straight pass, m/s and m (lines no aircraft explains only). */
  speed: number | null;
  distance: number | null;
  fromS: number;
  toS: number;
  hzFrom: number;
  hzTo: number;
  /** The heard aircraft's true curve follows half of it or more, at any tone. */
  isTrue: boolean;
  /** The page tells it (analyze().ghosts). */
  shown: boolean;
};

export type Row = { id: string; corpus: Corpus; group: Group; seen: number; verdict: string; duration: number; findable: number | null; pass: Pass | null; truthKnown: boolean; lines: LineRow[]; ms: number };

/** The curve the heard aircraft leaves in the recording, per base frame. */
export type TruthCurve = { factor: ArrayLike<number>; pass: Pass | null };

export function oracleCurve(s: Scenario, times: ArrayLike<number>): TruthCurve | null {
  const o = s.oracle;
  if (!o) return null;
  const factor = new Float32Array(times.length).fill(NaN);
  let range = Infinity;
  let speed = 0;
  for (let k = 0; k < times.length; k++) {
    const h = heardAt(o.truth, o.start + times[k], o.air);
    if (!h) continue;
    factor[k] = h.factor;
    if (h.range < range) {
      range = h.range;
      const state = stateAt(o.truth, h.emitted);
      if (state) speed = norm([state.v[0], state.v[1], 0]);
    }
  }
  return { factor, pass: Number.isFinite(range) ? { range, speed } : null };
}

/** The target's curve as the matcher placed it (its best clock) when it is in the data. */
export function matchedCurve(a: Analysis, rec: Recording, hex: string): TruthCurve | null {
  const m = a.verdict.ranked.find((x) => x.id === hex);
  if (!m) return null;
  let pass: Pass | null = null;
  if (m.closest) {
    const c = candidatesOf(rec.polls, rec.listener).find((x) => x.id === hex);
    const state = c && stateAt(c.track, rec.start + m.closest.heardAt + m.clock - m.closest.delay);
    if (state) pass = { range: m.closest.range, speed: norm([state.v[0], state.v[1], 0]) };
  }
  return { factor: m.factor, pass };
}

export function rowOf(a: Analysis, rec: Recording, line: Line, truth: TruthCurve | null, shown: boolean): LineRow {
  const t = line.trace;
  const times = a.spec.times;
  const r = (x: number, d = 100) => Math.round(x * d) / d;
  const read = line.by.length ? null : readLine(t, times, rec.air);
  return {
    confidence: r(t.confidence),
    seconds: r(t.seconds),
    by: line.by.length,
    share: r(line.flyby.share),
    shape: r(line.shape),
    speed: read?.speed ?? null,
    distance: read ? Math.round(read.distance) : null,
    fromS: r(times[t.from], 10),
    toS: r(times[t.to], 10),
    hzFrom: Math.round(t.freq[t.from]),
    hzTo: Math.round(t.freq[t.to]),
    isTrue: truth ? sameCurve(t, truth.factor, toleranceOf(t)) >= 0.5 : false,
    shown,
  };
}

/** Every case, lazily (real audio is heavy), in the order that lets a left-out run read its plane's curve from its heard run. */
export function* ghostCases(parts: Set<string>, seeds: number, perFile: number, voices: number): Generator<GhostCase> {
  if (parts.has("synthetic")) {
    const plan = [
      ...Array.from({ length: seeds }, (_, i) => ["heard", i] as const),
      ...Array.from({ length: Math.ceil(seeds / 2) }, (_, i) => ["noise", 1000 + i] as const),
      ...Array.from({ length: Math.ceil(seeds / 2) }, (_, i) => ["missing", 2000 + i] as const),
      ...Array.from({ length: Math.ceil(seeds / 5) }, (_, i) => ["two", 3000 + i] as const),
    ];
    for (const [kind, seed] of plan) {
      const s = syntheticScenario(seed, kind);
      yield { id: s.id, corpus: "synthetic", group: kind === "noise" ? "empty" : kind === "missing" ? "left" : "heard", recording: s.recording, scenario: s };
    }
  }
  if (parts.has("tracks")) {
    for (const [i, s] of trackScenarios(perFile).entries()) {
      yield { id: s.id, corpus: "tracks", group: "heard", recording: s.recording, scenario: s };
      const polls = s.recording.polls.map((p) => ({ now: p.now, aircraft: p.aircraft.filter((x) => x.hex !== s.truth.heard) }));
      yield { id: s.id.replace("trk-", "trk-left-"), corpus: "tracks", group: "left", recording: { ...s.recording, polls }, scenario: s };
      // The same sky over an acoustic scene with no aircraft in it.
      const o = s.oracle!;
      const samples = scene(rng(i * 977 + 11), o.start, s.recording.samples.length / s.recording.sampleRate, [], o.air);
      yield { id: s.id.replace("trk-", "trk-empty-"), corpus: "tracks", group: "empty", recording: { ...s.recording, samples } };
    }
  }
  if (parts.has("voice")) {
    for (let seed = 1; seed <= voices; seed++) yield { id: `voice-${seed}`, corpus: "voice", group: "empty", recording: voiceAlone(seed) };
  }
  if (parts.has("ambient")) {
    for (const s of ambientScenarios()) yield { id: s.id, corpus: "ambient", group: s.plane ? "left" : "empty", recording: s.recording };
  }
  // The same street sound cut into shorter recordings, a check on the bar (not in the default corpus).
  if (parts.has("ambient60")) {
    for (const s of ambientScenarios(20, 60)) if (!s.plane) yield { id: `${s.id}-60`, corpus: "ambient", group: "empty", recording: s.recording };
  }
  if (parts.has("real")) {
    for (const s of [...aerosonicScenarios(), ...livermoreScenarios()]) {
      const corpus: Corpus = s.id.startsWith("asdb-") ? "aerosonic" : "livermore";
      const left = s.id.includes("-missing-");
      yield { id: s.id, corpus, group: left ? "left" : "heard", recording: s.recording, pairOf: left ? s.id.replace("-missing-", "-") : undefined, target: left ? undefined : (s.truth.heard ?? undefined) };
    }
    for (const s of bundleScenarios()) yield { id: s.id, corpus: "capture", group: s.truth.heard ? "heard" : "empty", recording: s.recording, target: s.truth.heard ?? undefined };
  }
}

export type GroupRates = {
  empty: { n: number; told: number };
  heard: { n: number; told: number; own: number };
  /** Told: anything told at all; right: the line of the plane left out. */
  left: { n: number; told: number; right: number; findable: number; findableRight: number };
  emptyRate: number;
  heardRate: number;
  leftRate: number;
};

const ratio = (k: number, n: number) => (n ? Math.round((k / n) * 1000) / 1000 : 0);
const told = (r: Row) => r.lines.some((l) => l.shown);
const toldRight = (r: Row) => r.lines.some((l) => l.shown && l.isTrue);

export function ratesOf(rows: Row[], tells = told, tellsRight = toldRight): GroupRates {
  const empty = rows.filter((r) => r.group === "empty");
  const heard = rows.filter((r) => r.group === "heard");
  const left = rows.filter((r) => r.group === "left" && r.truthKnown);
  // Findable: the matcher scores it as a match when it is in the data (real audio), or a perfect model stands out as much (made-up sound).
  const findable = left.filter((r) => (r.findable ?? 0) >= 6.5);
  return {
    empty: { n: empty.length, told: empty.filter(tells).length },
    heard: { n: heard.length, told: heard.filter(tells).length, own: heard.filter(tellsRight).length },
    left: { n: left.length, told: left.filter(tells).length, right: left.filter(tellsRight).length, findable: findable.length, findableRight: findable.filter(tellsRight).length },
    emptyRate: ratio(empty.filter(tells).length, empty.length),
    heardRate: ratio(heard.filter(tells).length, heard.length),
    leftRate: ratio(left.filter(tellsRight).length, left.length),
  };
}

const GENERATED = new Set<Corpus>(["synthetic", "tracks", "voice"]);

export function summaryOf(rows: Row[]) {
  const corpora = [...new Set(rows.map((r) => r.corpus))];
  // How well the pass read from a line told matches the true pass: within a factor of 2.
  const reads = rows.flatMap((r) => (r.group === "left" && r.pass ? r.lines.filter((l) => l.shown && l.isTrue).map((l) => ({ l, pass: r.pass! })) : []));
  const within = (a: number | null, b: number) => a !== null && a > b / 2 && a < b * 2;
  const noTruth = rows.filter((r) => r.group === "left" && !r.truthKnown);
  return {
    all: ratesOf(rows),
    generated: ratesOf(rows.filter((r) => GENERATED.has(r.corpus))),
    real: ratesOf(rows.filter((r) => !GENERATED.has(r.corpus))),
    byCorpus: Object.fromEntries(corpora.map((c) => [c, ratesOf(rows.filter((r) => r.corpus === c))])),
    /** Planes around a human's label, no flight data, the line not known: how often something is told. */
    planesNoTruth: { n: noTruth.length, told: noTruth.filter(told).length },
    flyby: { n: reads.length, speed: reads.filter(({ l, pass }) => within(l.speed, pass.speed)).length, distance: reads.filter(({ l, pass }) => within(l.distance, pass.range)).length },
  };
}

type Bar = typeof GHOST;

/** Whether a line passes a bar. The page's own answer is `shown`; this is for the table of other bars (no dedupe needed: it only asks whether anything is told). */
const passes = (l: LineRow, b: Bar) => !l.by && l.share >= b.share && l.confidence >= b.confidence && l.shape < b.shape && (l.distance ?? 0) >= b.distance;

export function ghostReport(rows: Row[], s: ReturnType<typeof summaryOf>): string {
  const row = (name: string, r: GroupRates) => `| ${name} | ${r.empty.told} / ${r.empty.n} | ${r.heard.told} / ${r.heard.n} | ${r.heard.own} / ${r.heard.n} | ${r.left.right} / ${r.left.n} | ${r.left.findableRight} / ${r.left.findable} |`;
  const bars: [string, Bar][] = [
    ["the bar", GHOST],
    ["no share", { ...GHOST, share: 0 }],
    ["no shape", { ...GHOST, shape: 2 }],
    ["no distance", { ...GHOST, distance: 0 }],
    ["distance 150", { ...GHOST, distance: 150 }],
    ["distance 500", { ...GHOST, distance: 500 }],
    ["confidence 10", { ...GHOST, confidence: 10 }],
    ["confidence 15", { ...GHOST, confidence: 15 }],
    ["confidence 30", { ...GHOST, confidence: 30 }],
  ];
  const list = rows.flatMap((r) => r.lines.filter((l) => l.shown).map((l) => `| ${r.id} | ${r.group} | ${r.findable ?? ""} | ${l.isTrue ? "yes" : "no"} | ${l.fromS} to ${l.toS} | ${l.hzFrom} to ${l.hzTo} | ${l.confidence} | ${l.share} | ${l.shape} | ${l.speed} | ${l.distance} |`));
  return [
    "# Eval ghost",
    "",
    `${new Date().toISOString()}, ${rows.length} recordings. Bar: ${JSON.stringify(GHOST)}.`,
    "",
    "| corpus | nothing to find: told | plane in the data: anything told | plane in the data: its own line told | plane left out: its line told | same, findable |",
    "|---|---|---|---|---|---|",
    ...Object.entries(s.byCorpus).map(([name, r]) => row(name, r)),
    row("all made-up sound", s.generated),
    row("all real sound", s.real),
    row("all", s.all),
    "",
    `Planes around a human's label, no flight data at all (the line is not known): something told in ${s.planesNoTruth.told} of ${s.planesNoTruth.n}.`,
    "",
    `The pass read from a true line told, against the real pass: speed within a factor of 2 in ${s.flyby.speed} of ${s.flyby.n}, closest distance in ${s.flyby.distance} of ${s.flyby.n}.`,
    "",
    "Other bars, the same recordings:",
    "",
    "| bar | nothing to find: told | plane in the data: anything told | plane in the data: its own line told | plane left out: its line told | same, findable |",
    "|---|---|---|---|---|---|",
    ...bars.map(([name, b]) => row(name, ratesOf(rows, (r) => r.lines.some((l) => passes(l, b)), (r) => r.lines.some((l) => passes(l, b) && l.isTrue)))),
    "",
    "| id | group | findable | its plane's line | heard s | Hz | confidence | share | shape | speed m/s | distance m |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...list,
    "",
  ].join("\n");
}
