// The plane made audible. A light aircraft hums around 60 to 150 Hz: under the wind for the ear,
// and under what a phone speaker can play. Played back faster, the recording rises by as many
// octaves (four times faster: two octaves, 90 Hz becomes 360 Hz), and filtered to the band where
// the plane's curve lies, its hum comes out of the noise. The sound is the recording itself, only
// faster and filtered: nothing is synthesised.

import { encodeWav } from "../bundle";

/** Where the revealed hum should land: comfortably inside a phone speaker's range. */
const TARGET_HZ = 400;
const SPEEDS = [1, 2, 4, 8];

/** How many times faster to play a band so that it lands near TARGET_HZ. */
export function speedFor(lo: number, hi: number): number {
  const center = Math.sqrt(Math.max(1, lo) * Math.max(lo + 1, hi));
  const want = TARGET_HZ / center;
  return SPEEDS.reduce((best, s) => (Math.abs(Math.log(s / want)) < Math.abs(Math.log(best / want)) ? s : best), 1);
}

/** Scales a signal so its loudest sample sits at `peak`. */
export function normalize(samples: Float32Array, peak = 0.9): Float32Array {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  if (max === 0) return samples;
  const k = peak / max;
  return samples.map((s) => s * k);
}

/** The recording as heard, louder, as a WAV blob URL. */
export function asHeard(samples: Float32Array, sampleRate: number): string {
  return URL.createObjectURL(new Blob([encodeWav(normalize(samples), sampleRate).slice().buffer], { type: "audio/wav" }));
}

/**
 * The recording sped up `speed` times and band-passed to [lo, hi] (the band of the plane's curve,
 * before speeding up), rendered offline and normalised, as a WAV blob URL.
 */
export async function revealed(samples: Float32Array, sampleRate: number, lo: number, hi: number, speed: number): Promise<string> {
  const outRate = sampleRate * speed;
  const ctx = new OfflineAudioContext(1, samples.length, outRate);
  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples.slice(), 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = speed;
  // Two high-pass and two low-pass stages: steep enough to leave the wind and the hiss out.
  let node: AudioNode = source;
  for (const [type, freq] of [
    ["highpass", lo * 0.85 * speed],
    ["highpass", lo * 0.85 * speed],
    ["lowpass", hi * 1.15 * speed],
    ["lowpass", hi * 1.15 * speed],
  ] as const) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.min(freq, outRate / 2 - 1);
    f.Q.value = Math.SQRT1_2;
    node.connect(f);
    node = f;
  }
  node.connect(ctx.destination);
  source.start();
  // `samples.length` frames at `speed` times the rate: the whole recording, `speed` times shorter.
  const out = (await ctx.startRendering()).getChannelData(0);
  // Fade in and out over 50 ms: no click where the filters start and stop.
  const fade = Math.min(out.length >> 1, Math.round(outRate * 0.05));
  for (let i = 0; i < fade; i++) {
    out[i] *= i / fade;
    out[out.length - 1 - i] *= i / fade;
  }
  return URL.createObjectURL(new Blob([encodeWav(normalize(out), outRate).slice().buffer], { type: "audio/wav" }));
}
