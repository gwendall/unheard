// Somewhere else: a recording made here, given the sky of another place. The page polls the live
// flights over that place two or three times; planScene() picks a listening spot near its centre
// that one of them passes within a few kilometres of, and plant() mixes under the recording the
// sound of every flight around as heard from that spot: blade-pass, rotor or fan tones by type
// with their harmonics, the level falling with distance, each sound late by its own travel time,
// the Doppler factor of the moment it left the aircraft (heardAt, through synthesize). It is the
// physics Unheard matches with, so analyze() run at that spot names the planted plane, as anyone
// running a Doppler geolocation on the file would.

import { collect, type AircraftMeta, type Poll } from "../adsb";
import { heardAt, type Air } from "../core/doppler";
import { fromLocal, toLocal, type Listener } from "../core/geo";
import { STRONG } from "../core/match";
import { analyze, ANALYSIS_RATE, type Analysis } from "../core/pipeline";
import { computeSpectrogram, median } from "../core/spectrogram";
import { synthesize } from "../core/synth";
import { buildTrack, stateAt, type Fix, type Track } from "../core/track";
import { polled } from "./fabricate";
import { aircraftType, type Kind } from "./types";

/** Places to sound like, at their centres. Their names are in messages/<code>.json (elsewhere.places). */
export const PLACES = {
  athens: { lat: 37.9755, lon: 23.7348 },
  london: { lat: 51.5074, lon: -0.1278 },
  newYork: { lat: 40.758, lon: -73.9855 },
  paris: { lat: 48.8566, lon: 2.3522 },
  tokyo: { lat: 35.6812, lon: 139.7671 },
  saoPaulo: { lat: -23.5505, lon: -46.6333 },
  losAngeles: { lat: 34.0522, lon: -118.2437 },
  mexicoCity: { lat: 19.4326, lon: -99.1332 },
  lisbon: { lat: 38.7223, lon: -9.1393 },
  sydney: { lat: -33.8688, lon: 151.2093 },
  berlin: { lat: 52.52, lon: 13.405 },
  rome: { lat: 41.9028, lon: 12.4964 },
} as const satisfies Record<string, { lat: number; lon: number }>;
export type PlaceId = keyof typeof PLACES;

type Sound = { f0: [number, number]; harmonics: number[]; level: number };

/**
 * What each kind of aircraft hums at, as it leaves the aircraft. Propellers: the blade pass, 2 to
 * 6 blades at 1,200 to 2,700 rpm. Rotors: the main rotor's beat, 2 to 5 blades at 300 to 400 rpm,
 * rich in harmonics. Jets: the fan's blade pass (their roar is broadband and draws no curve).
 * `level` is the fundamental's amplitude at 1 km, relative between kinds.
 */
export const SOUNDS: Record<Kind, Sound> = {
  piston: { f0: [75, 125], harmonics: [1, 0.7, 0.5, 0.35, 0.25], level: 0.6 },
  turboprop: { f0: [95, 140], harmonics: [1, 0.6, 0.4, 0.25], level: 0.8 },
  helicopter: { f0: [20, 30], harmonics: [0.6, 1, 0.9, 0.75, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2], level: 1 },
  jet: { f0: [1000, 1800], harmonics: [1, 0.3], level: 0.3 },
};

/** The kind of a flight: its type when known, else its ADS-B category, else its speed. */
export function kindOf(meta: AircraftMeta, speed: number): Kind {
  const known = aircraftType(meta.type)?.kind;
  if (known) return known;
  if (meta.category === "A7") return "helicopter";
  if (meta.category === "A1") return "piston";
  if (meta.category === "A2") return "turboprop";
  if (/^A[3-6]$/.test(meta.category ?? "")) return "jet";
  return speed > 110 ? "jet" : "piston";
}

/** A number in [0, 1) from a text: the same aircraft hums at the same pitch every time. */
function unit(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100_000) / 100_000;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const RAD = Math.PI / 180;
/** A turn the polls show is kept up this long either way, seconds; beyond, the flight goes straight. */
const TURN_FOR = 30;

