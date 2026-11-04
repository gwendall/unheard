import { fft } from "./fft";

/**
 * A short-time power spectrum, kept between minHz and maxHz only.
 * Row-major by frame: value of frame k, bin b is at k * bins + b. Bin b is at minHz + b * binHz.
 */
export type Spectrogram = {
  sampleRate: number;
  /** Seconds from the first sample to the centre of each frame. */
  times: Float64Array;
  frames: number;
  bins: number;
  binHz: number;
  minHz: number;
  /** Power in decibels. */
  db: Float32Array;
};

export type SpectrogramOptions = {
  /** Analysis window. 2 s resolves about 0.75 Hz (bins of 0.5 Hz): a faint steady tone then
   * stands out from noise four times better than with 0.5 s. */
  windowSeconds?: number;
  hopSeconds?: number;
  minHz?: number;
  maxHz?: number;
  /** Zero-padding factor of the FFT (1 = none). */
  pad?: number;
};

const pow2 = (x: number) => 2 ** Math.round(Math.log2(x));

export function computeSpectrogram(samples: Float32Array, sampleRate: number, options: SpectrogramOptions = {}): Spectrogram {
  const { windowSeconds = 2, hopSeconds = 0.5, minHz = 20, maxHz = 1000, pad = 1 } = options;
  const win = pow2(windowSeconds * sampleRate);
  const size = win * pad;
  const hop = Math.max(1, Math.round(hopSeconds * sampleRate));
  const binHz = sampleRate / size;
  const firstBin = Math.ceil(minHz / binHz);
  const lastBin = Math.min(size / 2 - 1, Math.floor(maxHz / binHz));
  const bins = lastBin - firstBin + 1;
  const frames = samples.length < win ? 0 : Math.floor((samples.length - win) / hop) + 1;

  const hann = new Float64Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));

  const db = new Float32Array(frames * bins);
  const times = new Float64Array(frames);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let k = 0; k < frames; k++) {
    const start = k * hop;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < win; i++) re[i] = samples[start + i] * hann[i];
    fft(re, im);
    for (let b = 0; b < bins; b++) {
      const j = firstBin + b;
      db[k * bins + b] = 10 * Math.log10(re[j] * re[j] + im[j] * im[j] + 1e-20);
    }
    times[k] = (start + win / 2) / sampleRate;
  }
  return { sampleRate, times, frames, bins, binHz, minHz: firstBin * binHz, db };
}

const scratch = { buf: new Float32Array(0) };

/** Median by quickselect on a scratch copy: linear time, no allocation per call. */
export function median(values: Float32Array): number {
  const n = values.length;
  if (scratch.buf.length < n) scratch.buf = new Float32Array(n);
  const a = scratch.buf;
  a.set(values);
  const select = (k: number) => {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const pivot = a[(lo + hi) >> 1];
      let i = lo;
      let j = hi;
      while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) {
          const t = a[i];
          a[i] = a[j];
          a[j] = t;
          i++;
          j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return a[k];
    }
    return a[k];
  };
  const mid = n >> 1;
  if (n % 2) return select(mid);
  const upper = select(mid);
  let lower = -Infinity;
  for (let i = 0; i < mid; i++) if (a[i] > lower) lower = a[i];
  return (lower + upper) / 2;
}

/**
 * The evidence map: how much each cell stands out from its own background, in standard units.
 *
 * 1. Each frequency is compared with itself over the whole recording (median and MAD), so a hum
 *    that never stops (mains, fridge, ventilation) scores zero however loud it is.
 * 2. Each frame is compared with itself across frequencies, so a door slam or a gust, loud at
 *    every frequency for a moment, scores zero too.
 * 3. Each cell takes the best of its neighbours within `toleranceHz`: a model curve a little off
 *    still lands on the line. The map is then standardised again per frame, so noise averages zero.
 */
