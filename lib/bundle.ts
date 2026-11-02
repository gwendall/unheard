// A capture bundle: one real recording exactly as the page analysed it (8 kHz samples, its
// start time, the listener, the air, every poll), plus what the page answered and, once a human
// has checked, the truth. The page's capture mode downloads one; evals/fixtures/real/ keeps them
// and the real-audio eval replays them through the same analyze() as production.

import type { Poll } from "./adsb";
import type { Air } from "./core/doppler";
import type { Listener } from "./core/geo";
import type { Recording } from "./core/pipeline";

export type Bundle = {
  version: 1;
  /** ISO time the bundle was made. */
  capturedAt: string;
  /** Build that made it (commit SHA when known). */
  app: string;
  recording: {
    sampleRate: number;
    start: number;
    listener: Listener;
    air: Air;
    polls: Poll[];
    /** 16-bit mono WAV, base64. */
    wav: string;
  };
  device?: { userAgent: string; inputSampleRate: number; settings?: Record<string, unknown> };
  /** What the page said at the time. */
  answer?: { kind: string; id: string | null; score: number | null; f0: number | null; clock: number | null };
  /** Filled in by a human: the hex heard (null when no aircraft could be heard), and why we know. */
  truth?: { heard: string | null; note: string };
};

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (o: number, s: string) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  // Scale to the loudest sample so a faint recording keeps its 16 bits of detail.
  let peak = 1e-9;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const scale = 32767 / peak;
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(samples[i] * scale), true);
  return bytes;
}

export function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(24, true);
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(o, o + 4));
    const size = view.getUint32(o + 4, true);
    if (id === "data") {
      const n = size / 2;
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = view.getInt16(o + 8 + i * 2, true) / 32768;
      return { samples, sampleRate };
    }
    o += 8 + size;
  }
  throw new Error("no data chunk in WAV");
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function makeBundle(rec: Recording, extra: Pick<Bundle, "app" | "device" | "answer">): Bundle {
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    ...extra,
    recording: {
      sampleRate: rec.sampleRate,
      start: rec.start,
      listener: rec.listener,
      air: rec.air,
      polls: rec.polls,
      wav: toBase64(encodeWav(rec.samples, rec.sampleRate)),
    },
  };
}

export function recordingOf(bundle: Bundle): Recording {
  const { samples, sampleRate } = decodeWav(fromBase64(bundle.recording.wav));
  const r = bundle.recording;
  return { samples, sampleRate, start: r.start, listener: r.listener, air: r.air, polls: r.polls };
}