/**
 * Where a flight is at any moment near its polls, by dead reckoning from its last report: its
 * ground speed, its climb rate, and the turn its reports show. Exact at the last poll; for a
 * flight going steadily, a few tens of metres off a minute away.
 */
export function motionOf(fixes: Fix[], centre: Listener): (t: number) => Fix {
  const first = fixes[0];
  const last = fixes[fixes.length - 1];
  const [ve, vn, vu] = last.velocity;
  const speed = Math.hypot(ve, vn);
  const heading = Math.atan2(ve, vn);
  let turn = 0;
  const span = last.t - first.t;
  if (span >= 2 && speed > 5 && Math.hypot(first.velocity[0], first.velocity[1]) > 5) {
    const was = Math.atan2(first.velocity[0], first.velocity[1]);
    turn = clamp(Math.atan2(Math.sin(heading - was), Math.cos(heading - was)) / span, -3 * RAD, 3 * RAD);
    if (Math.abs(turn) < 0.1 * RAD) turn = 0;
  }
  const climb = clamp(vu, -15, 15);
  const [e0, n0] = toLocal(centre, last.lat, last.lon, last.altitude);
  const floor = centre.elevation + 30;
  return (t) => {
    const dt = t - last.t;
    const bent = clamp(dt, -TURN_FOR, TURN_FOR);
    const h = heading + turn * bent;
    let e = e0 + speed * Math.sin(h) * (dt - bent);
    let n = n0 + speed * Math.cos(h) * (dt - bent);
    if (turn) {
      e += (speed / turn) * (Math.cos(heading) - Math.cos(h));
      n += (speed / turn) * (Math.sin(h) - Math.sin(heading));
    } else {
      e += speed * Math.sin(heading) * bent;
      n += speed * Math.cos(heading) * bent;
    }
    const up = last.altitude + climb * dt;
    const { lat, lon } = fromLocal(centre, e, n);
    return { t, lat, lon, altitude: Math.max(floor, up), velocity: [speed * Math.sin(h), speed * Math.cos(h), up > floor ? climb : 0] };
  };
}

export type PlanOptions = {
  /** Farthest the spot may be from the centre, metres. */
  reach?: number;
  /** Farthest back the clip's middle may be moved from the last poll, seconds. */
  shiftMax?: number;
  /** Picks the side of the path the spot is on: another seed, another spot. */
  seed?: number;
};

export type Planted = {
  meta: AircraftMeta;
  kind: Kind;
  /** In the spot's frame, from a minute before the clip to its end. */
  track: Track;
  f0: number;
  harmonics: number[];
  level: number;
  /** Its closest moment in the clip, as heard: distance and height when the sound left it, UTC seconds it reached the spot, the delay. */
  closest: { range: number; height: number; at: number; delay: number };
};

export type Scene = {
  /** The listening spot the curves point to. */
  spot: Listener;
  /** UTC seconds of the first sample. */
  start: number;
  duration: number;
  air: Air;
  /** The flight the spot was chosen for first, then every other one close enough to be heard. */
  planted: Planted[];
  /** The flight data of the clip's span, every flight every 2 s: what analyze() is given. */
  polls: Poll[];
  /** Seconds from the clip's middle back to the last poll. */
  shift: number;
  /** From the centre to the spot: metres, degrees from north. */
  offset: { distance: number; bearing: number };
};

/** A flight is planted when it comes this close during the clip, metres; at most MAX_PLANTED of them. */
const HEARD_WITHIN = 12_000;
const MAX_PLANTED = 8;
/** How much each kind is worth as the flight to plant: propellers and rotors draw the clearest curves. */
const WEIGHT: Record<Kind, number> = { helicopter: 1, piston: 1, turboprop: 0.95, jet: 0.4 };

type Flight = { meta: AircraftMeta; at: (t: number) => Fix; speed: number; kind: Kind };