export function evidenceMap(spec: Spectrogram, toleranceHz = 0.5, tolerance = 0.0015): Float32Array {
  const { frames, bins, db } = spec;
  // ±toleranceHz, or ±0.15 % of the frequency when wider: the model's error is a fraction of a
  // m/s of radial speed, so it grows with the tone (2.7 Hz at a jet fan's 1.8 kHz).
  const reachOf = new Int32Array(bins);
  for (let b = 0; b < bins; b++) reachOf[b] = Math.max(0, Math.round(Math.max(toleranceHz, tolerance * (spec.minHz + b * spec.binHz)) / spec.binHz));
  const z = new Float32Array(frames * bins);
  const column = new Float32Array(frames);
  for (let b = 0; b < bins; b++) {
    for (let k = 0; k < frames; k++) column[k] = db[k * bins + b];
    const med = median(column);
    for (let k = 0; k < frames; k++) column[k] = Math.abs(column[k] - med);
    const scale = 1.4826 * median(column) + 1e-3;
    for (let k = 0; k < frames; k++) z[k * bins + b] = (db[k * bins + b] - med) / scale;
  }
  // Bins that share a reach form a band: a max over more neighbours runs higher, so each band is
  // standardised on its own, or the wide high bands would crush the narrow low ones.
  const bands: [number, number][] = [];
  for (let b = 0; b < bins; b++) {
    if (!bands.length || reachOf[b] !== reachOf[bands[bands.length - 1][0]]) bands.push([b, b + 1]);
    else bands[bands.length - 1][1] = b + 1;
  }
  const out = new Float32Array(frames * bins);
  for (let k = 0; k < frames; k++) {
    const row = z.subarray(k * bins, (k + 1) * bins);
    const med = median(row);
    for (let b = 0; b < bins; b++) row[b] = Math.min(10, Math.max(-4, row[b] - med));
    const o = k * bins;
    for (let b = 0; b < bins; b++) {
      let v = row[b];
      const reach = reachOf[b];
      for (let d = 1; d <= reach; d++) {
        if (b - d >= 0 && row[b - d] > v) v = row[b - d];
        if (b + d < bins && row[b + d] > v) v = row[b + d];
      }
      out[o + b] = v;
    }
    for (const [from, to] of bands) {
      let sum = 0;
      let sum2 = 0;
      for (let b = from; b < to; b++) {
        sum += out[o + b];
        sum2 += out[o + b] * out[o + b];
      }
      const n = to - from;
      const mean = sum / n;
      const std = Math.sqrt(Math.max(1e-9, sum2 / n - mean * mean));
      for (let b = from; b < to; b++) out[o + b] = (out[o + b] - mean) / std;
    }
  }
  return out;
}

/** One resolution of the recording: its spectrogram, its evidence map, and for every frame of
 * the base layer, the frame of this one centred nearest to it. */
export type Layer = { window: number; spec: Spectrogram; evidence: Float32Array; index: Int32Array };

/**
 * The recording at several window lengths, longest first; each halves the one before. A tone
 * whose pitch holds steady shows best through a long window, one sweeping fast (an aircraft
 * passing close overhead, up to ~10 Hz/s) through a short one: the matcher reads each moment of
 * each model curve from the layer that suits its slope. layers[0] is the base: its frames are the
 * time grid of every model curve, and the picture the page draws.
 */
export type Stack = { base: Spectrogram; evidence: Float32Array; layers: Layer[] };

export const WINDOWS = [2, 1, 0.5, 0.25];

export type StackOptions = {
  windows?: number[];
  hopSeconds?: number;
  minHz?: number;
  maxHz?: number;
  toleranceHz?: number;
  tolerance?: number;
  pad?: number;
  /** How far the stack has got, 0 to 1, after each window (a window costs its length). */
  onProgress?: (share: number) => void;
};

export function buildStack(samples: Float32Array, sampleRate: number, options: StackOptions = {}): Stack {
  // Up to 3.8 kHz: propellers and rotors sit below 500 Hz, but jet fans hum around 1 to 2 kHz
  // (evals/real-audio: the three 737s were found at 0.9 to 1.9 kHz, none below 1 kHz).
  const { windows = WINDOWS, hopSeconds = 0.25, minHz = 20, maxHz = 3800, toleranceHz = 0.5, tolerance = 0.0015, pad = 1, onProgress } = options;
  for (let i = 1; i < windows.length; i++) if (Math.abs(windows[i] * 2 - windows[i - 1]) > 1e-9) throw new Error("each window must halve the one before");
  const layers: Layer[] = [];
  const cost = windows.reduce((a, w) => a + w, 0);
  let done = 0;
  for (const window of windows) {
    const spec = computeSpectrogram(samples, sampleRate, { windowSeconds: window, hopSeconds, minHz, maxHz, pad });
    layers.push({ window, spec, evidence: evidenceMap(spec, toleranceHz, tolerance), index: new Int32Array(0) });
    done += window;
    onProgress?.(done / cost);
  }
  const base = layers[0].spec;
  const hop = Math.max(1, Math.round(hopSeconds * sampleRate)) / sampleRate;
  for (const layer of layers) {
    layer.index = new Int32Array(base.frames);
    for (let k = 0; k < base.frames; k++) layer.index[k] = Math.min(layer.spec.frames - 1, Math.max(0, Math.round((base.times[k] - layer.spec.times[0]) / hop)));
  }
  return { base, evidence: layers[0].evidence, layers };
}
