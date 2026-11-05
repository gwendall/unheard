// Takes the tone of an aircraft out of a recording, along its curve and its harmonics, and
// leaves everything else. colsto's video shows why a high-pass filter is not enough: the tones sit
// where voices are, and boosting the filtered file brings the curve back. Here the tone itself is
// measured and subtracted: each harmonic is brought down to 0 Hz by following the curve's phase,
// smoothed to the band the curve may wander in, and taken away. What that empties is then given back
// as noise at the level of the sound beside it, or its hollow would trace the same curve. What a
// boost then finds is the recording's own noise.

import { fft, realFft } from "./fft";
import { median } from "./spectrogram";

/** A tone to take out: its heard fundamental, Hz, at `times` (seconds from the first sample). NaN where it is not heard. */
export type Curve = {
  times: ArrayLike<number>;
  freq: ArrayLike<number>;
  /** This curve's own `width` (ScrubOptions): a loud tone's skirts reach further. */
  width?: number;
  /** This curve's own `harmonics` (ScrubOptions). */
  harmonics?: number;
};

export type ScrubOptions = {
  /** How many harmonics to take out, the fundamental included. */
  harmonics?: number;
  /**
   * Half the width of the band taken out around the fundamental, Hz: how far the curve may be off.
   * A curve off by 1 Hz is off by h Hz at harmonic h, so the band widens with it.
   */
  width?: number;
  /**
   * Times each harmonic is measured and taken away. The smoothing passes a tone 1.2 Hz off the
   * curve at about 87 %: one pass leaves 13 % of it, three leave 0.2 %.
   */
  passes?: number;
  /**
   * Give back the power the passes took, as new noise. Taking a tone out takes the noise under it
   * too, and the hole follows the curve: the evidence map compares each frequency with itself over
   * the whole file, so the rest of a hollowed band then stands out, and a new line appears where the
   * old one ran.
   */
  fill?: boolean;
  /** Called as the work goes: a step per curve, then another per curve's fill. */
  onStep?: (done: number, total: number) => void;
};

const TWO_PI = 2 * Math.PI;
const TWO_32 = 2 ** 32;

/** Harmonics taken out by default, the fundamental included. */
export const HARMONICS = 6;

const DEFAULTS: Required<ScrubOptions> = { harmonics: HARMONICS, width: 3, passes: 3, fill: true, onStep: () => {} };

/** The curve's frequency at every sample (NaN where unknown), linearly between its points. */
function perSample(curve: Curve, n: number, rate: number, out: Float64Array = new Float64Array(n)): Float64Array {
  out.fill(NaN, 0, n);
  const { times, freq } = curve;
  for (let j = 0; j + 1 < times.length; j++) {
    const f0 = freq[j];
    const f1 = freq[j + 1];
    if (!Number.isFinite(f0) || !Number.isFinite(f1)) continue;
    const a = Math.max(0, Math.ceil(times[j] * rate));
    const b = Math.min(n - 1, Math.floor(times[j + 1] * rate));
    const span = times[j + 1] - times[j];
    for (let i = a; i <= b; i++) out[i] = f0 + ((f1 - f0) * (i / rate - times[j])) / span;
  }
  return out;
}

/** Scratch of the smoothing and of each curve and harmonic, kept from one window to the next: a window at 48 kHz runs to 10 MB an array. */
const NO_DATA = new Float64Array(0);
const emptyBuffers = () => ({
  out: NO_DATA,
  tmp: NO_DATA,
  f: NO_DATA,
  cos: NO_DATA,
  sin: NO_DATA,
  cos1: NO_DATA,
  sin1: NO_DATA,
  re: NO_DATA,
  im: NO_DATA,
  weight: NO_DATA,
  on: new Uint8Array(0),
});
let buffers = emptyBuffers();

function room(n: number) {
  if (buffers.out.length >= n) return;
  const doubles = () => new Float64Array(n);
  buffers = {
    out: doubles(),
    tmp: doubles(),
    f: doubles(),
    cos: doubles(),
    sin: doubles(),
    cos1: doubles(),
    sin1: doubles(),
    re: doubles(),
    im: doubles(),
    weight: doubles(),
    on: new Uint8Array(n),
  };
}

