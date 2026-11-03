"use client";

import Link from "next/link";
import type { Route } from "next";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { useI18n } from "@/components/I18n";
import { TonePicture } from "@/components/TonePicture";
import { clock } from "@/lib/client/format";
import type { CheckEvent, CheckRequest, Found, Step } from "@/lib/client/check.worker";
import type { Picture } from "@/lib/core/leak";

// The check, in the place of the drop zone: a file in, its aircraft tones, then the same file with
// them taken out. The sound is decoded here (Web Audio takes the audio of most video containers)
// and handed to a worker that does the rest; nothing of it is ever sent.

type Busy = { step: Step | "open"; done: number; total: number };
type Cleaned = { cleaned: (Found & { after: Picture })[]; left: Found[]; url: string };
type State =
  | { kind: "idle"; error?: string }
  | { kind: "open"; busy: Busy }
  | { kind: "found"; found: Found[]; busy?: Busy }
  | ({ kind: "cleaned"; busy?: Busy } & Cleaned);

/** Decoding happens at the rate of video sound; a file at another rate is resampled to it. */
const RATE = 48_000;

async function decode(file: File): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  const bytes = await file.arrayBuffer();
  const buffer = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(bytes);
  // Two channels at most: the cleaned file goes back under a video, left and right.
  const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c).slice());
  return { channels, sampleRate: buffer.sampleRate };
}

/** m:ss, or h:mm:ss past an hour. */
const at = (s: number) => (s < 3600 ? clock(s) : `${Math.floor(s / 3600)}:${clock(s % 3600).padStart(5, "0")}`);

