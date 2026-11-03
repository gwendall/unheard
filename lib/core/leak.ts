// Does a recording give away where it was made? The check page's analysis, with no flight data:
// the aircraft tones anyone holding the file could find in it (findTraces), and the same file
// with them taken out (scrub). Both run in pieces so a two-hour stream fits in a phone's memory:
// findTraces keeps a back-pointer per frame, bin and slope (about 5 MB per 90 s) and the evidence
// stack about 0.5 MB per second, so the search reads overlapping chunks of three minutes and
// joins what they find; scrub keeps 48 bytes per sample, so it cleans windows of 20 s.

import { ANALYSIS_RATE } from "./pipeline";
import { RESAMPLE_REACH, resampleAt } from "./resample";
import { HARMONICS, scrub, type Curve, type ScrubOptions } from "./scrub";
import { buildStack, type StackOptions } from "./spectrogram";
import { findTraces, REAL_RANGE, type Trace, type TraceOptions } from "./trace";

/** A recording as the check holds it: every channel at the file's own rate. */
export type Audio = { channels: Float32Array[]; sampleRate: number };

/** `length` mono samples at the analysis rate, from sample `start` at that rate. */
export type Reader = (start: number, length: number) => Float32Array;

/** A stretch of the recording, in samples at the analysis rate: [start, end). */
export type Chunk = { start: number; end: number };

/** An aircraft tone found in the recording, on the whole file's clock. */
export type Tone = {
  /** Seconds from the first sample, one per base frame (0.25 s apart), along the tone. */
  times: Float64Array;
  /** The tone's frequency at each of `times`, Hz. */
  freq: Float32Array;
  /** How far it stands above what the noise alone makes (trace.ts): 4 is the bar. */
  confidence: number;
  /**
   * Fainter ridges that run beside this one all along (the leakage of a loud tone a few per cent
   * off, a harmonic, a twin's second engine): one source to the eye, taken out with it.
   */
  beside?: Tone[];
};

export const CHUNK_SECONDS = 180;
/** A trace shorter than the overlap is whole in at least one chunk; a longer one is joined. */
export const OVERLAP_SECONDS = 60;
const HOP_SECONDS = 0.25;

/** Two pieces are one tone when they share this many frames and agree within 1 % on them. */
const SHARED = 8;
const AGREE = 0.01;

/** The mono recording at the analysis rate, read a piece at a time from every channel. */
export function readerOf(audio: Audio, rate = ANALYSIS_RATE): { read: Reader; length: number } {
  const { channels, sampleRate: from } = audio;
  const n = channels[0]?.length ?? 0;
  const read: Reader = (start, count) => {
    // The input samples the kernel reaches for this piece, mixed down to one channel.
    const at = (start * from) / rate;
    const i0 = Math.max(0, Math.floor(at) - RESAMPLE_REACH);
    const i1 = Math.min(n, Math.ceil(at + (count * from) / rate) + RESAMPLE_REACH + 1);
    const mono = new Float32Array(Math.max(0, i1 - i0));
    for (const ch of channels) for (let i = i0; i < i1; i++) mono[i - i0] += ch[i] / channels.length;
    if (from === rate) {
      const out = new Float32Array(count);
      out.set(mono.subarray(start - i0, Math.min(mono.length, start - i0 + count)));
      return out;
    }
    return resampleAt(mono, from, rate, at - i0, count);
  };
  return { read, length: Math.floor((n * rate) / from) };
}

/**
 * Chunks over `length` samples at `rate`, `overlap` seconds shared between neighbours. Each
 * starts on the base frame hop, so frames of every chunk fall on one grid.
 */
export function chunksOf(length: number, rate = ANALYSIS_RATE, seconds = CHUNK_SECONDS, overlap = OVERLAP_SECONDS): Chunk[] {
  const hop = Math.max(1, Math.round(HOP_SECONDS * rate));
  const size = Math.max(hop, Math.round((seconds * rate) / hop) * hop);
  const step = Math.max(hop, size - Math.round((overlap * rate) / hop) * hop);
  const out: Chunk[] = [];
  for (let start = 0; ; start += step) {
    const end = Math.min(length, start + size);
    out.push({ start, end });
    if (end >= length) return out;
  }
}