/**
 * The scene a recording of `duration` seconds would have caught under these polls, heard from a
 * spot within `reach` of the centre: for each moment the clip's middle may take (the last poll,
 * then every 10 s back to `shiftMax`), and each flight moving low enough (150 m to 3 km above the
 * ground), the spot beside its path where it passes closest at that moment, about as far to the
 * side as it is high, and with no other flight beside it. The best by kind, distance, shift and
 * closeness to the centre wins. Null when no flight passes low enough near the centre.
 */
export function planScene(live: Poll[], centre: Listener, duration: number, air: Air, options: PlanOptions = {}): Scene | null {
  const { reach = 8000, shiftMax = 120, seed = 1 } = options;
  if (!live.length) return null;
  const last = Math.max(...live.map((p) => p.now)) / 1000;
  const flights: Flight[] = [];
  for (const s of collect(live).values()) {
    if (!s.fixes.length) continue;
    const v = s.fixes[s.fixes.length - 1].velocity;
    const speed = Math.hypot(v[0], v[1]);
    flights.push({ meta: s.meta, at: motionOf(s.fixes, centre), speed, kind: kindOf(s.meta, speed) });
  }

  let best: { score: number; flight: Flight; middle: number; e: number; n: number; shift: number } | null = null;
  for (let shift = 0; shift <= shiftMax; shift += 10) {
    const middle = last - shift;
    for (const flight of flights) {
      if (flight.speed < 20) continue;
      // The sound heard at the middle left the flight about a slant range / c earlier.
      const m = flight.at(middle);
      const high = m.altitude - centre.elevation;
      const p = flight.at(middle - Math.max(300, high * 1.4) / 340);
      const height = p.altitude - centre.elevation;
      if (height < 150 || height > 3000) continue;
      const side = (unit(`${flight.meta.hex}:${seed}`) < 0.5 ? -1 : 1) * clamp(height, 250, 2000);
      const [pe, pn] = toLocal(centre, p.lat, p.lon, p.altitude);
      const [ve, vn] = p.velocity;
      // To the right of its heading (left when side < 0).
      const e = pe + (side * vn) / flight.speed;
      const n = pn - (side * ve) / flight.speed;
      const distance = Math.hypot(e, n);
      if (distance > reach) continue;
      const slant = Math.hypot(side, height);
      // Another flight within a kilometre of it (a formation, or the TIS-B copy `~hex` adsb.lol
      // lists beside some aircraft) would draw the same curve, and the matcher could not tell them apart.
      const [fe, fn, fu] = toLocal(centre, m.lat, m.lon, m.altitude);
      const twin = flights.some((o) => {
        if (o === flight) return false;
        const q = o.at(middle);
        const [qe, qn, qu] = toLocal(centre, q.lat, q.lon, q.altitude);
        return Math.hypot(qe - fe, qn - fn, qu - fu) < 1000;
      });
      if (twin) continue;
      const score = WEIGHT[flight.kind] - 0.15 * (slant / 1000) - 0.3 * (shift / Math.max(1, shiftMax)) - 0.3 * (distance / reach) + 0.01 * unit(`${flight.meta.hex}:${shift}:${seed}`);
      if (!best || score > best.score) best = { score, flight, middle, e, n, shift };
    }
  }
  if (!best) return null;

  const spot: Listener = { ...fromLocal(centre, best.e, best.n), elevation: centre.elevation };
  const start = best.middle - duration / 2;
  const around = (f: Flight) => {
    const fixes: Fix[] = [];
    for (let t = start - 60; t <= start + duration + 10; t += 0.5) fixes.push(f.at(t));
    return buildTrack(fixes, spot, { smooth: false })!;
  };
  const plantedOf = (f: Flight, track: Track, closest: Planted["closest"]): Planted => {
    const sound = SOUNDS[f.kind];
    const f0 = sound.f0[0] + (sound.f0[1] - sound.f0[0]) * unit(f.meta.hex);
    return { meta: f.meta, kind: f.kind, track, f0, harmonics: sound.harmonics, level: sound.level, closest };
  };
  const primaryTrack = around(best.flight);
  const primaryClosest = closestOf(primaryTrack, start, duration, air);
  if (!primaryClosest) return null;
  const others: Planted[] = [];
  for (const f of flights) {
    if (f === best.flight) continue;
    const track = around(f);
    const closest = closestOf(track, start, duration, air);
    if (closest && closest.range < HEARD_WITHIN) others.push(plantedOf(f, track, closest));
  }
  others.sort((a, b) => a.closest.range - b.closest.range);
  const planted = [plantedOf(best.flight, primaryTrack, primaryClosest), ...others.slice(0, MAX_PLANTED - 1)];

  const polls: Poll[] = [];
  for (let t = Math.floor(start - 50); t <= start + duration; t += 2) {
    polls.push({ now: Math.round(t * 1000), aircraft: flights.map((f) => polled(f.meta, f.at(t))) });
  }
  const offset = { distance: Math.hypot(best.e, best.n), bearing: ((Math.atan2(best.e, best.n) / RAD + 360) % 360) };
  return { spot, start, duration, air, planted, polls, shift: best.shift, offset };
}