export function Check({ elsewhere }: { elsewhere?: Route }) {
  const { m, fill, plural } = useI18n();
  const t = m.check;
  const [state, setState] = useState<State>({ kind: "idle" });
  const [over, setOver] = useState(false);
  const [name, setName] = useState("recording");
  const worker = useRef<Worker | null>(null);
  const url = state.kind === "cleaned" ? state.url : null;

  useEffect(() => () => worker.current?.terminate(), []);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const reset = () => {
    worker.current?.terminate();
    worker.current = null;
    setState({ kind: "idle" });
  };

  const onEvent = (e: CheckEvent) => {
    if (e.type === "progress") setState((s) => (s.kind === "idle" ? s : { ...s, busy: { step: e.step, done: e.done, total: e.total } }));
    else if (e.type === "found") setState({ kind: "found", found: e.found });
    else if (e.type === "cleaned") setState({ kind: "cleaned", cleaned: e.cleaned, left: e.left, url: URL.createObjectURL(e.wav) });
    else setState({ kind: "idle", error: fill(t.errors.failed, { message: e.message }) });
  };

  const open = async (file: File | undefined) => {
    if (!file) return;
    reset();
    setName(file.name.replace(/\.[^.]+$/, "") || "recording");
    setState({ kind: "open", busy: { step: "open", done: 0, total: 1 } });
    let audio: Awaited<ReturnType<typeof decode>>;
    try {
      audio = await decode(file);
    } catch {
      setState({ kind: "idle", error: t.errors.open });
      return;
    }
    const w = new Worker(new URL("../lib/client/check.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<CheckEvent>) => onEvent(e.data);
    w.onerror = (e) => setState({ kind: "idle", error: fill(t.errors.failed, { message: e.message || "worker" }) });
    worker.current = w;
    setState({ kind: "open", busy: { step: "find", done: 0, total: 1 } });
    const request: CheckRequest = { type: "find", ...audio };
    w.postMessage(request, audio.channels.map((c) => c.buffer as ArrayBuffer));
  };

  const cleanUp = () => {
    if (!worker.current) return;
    setState((s) => (s.kind === "idle" || s.kind === "open" ? s : { ...s, busy: { step: "clean", done: 0, total: 1 } }));
    const request: CheckRequest = { type: "clean" };
    worker.current.postMessage(request);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void open(e.dataTransfer.files[0]);
  };

  const progress = (busy: Busy) => {
    const n = Math.round((100 * busy.done) / Math.max(1, busy.total));
    const text = busy.step === "open" ? t.steps.open : busy.step === "write" ? t.steps.write : fill(t.steps[busy.step], { n });
    return (
      <p className="flex min-h-13 items-center gap-3 font-mono text-sm text-mute tabular-nums" role="status" data-testid="check-progress">
        <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-amber" />
        {text}
      </p>
    );
  };

  const caption = (f: Found) => {
    const { times, freq, confidence } = f.tone;
    const sure = confidence >= 20 ? t.sure.clear : confidence >= 8 ? t.sure.likely : t.sure.faint;
    return fill(t.tone, { start: at(times[0]), end: at(times[times.length - 1]), from: Math.round(freq[0]), to: Math.round(freq[freq.length - 1]), sure });
  };

  const tones = (list: (Found & { after?: Picture })[]) => (
    <ul className="flex flex-col gap-6" data-testid="check-tones">
      {list.map((f) => (
        <li key={`${f.tone.times[0]}-${f.tone.freq[0]}`} className="flex flex-col gap-2">
          <p className="text-sm text-pretty text-mute tabular-nums">{caption(f)}</p>
          <div className="relative">
            <TonePicture picture={f.before} tone={f.tone} />
            {f.after && <Chip>{t.before}</Chip>}
          </div>
          {f.after && (
            <div className="relative">
              <TonePicture picture={f.after} tone={f.tone} />
              <Chip>{t.after}</Chip>
            </div>
          )}
        </li>
      ))}
    </ul>
  );

  const button = "w-full rounded-full bg-amber px-7 py-3 text-lg font-medium text-night transition hover:bg-amber-soft sm:w-fit";
  const quiet = "text-mute underline-offset-4 transition hover:text-ink hover:underline";

  return (
    <section className="flex min-h-72 flex-col rounded-3xl border border-line bg-deep/70 p-5 sm:p-8" aria-live="polite" data-testid="check">
      {state.kind === "idle" && (
        <label
          className={`flex grow cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-5 py-10 text-center transition has-[input:focus-visible]:border-amber ${over ? "border-amber bg-amber/5" : "border-line hover:border-mute"}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          data-testid="check-drop"
        >
          <input type="file" accept="audio/*,video/*" className="sr-only" onChange={(e) => void open(e.target.files?.[0])} data-testid="check-file" />
          <span className={button}>{t.choose}</span>
          <span className="text-mute">{t.drop}</span>
          <span className="text-sm text-faint">{t.formats}</span>
          {state.error && (
            <span role="alert" className="mt-2 rounded-2xl border border-amber/40 bg-amber/10 px-4 py-3 text-pretty text-amber-soft">
              {state.error}
            </span>
          )}
        </label>
      )}

      {state.kind === "open" && <div className="flex grow flex-col justify-center gap-2">{progress(state.busy)}</div>}

      {state.kind === "found" && state.found.length > 0 && (
        <div className="flex flex-col gap-8">
          <header className="flex flex-col gap-4">
            <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl" data-testid="check-verdict">
              {plural(state.found.length, t.found)}
            </h2>
            <p className="max-w-prose text-lg text-pretty text-mute">{plural(state.found.length, t.foundText)}</p>
            {/* While it works, the progress line takes the button's place, at its height. */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
              {state.busy ? (
                progress(state.busy)
              ) : (
                <button type="button" onClick={cleanUp} className={button} data-testid="check-clean">
                  {plural(state.found.length, t.clean)}
                </button>
              )}
              {elsewhere && (
                <Link href={elsewhere} className={quiet}>
                  {t.elsewhere} <span aria-hidden>→</span>
                </Link>
              )}
            </div>
          </header>
          {tones(state.found)}
        </div>
      )}

      {state.kind === "found" && state.found.length === 0 && (
        <header className="flex flex-col gap-4">
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl" data-testid="check-verdict">
            {t.none}
          </h2>
          <p className="max-w-prose text-lg text-pretty text-mute">{t.noneText}</p>
          <button type="button" onClick={reset} className={`${quiet} w-fit`} data-testid="check-another">
            {t.another}
          </button>
        </header>
      )}

      {state.kind === "cleaned" && (
        <div className="flex flex-col gap-8">
          <header className="flex flex-col gap-4">
            <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl" data-testid="check-verdict">
              {state.left.length ? plural(state.left.length, t.left) : plural(state.cleaned.length, t.gone)}
            </h2>
            <p className="max-w-prose text-lg text-pretty text-mute">{state.left.length ? t.leftText : t.goneText}</p>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
              {state.busy ? (
                progress(state.busy)
              ) : (
                <a href={state.url} download={`${name}-${t.suffix}.wav`} className={`${button} text-center`} data-testid="check-download">
                  {t.download}
                </a>
              )}
              {state.left.length > 0 && (
                <button type="button" onClick={cleanUp} disabled={!!state.busy} className={`${quiet} w-fit disabled:opacity-50`} data-testid="check-clean">
                  {plural(state.left.length, t.clean)}
                </button>
              )}
            </div>
            <p className="max-w-prose text-sm text-pretty text-faint">{t.remux}</p>
          </header>
          {tones([...state.left, ...state.cleaned])}
          <button type="button" onClick={reset} className={`${quiet} w-fit`} data-testid="check-another">
            {t.another}
          </button>
        </div>
      )}
    </section>
  );
}

function Chip({ children }: { children: string }) {
  return <span className="pointer-events-none absolute top-1.5 right-2 rounded-full bg-night/80 px-2 py-0.5 font-mono text-[10px] tracking-wide text-mute uppercase">{children}</span>;
}