/** A trace of one chunk's stack (`times`: stack.base.times) on the whole file's clock. */
export function toneOf(trace: Trace, times: ArrayLike<number>, offset = 0): Tone {
  const n = trace.to - trace.from + 1;
  const t = new Float64Array(n);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = offset + times[trace.from + i];
    f[i] = trace.freq[trace.from + i];
  }
  return { times: t, freq: f, confidence: trace.confidence };
}

const frameOf = (t: number) => Math.round(t / HOP_SECONDS);

function sameTone(a: Tone, b: Tone): boolean {
  const ka = frameOf(a.times[0]);
  const kb = frameOf(b.times[0]);
  const lo = Math.max(ka, kb);
  const hi = Math.min(ka + a.times.length, kb + b.times.length) - 1;
  if (hi - lo + 1 < SHARED) return false;
  const d: number[] = [];
  for (let k = lo; k <= hi; k++) d.push(Math.abs(Math.log(a.freq[k - ka] / b.freq[k - kb])));
  d.sort((x, y) => x - y);
  return d[d.length >> 1] < AGREE;
}

/** Both pieces' frames; where they overlap, the surer piece's frequency. */
function join(a: Tone, b: Tone): Tone {
  const [first, second] = a.confidence >= b.confidence ? [a, b] : [b, a];
  const kf = frameOf(first.times[0]);
  const ks = frameOf(second.times[0]);
  const lo = Math.min(kf, ks);
  const hi = Math.max(kf + first.times.length, ks + second.times.length) - 1;
  const times = new Float64Array(hi - lo + 1);
  const freq = new Float32Array(hi - lo + 1);
  for (let k = lo; k <= hi; k++) {
    const i = k - kf;
    const from = i >= 0 && i < first.times.length ? { t: first.times, f: first.freq, i } : { t: second.times, f: second.freq, i: k - ks };
    times[k - lo] = from.t[from.i];
    freq[k - lo] = from.f[from.i];
  }
  return { times, freq, confidence: first.confidence };
}

/** Ratios at which a ridge runs beside a louder one: the same pitch a few per cent off, or a harmonic. */
const KIN = [1 / 3, 1 / 2, 2 / 3, 3 / 2, 2, 3];
const NEAR = 0.05;

/**
 * Where `b` runs parallel to `a` over most of its own frames (their ratio steady within 0.5 %, the
 * same Doppler factor, so the same aircraft): the log of that ratio. Otherwise null.
 */
function parallel(a: Tone, b: Tone): number | null {
  const ka = frameOf(a.times[0]);
  const kb = frameOf(b.times[0]);
  const lo = Math.max(ka, kb);
  const hi = Math.min(ka + a.times.length, kb + b.times.length) - 1;
  if (hi - lo + 1 < Math.max(SHARED, 0.5 * b.times.length)) return null;
  const r: number[] = [];
  for (let k = lo; k <= hi; k++) r.push(Math.log(b.freq[k - kb] / a.freq[k - ka]));
  r.sort((x, y) => x - y);
  const mid = r[r.length >> 1];
  const spread = r.map((x) => Math.abs(x - mid)).sort((x, y) => x - y)[r.length >> 1];
  return spread > AGREE / 2 ? null : mid;
}

/** `b` runs beside `a`: parallel, at a near pitch or a harmonic. */
function runsBeside(a: Tone, b: Tone): boolean {
  const mid = parallel(a, b);
  return mid !== null && (Math.abs(mid) < NEAR || KIN.some((ratio) => Math.abs(mid - Math.log(ratio)) < AGREE));
}

/**
 * Pieces of one tone found in overlapping chunks become one, and a ridge that runs beside a louder
 * one is kept with it (`beside`). Strongest first.
 */
export function mergeTones(tones: Tone[]): Tone[] {
  const out = [...tones].sort((a, b) => a.times[0] - b.times[0]);
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      if (!sameTone(out[i], out[j])) continue;
      out[i] = join(out[i], out[j]);
      out.splice(j, 1);
      // The joined tone may now reach one it did not: look again from its neighbours.
      j = i;
    }
  }
  const kept: Tone[] = [];
  for (const t of out.sort((a, b) => b.confidence - a.confidence)) {
    const louder = kept.find((k) => runsBeside(k, t));
    if (louder) louder.beside = [...(louder.beside ?? []), t];
    else kept.push(t);
  }
  return kept;
}

/** A tone and the ridges beside it: everything taken out for it. */
export const ridgesOf = (tone: Tone): Tone[] => [tone, ...(tone.beside ?? [])];

