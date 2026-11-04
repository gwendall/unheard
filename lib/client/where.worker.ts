// The where page's work, off the page's thread: find the tones, load the flights of the day and
// the area, search (lib/core/wherewhen.ts), and shape what the page shows. The file's sound stays
// here and never leaves the device: only tile requests for that day and area go out.

import { toneOf, pictureOf, readerOf, viewOf, type Picture, type Reader, type Tone, type View } from "../core/leak";
import { toLocal, norm, type Listener } from "../core/geo";
import { ANALYSIS_RATE } from "../core/pipeline";
import { estimator, stagesOf, type Estimate } from "../core/progress";
import { findSegmentsWith, here } from "../core/flyby";
import { flybys, whereWhen, type Answer, type BestSoFar } from "../core/wherewhen";
import { loadFlights, type Flight } from "../history";
import { groundOf } from "../terrain";
import { cachedFetcher, cachedTiles } from "./cached";
import { stretchesOf, wherePiecesOf, withPool, type Pool } from "./pool";
import type { PieceInput, PieceOutput } from "./piece.worker";
import { daysOf, distinctAnswers, partsOf, passesOf, type WherePart } from "./where";

export type WhereRequest = {
  channels: Float32Array[];
  sampleRate: number;
  /** Where the flight tiles are, absolute (a worker has no page to resolve against). */
  history: string;
  window: [number, number];
  area: { lat: number; lon: number; side: number };
  /** Also send what appears before the end: each tone as it is found, the best guess so far. */
  partial?: boolean;
  /** Told by the page: the workers go by a phone's budget. */
  phone?: boolean;
};

export type WhereStep = "find" | "flights" | "search" | "refine";

/** The plane that explains a tone at a guess, and when and how close it passed there. */
export type Plane = { hex: string; registration: string; type: string; metres: number; at: number; tone: number };
/** A plane's path around its pass, metres east and north of the guess. */
export type PlanePath = { hex: string; points: [number, number][]; closest: [number, number] };
/** A tone of the file, as the page draws it. */
export type ToneView = { tone: Tone; picture: Picture };
export type Guess = { lat: number; lon: number; start: number; mirror: { lat: number; lon: number } | null; planes: Plane[]; paths: PlanePath[] };

export type WhereResult =
  | { kind: "none" }
  | { kind: "missing"; day: string }
  /** `passes`: how many separate passes the tones make. An empty `guesses`: no flight fits. */
  | { kind: "found"; passes: number; tones: number; confident: boolean; guesses: Guess[]; views: Record<number, ToneView> };

/** What comes before the end when the request asks (`partial`). */
export type WherePartial =
  /** Every tone found so far that the page calls an aircraft tone on its own, and where each lies. */
  | { type: "tones"; tones: { tone: Tone; view: View }[] }
  /** The best guess so far, which the search may still drop. */
  | { type: "best"; best: BestSoFar };

export type WhereEvent =
  /** `done` of `total` within the step; `fraction` and `secondsLeft` for the whole job (lib/core/progress.ts). */
  | ({ type: "progress"; step: WhereStep; done: number; total: number } & Estimate)
  | { type: "result"; result: WhereResult } | { type: "error"; message: string };

// The worker's own global, typed by what this file uses of it (the DOM and webworker libs clash).
const scope = self as unknown as { postMessage: (event: WhereEvent | WherePartial) => void; onmessage: ((e: MessageEvent<WhereRequest>) => void) | null };
const post = (event: WhereEvent | WherePartial) => scope.postMessage(event);

/** The first and the last of the job's parts each step covers. */
const STEP_PARTS: Record<WhereStep, [WherePart, WherePart]> = { find: ["find", "find"], flights: ["flights", "flights"], search: ["shape", "joint"], refine: ["fine", "fine"] };

/** Guesses shown, and tones drawn under each. */
const GUESSES = 3;
const TONES_DRAWN = 8;
const FT = 0.3048;
/**
 * What the page calls an aircraft tone on its own, like the check (lib/core/leak.ts). The search
 * reads up to 3.4 kHz, for jets, but that range alone finds a line in half of white-noise files.
 */
const REPORTED_HZ = 400;

/** A plane's closest pass and its path around it, during a tone heard at a spot. */
function passOf(f: Flight, listener: Listener, from: number, to: number): { metres: number; at: number; path: PlanePath } | null {
  let metres = Infinity;
  let at = 0;
  let closest: [number, number] = [0, 0];
  const points: [number, number][] = [];
  for (let j = 0; j < f.t.length; j++) {
    if (f.t[j] < from - 30 || f.t[j] > to + 30) continue;
    const p = toLocal(listener, f.lat[j], f.lon[j], f.altFt[j] * FT);
    points.push([Math.round(p[0]), Math.round(p[1])]);
    const d = norm(p);
    if (d < metres) {
      metres = d;
      at = f.t[j];
      closest = [Math.round(p[0]), Math.round(p[1])];
    }
  }
  return points.length > 1 ? { metres, at, path: { hex: f.hex, points, closest } } : null;
}