/** Gives the scratch back, once a whole file is done. */
export function freeScrub() {
  buffers = emptyBuffers();
}

/**
 * One moving average over [i - half, i + half] of `from` into `to`, for i in [lo, hi): shrinking at
 * the edges of the `n` samples. `from` counts as zero outside [lo, hi).
 */
function runningMean(from: Float64Array, to: Float64Array, half: number, n: number, lo: number, hi: number) {
  // The window of the sample before lo.
  const a = Math.max(0, lo - 1 - half);
  const b = Math.min(n, lo + half);
  let count = b - a;
  let sum = 0;
  for (let i = lo; i < Math.min(b, hi); i++) sum += from[i];
  // In the middle the whole window is inside [lo, hi): nothing to check, the same count throughout.
  const midFrom = lo + half + 1;
  const midTo = hi - half;
  let i = lo;
  for (const end = Math.min(midFrom, hi); i < end; i++) {
    const add = i + half;
    if (add < n) {
      if (add < hi) sum += from[add];
      count++;
    }
    const drop = i - half - 1;
    if (drop >= 0) {
      if (drop >= lo) sum -= from[drop];
      count--;
    }
    to[i] = sum / count;
  }
  if (midFrom < midTo) {
    const share = 1 / (2 * half + 1);
    const ahead = half;
    const behind = half + 1;
    for (; i < midTo; i++) {
      sum += from[i + ahead];
      sum -= from[i - behind];
      to[i] = sum * share;
    }
    count = 2 * half + 1;
  }
  for (; i < hi; i++) {
    const add = i + half;
    if (add < n) {
      if (add < hi) sum += from[add];
      count++;
    }
    const drop = i - half - 1;
    if (drop >= 0) {
      if (drop >= lo) sum -= from[drop];
      count--;
    }
    to[i] = sum / count;
  }
}

/**
 * A centred moving average of `len` samples, in place, twice (a triangle: lower side lobes), over
 * the samples [lo, hi) of an array of `n`: outside them it holds zeros, or what nobody reads.
 */
function smooth(x: Float64Array, len: number, n: number, lo: number, hi: number) {
  const half = Math.max(1, Math.floor(len / 2));
  runningMean(x, buffers.tmp, half, n, lo, hi);
  runningMean(buffers.tmp, x, half, n, lo, hi);
}

/** How far a smoothing reaches, either way: both of its passes. */
const reachOf = (len: number) => 2 * (Math.max(1, Math.floor(len / 2)) + 1);

/** Where a curve is known among the first `n` samples, as the first and one past the last: [0, 0) when never. */
function supportOf(f: Float64Array, n: number): [number, number] {
  let a = 0;
  while (a < n && !Number.isFinite(f[a])) a++;
  if (a === n) return [0, 0];
  let b = n;
  while (!Number.isFinite(f[b - 1])) b--;
  return [a, b];
}

/** The rotation of harmonic h + 1 from harmonic h's (`cos`, `sin`) and the first harmonic's, over [first, last). */
function nextHarmonic(cos: Float64Array, sin: Float64Array, cos1: Float64Array, sin1: Float64Array, first: number, last: number) {
  for (let i = first; i < last; i++) {
    const c = cos[i];
    const s = sin[i];
    cos[i] = c * cos1[i] - s * sin1[i];
    sin[i] = s * cos1[i] + c * sin1[i];
  }
}