export type FindOptions = {
  trace?: TraceOptions;
  /** The search for lines a tone brings along (ALONG); null: none. */
  along?: TraceOptions | null;
  stack?: StackOptions;
  /** Called before each chunk, and once at the end with done = total. */
  onChunk?: (done: number, total: number) => void;
};

/**
 * What the check reports: findTraces' defaults (40 to 400 Hz, propeller planes and helicopters),
 * each ridge whole. Locating cuts a loud ridge back to its loud stretch, where the curve is
 * surest; taking a tone out needs all of it, and a cut stretch that barely moves is dropped: on
 * AeroSonicDB's 7C3A50 (14:01) that dropped the loudest tone, 238 to 226 Hz.
 */
export const CHECK_TRACE: TraceOptions = { trimShare: 0 };

/**
 * Where the check also looks once a chunk holds a tone: up to 3.4 kHz (REAL_RANGE, what Locate me
 * reads). A line found there is taken out with the tones and never reported on its own: alone,
 * this range finds a line in 3 of 6 two-minute white-noise files, but cleaning a band of noise
 * costs nothing, and leaving a real line costs the recording. On 7C3A50 (14:01), a Bell 412 heard
 * at 3, 4, 5 and 7 times 59 Hz, the 7th at 412 Hz kept the helicopter named once the three below
 * 400 Hz were out. On 7C6D29 (14:12), a B738 heard at 80 Hz for 20 s and at 2.5 to 1.5 kHz for the
 * whole minute, the high line named it once the low one was out, loud as it was.
 */
export const ALONG: TraceOptions = { ...REAL_RANGE, trimShare: 0, maxTraces: 8 };

/**
 * The aircraft tones in `chunks` of a recording, joined across chunks, strongest first. Each chunk
 * gets the evidence stack analyze() builds, findTraces with CHECK_TRACE, and with ALONG for the
 * lines to take out with them (in a tone's `beside`): what the page finds is what evals/leak
 * measures.
 */
export function findTones(read: Reader, chunks: Chunk[], rate = ANALYSIS_RATE, options: FindOptions = {}): Tone[] {
  const found: Tone[] = [];
  const wide: Tone[] = [];
  const trace = { ...CHECK_TRACE, ...options.trace };
  const along = options.along === undefined ? ALONG : options.along;
  chunks.forEach((c, i) => {
    options.onChunk?.(i, chunks.length);
    const stack = buildStack(read(c.start, c.end - c.start), rate, options.stack);
    const here = findTraces(stack, trace).traces;
    for (const t of here) found.push(toneOf(t, stack.base.times, c.start / rate));
    if (along && here.length) for (const t of findTraces(stack, along).traces) wide.push(toneOf(t, stack.base.times, c.start / rate));
  });
  options.onChunk?.(chunks.length, chunks.length);
  const tones = mergeTones(found);
  // A line found up there goes out with the tones, with the one it runs parallel to if any, unless
  // scrub already takes it: a line already found, or one of the first harmonics of one.
  const taken = (w: Tone) =>
    tones.flatMap(ridgesOf).some((r) => {
      const mid = parallel(r, w);
      if (mid === null) return false;
      const h = Math.round(Math.exp(mid));
      return h >= 1 && h <= HARMONICS && Math.abs(mid - Math.log(h)) < AGREE;
    });
  for (const w of mergeTones(wide).flatMap(ridgesOf)) {
    if (taken(w)) continue;
    const lead = tones.find((t) => parallel(t, w) !== null) ?? tones[0];
    lead.beside = [...(lead.beside ?? []), w];
  }
  return tones;
}

/** Seconds the end of a tone is carried on: where it fades under what the search sees, it may still be heard. */
const EXTEND = 2;
/**
 * A tone this far above the noise (confidence) has skirts wider than scrub's usual band, and they
 * stand out once the middle is gone: a plane at 408 on the synthetic corpus left two rails 2 to 4
 * Hz either side, enough for a silent aircraft whose curve ran along them to be named. The real
 * clips' tones stay under 40.
 */
const LOUD = { confidence: 100, width: 5 };
/** Frames the slope at either end is read over. */
const SLOPE_FRAMES = 16;

/**
 * The curve scrub follows to take a tone out: the tone's own frames, carried on `extend` seconds
 * at either end along its slope there. NaN nowhere: scrub leaves alone what lies outside a curve.
 */
