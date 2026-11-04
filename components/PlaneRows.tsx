"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/components/I18n";
import { soundToRead } from "@/lib/client/decode";
import { revealed, speedFor } from "@/lib/client/reveal";
import { aircraftType } from "@/lib/client/types";
import type { Tone } from "@/lib/core/leak";
import type { Guess, Plane } from "@/lib/client/where.worker";

// One row per plane of a named answer, each with the file's own sound around that plane's pass: the
// seconds around its closest moment, faster and filtered to the band its hum went through (reveal.ts).
// Nothing is synthesised, and one plays at a time. Ready before the click, so that a phone's browser
// lets the click start it.

/** Seconds of the file on either side of a plane's closest moment. */
const AROUND = 20;

async function clipOf(file: File, plane: Plane, start: number, tone: Tone): Promise<string> {
  const { channels, sampleRate } = await soundToRead(file);
  const length = channels[0]?.length ?? 0;
  const from = Math.max(0, Math.round((plane.at - start - AROUND) * sampleRate));
  const to = Math.min(length, Math.round((plane.at - start + AROUND) * sampleRate));
  const mono = new Float32Array(Math.max(0, to - from));
  for (const c of channels) for (let i = 0; i < mono.length; i++) mono[i] += c[from + i] / channels.length;
  const lo = Math.min(...tone.freq);
  const hi = Math.max(...tone.freq);
  return revealed(mono, sampleRate, lo, hi, speedFor(lo, hi));
}

export function PlaneRows({ file, guess, views, timeOf }: { file: File; guess: Guess; views: Record<number, { tone: Tone } | undefined>; timeOf: (utc: number) => string }) {
  const { m, f, fill } = useI18n();
  const a = m.answer;
  const [clips, setClips] = useState<Record<string, string>>({});
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let live = true;
    const made: string[] = [];
    void (async () => {
      // One after the other: nothing here is urgent enough to stutter the map as it draws.
      for (const p of guess.planes) {
        const tone = views[p.tone]?.tone;
        if (!tone) continue;
        const url = await clipOf(file, p, guess.start, tone).catch(() => null);
        if (!url) continue;
        if (!live) return URL.revokeObjectURL(url);
        made.push(url);
        setClips((c) => ({ ...c, [p.hex]: url }));
      }
    })();
    return () => {
      live = false;
      made.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [file, guess, views]);

  const toggle = (hex: string) => {
    const el = audio.current;
    if (!el) return;
    if (playing === hex) {
      el.pause();
      setPlaying(null);
      return;
    }
    el.src = clips[hex];
    setPlaying(hex);
    void el.play().catch(() => setPlaying(null));
  };

  const any = guess.planes.some((p) => clips[p.hex]);
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col border-b border-line" data-testid="answer-planes">
        {guess.planes.map((p) => {
          const tail = p.registration || p.hex;
          const on = playing === p.hex;
          return (
            <li key={p.hex} className="flex min-w-0 items-center gap-4 border-t border-line py-3" data-testid="answer-plane">
              {/* Its place from the first moment: nothing moves when the clip is ready. */}
              <button
                type="button"
                disabled={!clips[p.hex]}
                aria-pressed={on}
                aria-label={fill(on ? a.pause : a.hear, { plane: tail })}
                onClick={() => toggle(p.hex)}
                className="flex size-11 shrink-0 items-center justify-center rounded-full border border-line text-amber-soft transition hover:border-mute disabled:opacity-40"
                data-testid="answer-plane-play"
              >
                <svg aria-hidden viewBox="0 0 16 16" className="size-4 fill-current">
                  {on ? <path d="M4 3h3v10H4zM9 3h3v10H9z" /> : <path d="M5 3l8 5-8 5z" />}
                </svg>
              </button>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-ink">{aircraftType(p.type)?.name ?? (p.type || a.planeUnknown)}</span>
                <span className="text-sm text-pretty text-mute tabular-nums">{fill(a.plane, { tail, distance: f.km(p.metres), time: timeOf(p.at) })}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {any && <p className="text-sm text-pretty text-faint" data-testid="answer-sound-note">{a.soundNote}</p>}
      <audio ref={audio} onEnded={() => setPlaying(null)} data-testid="answer-plane-audio" />
    </div>
  );
}