/** The recording with the curves' tones taken out. The input is left as it is. */
export function scrub(samples: Float32Array, sampleRate: number, curves: Curve[], options: ScrubOptions = {}): Float32Array {
  const o = { ...DEFAULTS, ...options };
  const n = samples.length;
  room(n);
  const { out, re, im, weight, on, cos, sin, cos1, sin1 } = buffers;
  out.set(samples);
  const steps = curves.length * (o.fill ? 2 : 1);
  for (const [index, curve] of curves.entries()) {
    o.onStep(index, steps);
    const f = perSample(curve, n, sampleRate, buffers.f);
    const [first, last] = supportOf(f, n);
    if (first === last) continue;
    const width = curve.width ?? o.width;
    rotation(f, sampleRate, first, last);
    for (let h = 1; h <= (curve.harmonics ?? o.harmonics); h++) {
      if (h > 1) nextHarmonic(cos, sin, cos1, sin1, first, last);
      const len = lengthOf(sampleRate, width, h);
      // The samples this harmonic reads, worked out once for all its passes.
      let any = false;
      for (let i = first; i < last; i++) {
        const here = within(f[i], h, width, 0, sampleRate);
        on[i] = here ? 1 : 0;
        if (here) any = true;
      }
      // Above Nyquist all along: nothing to take out.
      if (!any) continue;
      const reach = reachOf(len);
      const lo = Math.max(0, first - reach);
      const hi = Math.min(n, last + reach);
      weight.fill(0, lo, hi);
      for (let i = first; i < last; i++) weight[i] = on[i];
      smooth(weight, len, n, lo, hi);
      // Dividing by the share of known samples in the window keeps the edges of a stretch from being under-taken.
      const gain = weight;
      for (let i = first; i < last; i++) gain[i] = Number.isFinite(f[i]) && weight[i] >= 0.25 ? 2 / weight[i] : 0;
      for (let pass = 0; pass < o.passes; pass++) {
        // Down to 0 Hz, only where the curve is known (and below Nyquist).
        re.fill(0, lo, hi);
        im.fill(0, lo, hi);
        for (let i = first; i < last; i++) {
          if (!on[i]) continue;
          const x = out[i];
          re[i] = x * cos[i];
          im[i] = -x * sin[i];
        }
        smooth(re, len, n, lo, hi);
        smooth(im, len, n, lo, hi);
        // The tone's amplitude there, back up to its frequency, taken away.
        for (let i = first; i < last; i++) out[i] -= gain[i] * (re[i] * cos[i] - im[i] * sin[i]);
      }
    }
  }
  if (o.fill) fill(out, n, sampleRate, curves, o);
  return new Float32Array(out.subarray(0, n));
}

/** A triangle of total length 2L passes about 1 / L Hz either side: L = rate / (2 width h). */
function lengthOf(rate: number, width: number, h: number) {
  return Math.max(3, Math.round(rate / (2 * width * h)));
}

/** Whether harmonic h of `f`, moved by `by` Hz, keeps its band between 0 Hz and Nyquist. */
function within(f: number, h: number, width: number, by: number, rate: number) {
  return Number.isFinite(f) && h * (f - width) + by > 0 && h * (f + width) + by < rate / 2;
}

/**
 * The fundamental's rotation over [first, last) from its frequency `f`, its phase carried across
 * the gaps so each heard stretch stays in step: every other harmonic's follows from it, with no
 * more sines (`nextHarmonic`).
 */
function rotation(f: Float64Array, rate: number, first: number, last: number) {
  const { cos, sin, cos1, sin1 } = buffers;
  let p = 0;
  for (let i = first; i < last; i++) {
    const fi = f[i];
    if (fi === fi) p += (2 * Math.PI * fi) / rate;
    const c = Math.cos(p);
    const s = Math.sin(p);
    cos1[i] = c;
    sin1[i] = s;
    cos[i] = c;
    sin[i] = s;
  }
}