export function curveOf(tone: Tone, extend = EXTEND): Curve {
  const { times: t, freq: f } = tone;
  const n = t.length;
  const slope = (i0: number, i1: number) => (i1 > i0 ? Math.log(f[i1] / f[i0]) / (t[i1] - t[i0]) : 0);
  const head = slope(0, Math.min(n - 1, SLOPE_FRAMES));
  const tail = slope(Math.max(0, n - 1 - SLOPE_FRAMES), n - 1);
  const steps = Math.round(extend / HOP_SECONDS);
  const times = new Float64Array(n + 2 * steps);
  const freq = new Float64Array(n + 2 * steps);
  for (let i = 0; i < steps; i++) {
    const dt = (steps - i) * HOP_SECONDS;
    times[i] = t[0] - dt;
    freq[i] = f[0] * Math.exp(-head * dt);
  }
  for (let i = 0; i < n; i++) {
    times[steps + i] = t[i];
    freq[steps + i] = f[i];
  }
  for (let i = 1; i <= steps; i++) {
    const dt = i * HOP_SECONDS;
    times[steps + n - 1 + i] = t[n - 1] + dt;
    freq[steps + n - 1 + i] = f[n - 1] * Math.exp(tail * dt);
  }
  return tone.confidence >= LOUD.confidence ? { times, freq, width: LOUD.width } : { times, freq };
}

/** First and last time a curve is known, seconds; null when never. */
function spanOf(c: Curve): { start: number; end: number } | null {
  let start = Infinity;
  let end = -Infinity;
  for (let j = 0; j < c.times.length; j++) {
    if (!Number.isFinite(c.freq[j])) continue;
    start = Math.min(start, c.times[j]);
    end = Math.max(end, c.times[j]);
  }
  return start <= end ? { start, end } : null;
}

export type CleanOptions = {
  scrub?: ScrubOptions;
  /** Seconds cleaned at a time, and read on either side of them so the edges come out whole. */
  window?: number;
  margin?: number;
  onWindow?: (done: number, total: number) => void;
};

/**
 * Takes `curves` out of every channel of `audio`, in place. Only where a curve is known changes;
 * the rest of the file is never copied, and each window is cleaned with `margin` seconds of sound
 * either side, so the result is the one scrub would give the whole file at once (scrub's smoothing
 * reaches about 1.2 s).
 */
export function clean(audio: Audio, curves: Curve[], options: CleanOptions = {}): void {
  const { window = 20, margin = 4 } = options;
  const { channels, sampleRate: rate } = audio;
  const n = channels[0]?.length ?? 0;
  const known = curves.map((c) => ({ c, span: spanOf(c) })).filter((x): x is { c: Curve; span: { start: number; end: number } } => x.span !== null);
  // Where some curve is known, as stretches that do not overlap.
  const stretches: { start: number; end: number }[] = [];
  for (const { span } of [...known].sort((a, b) => a.span.start - b.span.start)) {
    const last = stretches.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else stretches.push({ ...span });
  }
  const windows: { start: number; end: number }[] = [];
  for (const s of stretches) for (let a = s.start; a < s.end || a === s.start; a += window) windows.push({ start: a, end: Math.min(s.end, a + window) });
  // A window's result is written back only once no later window reads it: each reads the sound
  // as it was, its margins included.
  const pending: { at: number; data: Float32Array[] }[] = [];
  const flush = (before: number) => {
    while (pending.length && pending[0].at + pending[0].data[0].length <= before) {
      const p = pending.shift()!;
      channels.forEach((ch, c) => ch.set(p.data[c], p.at));
    }
  };
  windows.forEach((w, i) => {
    options.onWindow?.(i, windows.length);
    const s0 = Math.max(0, Math.floor((w.start - margin) * rate));
    const s1 = Math.min(n, Math.ceil((w.end + margin) * rate) + 1);
    // The samples this window owns: from its start to the next window's start.
    const w0 = Math.max(0, Math.floor(w.start * rate));
    const w1 = Math.min(n, Math.floor(w.end * rate) + 1);
    if (s1 <= s0 || w1 <= w0) return;
    const local = known
      .filter(({ span }) => span.end >= (s0 - 1) / rate && span.start <= s1 / rate)
      .map(({ c }) => ({ ...c, times: Float64Array.from(c.times, (t) => t - s0 / rate) }));
    flush(s0);
    pending.push({ at: w0, data: channels.map((ch) => scrub(ch.subarray(s0, s1), rate, local, options.scrub).slice(w0 - s0, w1 - s0)) });
  });
  flush(Infinity);
  options.onWindow?.(windows.length, windows.length);
}