function closestOf(track: Track, start: number, duration: number, air: Air): Planted["closest"] | null {
  let best: Planted["closest"] | null = null;
  for (let t = start; t <= start + duration; t += 0.5) {
    const h = heardAt(track, t, air);
    if (!h || (best && h.range >= best.range)) continue;
    const s = stateAt(track, h.emitted);
    if (s) best = { range: h.range, height: s.p[2], at: t, delay: t - h.emitted };
  }
  return best;
}

/** The planted flights alone, `n` samples at `rate` from the scene's start. Gain 1 is each kind's own level. */
export function planesOf(scene: Scene, rate: number, n: number, gain = 1, only?: number): Float32Array {
  const chosen = only === undefined ? scene.planted : [scene.planted[only]];
  const sources = chosen.map((p) => ({ track: p.track, f0: p.f0, harmonics: p.harmonics, level: p.level * gain }));
  return synthesize({ start: scene.start, duration: n / rate, sampleRate: rate, air: scene.air, sources });
}

/**
 * How loud the planted flights sit. The first one's strongest harmonic, at its closest, stands
 * `above` dB over the recording's own background in its band, as the analysis sees it (2 s
 * windows): far under the voice, out of earshot, plain on a spectrogram, as a real plane's hum
 * is. A recording cleaner than `floor` dB under its loudest sample (a file made on a computer)
 * counts as that noisy: a WAV's 16 bits still keep the tone. And all the planes together stay
 * `under` dB under the recording, whatever its background.
 */
export const MIX = { above: 18, floor: 80, under: 30 };

export function gainFor(voice: Float32Array, rate: number, scene: Scene, above = MIX.above): number {
  const { base, cap } = levelOf(voice, rate, scene, planesOf(scene, rate, voice.length));
  return Math.min(base * 10 ** (above / 20), cap);
}

/** The gain that puts the first flight 0 dB over the background, and the most `under` allows, for `planes` (gain 1). */
function levelOf(voice: Float32Array, rate: number, scene: Scene, planes: Float32Array): { base: number; cap: number } {
  const primary = scene.planted[0];
  let h = 0;
  for (let i = 1; i < primary.harmonics.length; i++) if (primary.harmonics[i] > primary.harmonics[h]) h = i;
  let lo = Infinity;
  let hi = -Infinity;
  for (let t = scene.start; t <= scene.start + scene.duration; t += 1) {
    const heard = heardAt(primary.track, t, scene.air);
    if (!heard) continue;
    lo = Math.min(lo, heard.factor);
    hi = Math.max(hi, heard.factor);
  }
  const cap = (loudness(voice) * 10 ** (-MIX.under / 20)) / (loudness(planes) + 1e-12);
  if (!Number.isFinite(lo)) return { base: 0, cap };
  const tone = (h + 1) * primary.f0;
  const band = { windowSeconds: 2, hopSeconds: 0.5, minHz: Math.max(20, tone * lo - 4), maxHz: tone * hi + 4 };
  const mine = computeSpectrogram(voice, rate, band);
  const alone = computeSpectrogram(planesOf(scene, rate, voice.length, 1, 0), rate, band);
  if (!mine.frames || !alone.frames) return { base: 0, cap };
  let peak = -Infinity;
  for (const v of alone.db) peak = Math.max(peak, v);
  let loudest = 0;
  for (const v of voice) loudest = Math.max(loudest, Math.abs(v));
  // White noise of this RMS puts sigma^2 * sum(hann^2) = sigma^2 * 0.375 * N in each bin.
  const size = rate / mine.binHz;
  const floor = 10 * Math.log10((loudest * 10 ** (-MIX.floor / 20)) ** 2 * 0.375 * size + 1e-30);
  return { base: 10 ** ((Math.max(median(mine.db), floor) - peak) / 20), cap };
}