/** Seconds of the fill's window, and how many of them a frame moves on: fine enough for a band 8 Hz wide, short enough to follow a gust. */
const FILL_SECONDS = 1;
const FILL_OVERLAP = 4;
/** What a cell must keep of its power to be read as the sound beside. */
const GOOD = 0.8;
/** Cells either side a level is read over: about 30 Hz, wide enough that a line there does not move its median. */
const FLOOR_CELLS = 32;
/** Cells apart that are no longer the same side of a hollow, and the fewest a level is read from. */
const GAP = 8;
const FEWEST = 12;
/** Decibels between neighbouring frames that are no gust but the sound stopping or starting. */
const JUMP = 6;
/** The level of a cell nobody could read, or of digital silence: decibels of power. */
const SILENT = -250;
/** Below this the sound's level is not read: a recording's first hertz are often filtered out. */
const LOWEST_HZ = 15;
/** How far a notch reaches, in widths of its smoothing: past this it takes less than 5 % of the power. */
const NOTCH_REACH = 3;
const NOTCH_STEPS = 100;
/** Around the middle of a frame: where the curve is read, and how much each counts (the window squared). */
const FILL_POINTS = [-2, -1, 0, 1, 2].map((d) => ({ at: d / 8, weight: Math.sin(Math.PI * (0.5 + d / 8)) ** 4 }));
const FILL_TOTAL = FILL_POINTS.reduce((a, p) => a + p.weight, 0);

/** The power a harmonic's passes leave a distance x from it (x: in widths of the smoothing), every 1 / NOTCH_STEPS. */
function notchTable(passes: number): Float64Array {
  const table = new Float64Array(NOTCH_REACH * NOTCH_STEPS + 2);
  for (let i = 0; i < table.length; i++) {
    const x = (Math.PI * i) / NOTCH_STEPS;
    const d = i ? Math.sin(x) / x : 1;
    table[i] = (1 - d * d) ** (2 * passes);
  }
  return table;
}

/** A cell that has lost less than this gets nothing back. */
const LOST_ENOUGH = 0.003;

type Plane = {
  /** Samples of the window, and of the transform (a power of two, the rest zeros). */
  span: number;
  size: number;
  hop: number;
  /** Where frame 0 starts, in samples; it may be before the first. */
  start: number;
  frames: number;
  /** Cells per frame, from 0 Hz. */
  bins: number;
  /** Per frame and bin, the share of its power a cell still has. */
  left: Float32Array;
  /** Per frame, whether any of its cells lost something. */
  emptied: Uint8Array;
};

/** How much of its power each cell keeps once `curves` are taken out: the passes' response around each harmonic, multiplied over them all. Null when no curve is ever known. */
function planeOf(n: number, rate: number, curves: Curve[], o: Required<ScrubOptions>): Plane | null {
  const span = Math.max(8, 2 * Math.round((FILL_SECONDS * rate) / 2));
  const size = 2 ** Math.ceil(Math.log2(span));
  const hop = Math.max(1, Math.round(span / FILL_OVERLAP));
  const binHz = rate / size;
  // The curves on a grid an eighth of the window apart.
  const step = span / 8;
  const grid = Math.ceil(n / step) + 1;
  const known = curves.flatMap((curve) => {
    const f = perSample(curve, n, rate, buffers.f);
    const [first, last] = supportOf(f, n);
    if (first === last) return [];
    const coarse = new Float32Array(grid);
    let highest = 0;
    for (let g = 0; g < grid; g++) {
      coarse[g] = f[Math.min(n - 1, Math.round(g * step))];
      if (coarse[g] > highest) highest = coarse[g];
    }
    return [{ coarse, first, last, highest, width: curve.width ?? o.width, harmonics: curve.harmonics ?? o.harmonics }];
  });
  if (!known.length) return null;
  const notches = known.flatMap((c) =>
    Array.from({ length: c.harmonics }, (_, i) => {
      const h = i + 1;
      // One smoothing's length (`smooth`): a reach of x means x / perHz hertz.
      const perHz = (2 * Math.max(1, Math.floor(lengthOf(rate, c.width, h) / 2)) + 1) / rate;
      return { c, h, perHz, reach: NOTCH_REACH / perHz / binHz, scale: binHz * perHz * NOTCH_STEPS };
    }),
  );
  const top = notches.reduce((most, { c, h, reach }) => Math.max(most, Math.ceil((h * c.highest) / binHz + reach)), 0);
  // Enough above the highest band to read a level there.
  const bins = Math.min((size >> 1) + 1, top + 2 * FLOOR_CELLS + 1);
  // The first frame starts a window before the curves: every sample gets all its frames.
  const first = known.reduce((a, c) => Math.min(a, c.first), n);
  const last = known.reduce((a, c) => Math.max(a, c.last), 0);
  const start = first - span;
  const frames = Math.ceil((last - first + 2 * span) / hop) + 1;
  const table = notchTable(o.passes);
  const left = new Float32Array(frames * bins).fill(1);
  const emptied = new Uint8Array(frames);
  const here = new Float64Array(bins);
  for (let m = 0; m < frames; m++) {
    const middle = start + m * hop + span / 2;
    const row = m * bins;
    for (const { at, weight } of FILL_POINTS) {
      const g = Math.round((middle + at * span) / step);
      if (g < 0 || g >= grid) continue;
      here.fill(1);
      for (const { c, h, reach, scale } of notches) {
        const f = c.coarse[g];
        if (!within(f, h, c.width, 0, rate)) continue;
        const centre = (h * f) / binHz;
        const b0 = Math.max(0, Math.ceil(centre - reach));
        const b1 = Math.min(bins - 1, Math.floor(centre + reach));
        for (let b = b0; b <= b1; b++) here[b] *= table[(Math.abs(b - centre) * scale + 0.5) | 0];
      }
      const share = weight / FILL_TOTAL;
      for (let b = 0; b < bins; b++) left[row + b] += share * (here[b] - 1);
    }
    for (let b = 0; b < bins; b++) {
      if (left[row + b] < 1 - LOST_ENOUGH) {
        emptied[m] = 1;
        break;
      }
    }
  }
  return { span, size, hop, start, frames, bins, left, emptied };
}