function guessOf(a: Answer, byHex: Map<string, Flight>, tones: Tone[], ground: (lat: number, lon: number) => number): Guess {
  const listener: Listener = { lat: a.lat, lon: a.lon, elevation: ground(a.lat, a.lon) };
  const planes = new Map<string, Plane>();
  const paths = new Map<string, PlanePath>();
  for (const p of a.planes) {
    const f = byHex.get(p.hex);
    const tone = tones[p.trace];
    if (!f || !tone) continue;
    const pass = passOf(f, listener, a.start + tone.times[0], a.start + tone.times[tone.times.length - 1]);
    if (!pass) continue;
    // A plane once, at the tone it passes closest in, with the path of that pass.
    if (!planes.has(p.hex) || pass.metres < planes.get(p.hex)!.metres) {
      planes.set(p.hex, { hex: p.hex, registration: p.registration, type: p.type, metres: pass.metres, at: pass.at, tone: p.trace });
      paths.set(p.hex, pass.path);
    }
  }
  return { lat: a.lat, lon: a.lon, start: a.start, mirror: a.mirror && { lat: a.mirror.lat, lon: a.mirror.lon }, planes: [...planes.values()].sort((x, y) => x.at - y.at), paths: [...paths.values()] };
}

function viewsOf(guesses: Guess[], tones: Tone[], read: Reader, length: number, duration: number): Record<number, ToneView> {
  const views: Record<number, ToneView> = {};
  for (const g of guesses) {
    for (const p of g.planes.slice(0, TONES_DRAWN)) {
      if (views[p.tone]) continue;
      views[p.tone] = { tone: tones[p.tone], picture: pictureOf(read, length, viewOf(tones[p.tone], duration)) };
    }
  }
  return views;
}

async function search({ channels, sampleRate, history, window, area, partial }: WhereRequest, pool: Pool<PieceInput, PieceOutput> | null): Promise<WhereResult> {
  const { read, length } = readerOf({ channels, sampleRate });
  const duration = length / ANALYSIS_RATE;
  const fractionOf = stagesOf(partsOf(duration, pool?.size ?? 1));
  const estimate = estimator(() => performance.now() / 1000, fractionOf("fine", 0));
  /** Where the job stands: how far into the step, and the whole job's bar and time left. */
  const report = (step: WhereStep, part: WherePart, share: number) => {
    const fraction = fractionOf(part, share);
    const [first, last] = STEP_PARTS[step];
    const from = fractionOf(first, 0);
    const done = Math.round((100 * (fraction - from)) / (fractionOf(last, 1) - from));
    post({ type: "progress", step, done, total: 100, ...estimate(fraction) });
  };
  report("find", "find", 0);
  const samples = read(0, length);
  const so: Tone[] = [];
  const { segments, searched } = await findSegmentsWith(pool ? stretchesOf(pool) : here, samples, ANALYSIS_RATE, undefined, undefined, {
    onProgress: (share) => report("find", "find", share),
    onSegment: (g) => {
      if (!partial) return;
      so.push(...g.traces.map((t) => toneOf(t, g.stack.base.times, g.offset)));
      post({ type: "tones", tones: so.filter((t) => t.freq[t.freq.length >> 1] <= REPORTED_HZ).map((tone) => ({ tone, view: viewOf(tone, duration) })) });
    },
  });
  // In the order wherewhen numbers them: Explained.trace is an index into this list.
  const tones = segments.flatMap((g) => g.traces.map((t) => toneOf(t, g.stack.base.times, g.offset)));
  if (!tones.length) return { kind: "none" };
  const heard = flybys(segments);
  const low = heard.filter((h) => h.f0 <= REPORTED_HZ);
  const passes = passesOf((low.length ? low : heard).map((h) => h.closest));

  report("flights", "flights", 0);
  const days = daysOf(window, duration);
  const { flights, missing } = await loadFlights(cachedFetcher(history), days, area, undefined, (done, total) => report("flights", "flights", done / Math.max(1, total)));
  if (missing.length === days.length) return { kind: "missing", day: missing[0] };
  // The ground's height, from our own file next to the flights; flat if it fails.
  const tiles = cachedTiles(history);
  const ground = await groundOf((z, x, y) => tiles(z, x, y).catch(() => null), area.lat, area.lon, area.side);

  report("search", "shape", 0);
  const found = await whereWhen(segments, flights, {
    pieces: pool ? wherePiecesOf(pool) : undefined,
    window,
    area,
    ground,
    searched,
    onProgress: (stage, done, total) => report(stage === "fine" ? "refine" : "search", stage, done / Math.max(1, total)),
    onBest: partial ? (best) => post({ type: "best", best }) : undefined,
  });
  // Only lines above the propellers' range, and nothing that convinces: no tone to speak of.
  if (!low.length && !found.confident) return { kind: "none" };
  const byHex = new Map(flights.map((f) => [f.hex, f]));
  const guesses = distinctAnswers(found.answers, found.confident ? 1 : GUESSES).map((a) => guessOf(a, byHex, tones, ground));
  return { kind: "found", passes, tones: tones.length, confident: found.confident, guesses, views: viewsOf(guesses, tones, read, length, duration) };
}

scope.onmessage = (e: MessageEvent<WhereRequest>) => {
  const { channels, sampleRate, phone } = e.data;
  withPool({ kind: "search", seconds: (channels[0]?.length ?? 0) / sampleRate }, phone, (pool) => search(e.data, pool)).then(
    (result) => post({ type: "result", result }),
    (err: unknown) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }),
  );
};