/** RMS of a signal. */
export function loudness(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / Math.max(1, x.length));
}

/** The recording with the planted flights under it, at the recording's own rate. */
export function plant(voice: Float32Array, rate: number, scene: Scene, gain: number): Float32Array {
  const out = planesOf(scene, rate, voice.length, gain);
  for (let i = 0; i < out.length; i++) out[i] += voice[i];
  return out;
}

/** Levels tried, dB over the background (gainFor): the faintest the matcher names strongly is kept. */
export const LEVELS = [9, 12, 15, 18, 21];

export type Fit = {
  /** dB over the background (gainFor), and the gain it took. */
  above: number;
  gain: number;
  /** The planted flights alone at that gain, and with the voice, at ANALYSIS_RATE. */
  planes: Float32Array;
  samples: Float32Array;
  analysis: Analysis;
};

/**
 * When the planting is loud enough: strong, with this much to spare over the matcher's STRONG
 * (lib/core/match.ts). Someone checking with the true tracks of that minute instead of the page's
 * dead reckoning scores the curve a little lower. evals/somewhere-else, 36 scenes, 3 Nov 2026:
 * no spare, 75 % strong with the true tracks; this one, 89 %; 3 and 2, 89 % too, but louder, and
 * the louder the planting, the more often the matcher at the real spot names a plane of its own
 * sky strongly (6, 22 and 31 %), borrowing part of the planted line.
 */
export const SPARE = { score: 1.5, lead: 1 };

/**
 * The faintest planting Unheard's own analyze(), run at the spot with the scene's flight data,
 * names strongly as one of the planted flights: no louder than it takes to point there. `voice`
 * at ANALYSIS_RATE. The loudest level tried when none is strong.
 */
export async function fit(voice: Float32Array, scene: Scene, onStep?: (above: number) => void): Promise<Fit> {
  // The planes are synthesised once: the mix is linear in their gain.
  const unit = planesOf(scene, ANALYSIS_RATE, voice.length);
  const { base, cap } = levelOf(voice, ANALYSIS_RATE, scene, unit);
  let out: Fit | null = null;
  for (const above of LEVELS) {
    onStep?.(above);
    const gain = Math.min(base * 10 ** (above / 20), cap);
    const planes = unit.map((v) => v * gain);
    const samples = planes.map((v, i) => v + voice[i]);
    const analysis = await analyze({ samples, sampleRate: ANALYSIS_RATE, start: scene.start, listener: scene.spot, air: scene.air, polls: scene.polls });
    out = { above, gain, planes, samples, analysis };
    const best = analysis.verdict.best;
    const second = analysis.verdict.ranked[1]?.score ?? 0;
    if (best && scene.planted.some((p) => p.meta.hex === best.id) && best.score >= STRONG.score + SPARE.score && best.score - second >= STRONG.lead + SPARE.lead) break;
    // Under the voice's limit already: louder is not allowed.
    if (gain === cap) break;
  }
  return out!;
}

/** "37.98, 23.73", "37,98; 23,73" or "37.98 23.73": latitude and longitude, or null. */
export function parseCoords(text: string): { lat: number; lon: number } | null {
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1].replace(",", "."));
  const lon = Number(m[2].replace(",", "."));
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}