/**
 * The level of the sound at each cell, in decibels of power, from the cells that lost little: their
 * median over FLOOR_CELLS either side, each given back what it lost, and straight across a hollow.
 * Frames no emptied frame touches are left SILENT.
 */
function levelsOf(out: Float64Array, n: number, rate: number, plane: Plane, window: Float64Array): Float32Array {
  const { span, size, hop, start, frames, bins, left, emptied } = plane;
  const levels = new Float32Array(frames * bins).fill(SILENT);
  const low = Math.max(1, Math.round((LOWEST_HZ * size) / rate));
  const x = new Float64Array(size);
  const re = new Float64Array((size >> 1) + 1);
  const im = new Float64Array((size >> 1) + 1);
  const goodBin = new Int32Array(bins);
  const goodPower = new Float32Array(bins);
  const every = FLOOR_CELLS >> 1;
  for (let m = 0; m < frames; m++) {
    if (!emptied[m] && !emptied[m - 1] && !emptied[m + 1]) continue;
    const row = m * bins;
    const at = start + m * hop;
    for (let i = 0; i < span; i++) {
      const j = at + i;
      x[i] = j >= 0 && j < n ? out[j] * window[i] : 0;
    }
    realFft(x, re, im);
    let count = 0;
    for (let b = low; b < bins; b++) {
      if (left[row + b] < GOOD) continue;
      goodBin[count] = b;
      goodPower[count] = (re[b] * re[b] + im[b] * im[b]) / left[row + b];
      count++;
    }
    let lastBin = -1;
    let lastDb = SILENT;
    const put = (bin: number, db: number) => {
      if (lastBin < 0) for (let b = 0; b <= bin; b++) levels[row + b] = db;
      else for (let b = lastBin + 1; b <= bin; b++) levels[row + b] = lastDb + ((db - lastDb) * (b - lastBin)) / (bin - lastBin);
      lastBin = bin;
      lastDb = db;
    };
    // Never a median across a hollow: half the sound from each side of it would read as neither.
    for (let from = 0; from < count; ) {
      let to = from + 1;
      while (to < count && goodBin[to] - goodBin[to - 1] <= GAP) to++;
      if (to - from >= FEWEST) {
        for (let j = from; ; j = Math.min(to - 1, j + every)) {
          const part = goodPower.subarray(Math.max(from, j - FLOOR_CELLS), Math.min(to, j + FLOOR_CELLS + 1));
          // The median of a noise's power is ln 2 of its mean.
          put(goodBin[j], Math.max(SILENT, 10 * Math.log10(median(part) / Math.LN2 + 1e-30)));
          if (j === to - 1) break;
        }
      }
      from = to;
    }
    for (let b = lastBin + 1; b < bins; b++) levels[row + b] = lastDb;
  }
  return levels;
}