/** Rounds of take out and look again: on real recordings, taking the loud tones out brings fainter ones to light. */
export const ROUNDS = 6;

export type CleanOutOptions = CleanOptions & {
  find?: FindOptions;
  rounds?: number;
  /** Called with the tones of each round, before they are taken out (round 0: the ones given). */
  onRound?: (round: number, tones: Tone[]) => void;
};

/**
 * Takes `tones` out of `audio` (in place), looks again where the sound changed, and takes out
 * what that finds, up to `rounds` times. Elsewhere nothing changed, so nothing new can be found.
 * Returns every tone taken out, and the ones still found after the last round.
 */
export function cleanOut(audio: Audio, tones: Tone[], options: CleanOutOptions = {}): { cleaned: Tone[]; left: Tone[] } {
  const { rounds = ROUNDS } = options;
  const { read, length } = readerOf(audio);
  const chunks = chunksOf(length);
  const cleaned: Tone[] = [];
  let current = tones;
  for (let round = 0; round < rounds && current.length; round++) {
    options.onRound?.(round, current);
    clean(audio, current.flatMap(ridgesOf).map((t) => curveOf(t)), options);
    cleaned.push(...current);
    // The chunks whose sound changed: those that reach a tone just taken out, its curve's ends included.
    const touched = current.flatMap(ridgesOf).map((t) => ({ start: t.times[0] - EXTEND - 1, end: t.times[t.times.length - 1] + EXTEND + 1 }));
    const changed = chunks.filter((c) => touched.some((s) => s.start * ANALYSIS_RATE <= c.end && s.end * ANALYSIS_RATE >= c.start));
    current = findTones(read, changed, ANALYSIS_RATE, options.find);
  }
  return { cleaned, left: current };
}

/** What the page draws for a tone: a stretch of the file, a band of frequencies. */
export type View = { start: number; end: number; lo: number; hi: number };

/** The stretch around a tone, a fifth of its length either side (4 s at least), and its band with room. */
export function viewOf(tone: Tone, duration: number): View {
  const start = tone.times[0];
  const end = tone.times[tone.times.length - 1];
  let low = Infinity;
  let high = 0;
  for (const f of tone.freq) {
    low = Math.min(low, f);
    high = Math.max(high, f);
  }
  const pad = Math.max(4, 0.2 * (end - start));
  const room = Math.max(4, 0.08 * (high - low + 10));
  return { start: Math.max(0, start - pad), end: Math.min(duration, end + pad), lo: Math.max(20, low - room), hi: high + room };
}

/** The evidence map over a view, row 0 at the top (highest frequency), 0 to 255. */
export type Picture = View & { width: number; height: number; cells: Uint8Array };

/**
 * The evidence map (the base window of the stack analyze() builds) over `view`: the same picture
 * before and after cleaning shows the line, then its absence.
 */
export function pictureOf(read: Reader, length: number, view: View, rate = ANALYSIS_RATE): Picture {
  const window = 2;
  // Frames are centred a window's half after their first sample: read that much more each side.
  const a = Math.max(0, Math.round((view.start - window / 2) * rate));
  const b = Math.min(length, Math.round((view.end + window / 2) * rate));
  const stack = buildStack(read(a, Math.max(0, b - a)), rate, { windows: [window] });
  const { base, evidence } = stack;
  const b0 = Math.max(0, Math.floor((view.lo - base.minHz) / base.binHz));
  const b1 = Math.min(base.bins - 1, Math.ceil((view.hi - base.minHz) / base.binHz));
  const width = base.frames;
  const height = Math.max(0, b1 - b0 + 1);
  const cells = new Uint8Array(width * height);
  for (let k = 0; k < width; k++) {
    for (let r = 0; r < height; r++) {
      // The page's colour scale (components/Spectrum.tsx): (evidence + 0.5) / 5.
      const v = Math.min(1, Math.max(0, (evidence[k * base.bins + b0 + r] + 0.5) / 5));
      cells[(height - 1 - r) * width + k] = Math.round(v * 255);
    }
  }
  const t0 = a / rate;
  return {
    start: width ? t0 + base.times[0] : view.start,
    end: width ? t0 + base.times[width - 1] : view.end,
    lo: base.minHz + b0 * base.binHz,
    hi: base.minHz + b1 * base.binHz,
    width,
    height,
    cells,
  };
}
