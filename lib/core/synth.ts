// Synthetic recordings: the physics run forward. The tests use them to check that the matcher
// finds the right aircraft among others, and the page uses one as its example.

import { heardAt, type Air } from "./doppler";
import { fromLocal, type Listener, type Vec3 } from "./geo";
import type { Fix, Track } from "./track";

export type Source = {
  track: Track;
  /** Emitted fundamental, Hz. */
  f0: number;
  /** Relative amplitude of the fundamental and its harmonics. */
  harmonics?: number[];
  /** Amplitude of the fundamental heard from 1 km away. */
  level: number;
};

export type SynthOptions = {
  /** UTC seconds of the first sample. */
  start: number;
  duration: number;
  sampleRate: number;
  air: Air;
  sources: Source[];
  /** RMS of white noise (hiss, distant traffic). */
  noise?: number;
  /** RMS of low-passed noise (wind, rumble), concentrated below ~150 Hz. */
  rumble?: number;
  /** Steady tones that never move (mains hum, a fridge, ventilation). */
  hum?: { freq: number; level: number }[];
  /** Passing sounds that sweep in pitch (cars, mopeds, birds): linear chirps. */
  chirps?: { at: number; duration: number; from: number; to: number; level: number }[];
  /** Short loud broadband sounds (a door, a gust, a voice). */
  bursts?: { at: number; duration: number; level: number }[];
  seed?: number;
};

function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next());
}

export function synthesize(o: SynthOptions): Float32Array {
  const n = Math.round(o.duration * o.sampleRate);
  const out = new Float32Array(n);
  const gauss = random(o.seed ?? 1);
  // The emission time moves smoothly: solve it every 10 ms and interpolate in between.
  const step = Math.max(1, Math.round(o.sampleRate / 100));
  for (const src of o.sources) {
    const harmonics = src.harmonics ?? [1, 0.5, 0.3];
    const knots = Math.ceil(n / step) + 1;
    const emitted = new Float64Array(knots).fill(NaN);
    const range = new Float64Array(knots).fill(NaN);
    for (let j = 0; j < knots; j++) {
      const h = heardAt(src.track, o.start + (j * step) / o.sampleRate, o.air);
      if (h) {
        emitted[j] = h.emitted;
        range[j] = h.range;
      }
    }
    for (let i = 0; i < n; i++) {
      const j = Math.floor(i / step);
      const f = (i - j * step) / step;
      const e = emitted[j] + f * (emitted[j + 1] - emitted[j]);
      const r = range[j] + f * (range[j + 1] - range[j]);
      if (!Number.isFinite(e) || !Number.isFinite(r)) continue;
      const amp = (src.level * 1000) / Math.max(100, r);
      const phase = 2 * Math.PI * src.f0 * (e - o.start);
      let v = 0;
      for (let h = 0; h < harmonics.length; h++) v += harmonics[h] * Math.sin((h + 1) * phase + h);
      out[i] += amp * v;
    }
  }
  const noise = o.noise ?? 0;
  const rumble = o.rumble ?? 0;
  const alpha = 1 - Math.exp((-2 * Math.PI * 150) / o.sampleRate);
  // A one-pole low-pass of white noise keeps alpha / (2 - alpha) of its power.
  const rumbleGain = rumble / Math.sqrt(alpha / (2 - alpha));
  let low = 0;
  for (let i = 0; i < n; i++) {
    low += alpha * (gauss() - low);
    let v = noise * gauss() + rumbleGain * low;
    for (const h of o.hum ?? []) v += h.level * Math.sin((2 * Math.PI * h.freq * i) / o.sampleRate);
    out[i] += v;
  }
  for (const c of o.chirps ?? []) {
    const a = Math.round(c.at * o.sampleRate);
    const len = Math.round(c.duration * o.sampleRate);
    for (let j = 0; j < len && a + j < n; j++) {
      const t = j / o.sampleRate;
      const env = Math.sin((Math.PI * j) / len);
      out[a + j] += c.level * env * Math.sin(2 * Math.PI * (c.from * t + ((c.to - c.from) * t * t) / (2 * c.duration)));
    }
  }
  for (const b of o.bursts ?? []) {
    const a = Math.round(b.at * o.sampleRate);
    const len = Math.round(b.duration * o.sampleRate);
    for (let j = 0; j < len && a + j < n; j++) out[a + j] += b.level * Math.sin((Math.PI * j) / len) * gauss();
  }
  return out;
}

export type Flyby = {
  /** UTC seconds when the aircraft is closest to the listener. */
  closestAt: number;
  /** Horizontal distance at that moment, metres; negative passes on the other side. */
  offset: number;
  /** Degrees from north. */
  heading: number;
  /** Ground speed, m/s. */
  speed: number;
  /** Metres above sea level. */
  altitude: number;
  /** Degrees per second; a turn keeps a curve from having a mirror twin. */
  turnRate?: number;
};

/** ADS-B-like fixes along a flyby, one every `every` seconds from `from` to `to`. */
export function flybyFixes(listener: Listener, flyby: Flyby, from: number, to: number, every = 2): Fix[] {
  const rad = Math.PI / 180;
  const turn = flyby.turnRate ?? 0;
  // Integrate the path from the closest point, forward and backward, in 0.1 s steps.
  const dt = 0.1;
  const at = (t: number): { p: Vec3; v: Vec3 } => {
    const h0 = flyby.heading * rad;
    let e = flyby.offset * Math.cos(h0);
    let n = -flyby.offset * Math.sin(h0);
    const steps = Math.round(Math.abs(t - flyby.closestAt) / dt);
    const sign = t >= flyby.closestAt ? 1 : -1;
    for (let i = 0; i < steps; i++) {
      const h = (flyby.heading + turn * sign * (i + 0.5) * dt) * rad;
      e += sign * flyby.speed * Math.sin(h) * dt;
      n += sign * flyby.speed * Math.cos(h) * dt;
    }
    const h = (flyby.heading + turn * (t - flyby.closestAt)) * rad;
    return { p: [e, n, flyby.altitude], v: [flyby.speed * Math.sin(h), flyby.speed * Math.cos(h), 0] };
  };
  const fixes: Fix[] = [];
  for (let t = from; t <= to + 1e-9; t += every) {
    const { p, v } = at(t);
    const { lat, lon } = fromLocal(listener, p[0], p[1]);
    fixes.push({ t, lat, lon, altitude: p[2], velocity: v });
  }
  return fixes;
}