/**
 * Each emptied cell of the sound's time and frequency plane given back its power, as new noise. Why
 * not a band of noise along each harmonic: bands overlap, and two curves a hertz apart or a hum's
 * six harmonics hollow whatever lies between them, so the sound "beside" a band is often another
 * band. On a 50 Hz hum of 85 s the bands from 170 to 340 Hz read each other and came out 10 to 20 dB
 * low, and the frequencies left between them stood out as lines, stronger than the tones taken out.
 *
 * Here how much each cell lost follows from the curves alone (planeOf), so overlaps count once
 * however wide the hollow, and its level comes from cells that lost little, however far away
 * (levelsOf): read after the passes, so no tone taken out comes back; a median, so a line left there
 * does not raise it. New noise each time: a band scrubbed again along nearly the same curve loses
 * what the last round gave and gets it back.
 */
function fill(out: Float64Array, n: number, rate: number, curves: Curve[], o: Required<ScrubOptions>) {
  const plane = planeOf(n, rate, curves, o);
  if (!plane) return;
  const { span, size, hop, start, frames, bins, left, emptied } = plane;
  // The noise's seed comes from the sound: the same file gives the same result, another round other
  // noise. Rounded well above what a float's last bits can move, so they do not make another draw.
  let seed = 0x9e3779b9;
  for (let i = 0; i < n; i += 97) seed = Math.imul(seed ^ Math.round(out[i] * 1e5), 0x85ebca6b) >>> 0;
  const window = new Float64Array(span);
  for (let i = 0; i < span; i++) window[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / span);
  const levels = levelsOf(out, n, rate, plane, window);
  // A cell's power through this window is what a frame's noise brings, over all the frames that reach it.
  const energy = window.reduce((a, w) => a + w * w, 0);
  const norm = (2 * Math.sqrt(hop / size)) / energy;
  const zr = new Float64Array(size);
  const zi = new Float64Array(size);
  for (let m = 0; m < frames; m++) {
    o.onStep(curves.length + Math.floor((m * curves.length) / frames), 2 * curves.length);
    if (!emptied[m]) continue;
    const row = m * bins;
    const before = m > 0 ? row - bins : row;
    const after = m + 1 < frames ? row + bins : row;
    zr.fill(0);
    zi.fill(0);
    let some = false;
    for (let b = 1; b < bins; b++) {
      const lost = 1 - left[row + b];
      if (lost < LOST_ENOUGH) continue;
      // The level over three frames, a median; where it jumps, the quietest: a window that reaches
      // into a loud stretch must not carry its level into the silence after it.
      const p = levels[before + b];
      const q = levels[row + b];
      const r = levels[after + b];
      const lowest = Math.min(p, q, r);
      const db = Math.max(p, q, r) - lowest > JUMP ? lowest : Math.max(Math.min(p, q), Math.min(Math.max(p, q), r));
      // Silence stays silence.
      if (db <= SILENT) continue;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const u = (seed + 0.5) / TWO_32;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const angle = (TWO_PI * seed) / TWO_32;
      // Two independent Gaussians of power `lost` times the level between them.
      const amp = Math.sqrt(-lost * 10 ** (db / 10) * Math.log(u));
      zr[b] = amp * Math.cos(angle);
      zi[b] = amp * Math.sin(angle);
      some = true;
    }
    if (!some) continue;
    fft(zr, zi);
    const at = start + m * hop;
    const i0 = Math.max(0, -at);
    const i1 = Math.min(span, n - at);
    for (let i = i0; i < i1; i++) out[at + i] += norm * window[i] * zr[i];
  }
}
