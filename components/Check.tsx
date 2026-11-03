"use client";

import Link from "next/link";
import type { Route } from "next";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/components/I18n";
import { TonePicture } from "@/components/TonePicture";
import { decode, troubleOf } from "@/lib/client/decode";
import { clock } from "@/lib/client/format";
import type { CheckEvent, CheckRequest, Found, Step } from "@/lib/client/check.worker";
import type { Picture } from "@/lib/core/leak";

// A file's aircraft tones, and taking them out: its sound is decoded here (Web Audio takes the
// audio of most video containers) and handed to a worker that does the rest; nothing of it is ever
// sent. The verdict, the actions and the tones keep their places as each arrives. `find` is the
// other thing to do with the tones (components/Where.tsx), `children` what it opens.

type Busy = { step: Step | "open"; done: number; total: number };
type Cleaned = { cleaned: (Found & { after: Picture })[]; left: Found[]; url: string };
type State = { kind: "failed"; error: string } | { kind: "open"; busy: Busy } | { kind: "found"; found: Found[]; busy?: Busy } | ({ kind: "cleaned"; busy?: Busy } & Cleaned);

/** Decoding happens at the rate of video sound; a file at another rate is resampled to it. */
const RATE = 48_000;

/** m:ss, or h:mm:ss past an hour. */
const at = (s: number) => (s < 3600 ? clock(s) : `${Math.floor(s / 3600)}:${clock(s % 3600).padStart(5, "0")}`);

/** The verdict's place, at the height of its longest wording, so nothing under it moves. */
const VERDICT = "flex min-h-16 items-center sm:min-h-13";
/** At one width whether it says "it" or "them", so the link beside it stays. */
const OUTLINE = "w-full rounded-full border border-line px-7 py-3 text-lg font-medium text-ink transition enabled:hover:border-mute disabled:cursor-not-allowed disabled:opacity-40 sm:w-fit sm:min-w-52";
const PRIMARY = "w-full rounded-full bg-amber px-7 py-3 text-center text-lg font-medium text-night transition hover:bg-amber-soft sm:w-fit";
const QUIET = "text-mute underline-offset-4 transition hover:text-ink hover:underline";

export function Check({ file, elsewhere, note, find, fold, children }: { file: File; elsewhere?: Route; note?: string | null; find?: (ready: boolean) => ReactNode; fold?: boolean; children?: ReactNode }) {
  const { m, fill, plural } = useI18n();
  const t = m.check;
  const [state, setState] = useState<State>({ kind: "open", busy: { step: "open", done: 0, total: 1 } });
  const name = file.name.replace(/\.[^.]+$/, "") || "recording";
  const worker = useRef<Worker | null>(null);
  const url = state.kind === "cleaned" ? state.url : null;

  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const onEvent = (e: CheckEvent) => {
    if (e.type === "progress") setState((s) => (s.kind === "failed" ? s : { ...s, busy: { step: e.step, done: e.done, total: e.total } }));
    else if (e.type === "found") setState({ kind: "found", found: e.found });
    else if (e.type === "cleaned") setState({ kind: "cleaned", cleaned: e.cleaned, left: e.left, url: URL.createObjectURL(e.wav) });
    else setState({ kind: "failed", error: fill(t.errors.failed, { message: e.message }) });
  };

  // After the first paint, so what the file says shows before decoding starts; once per file.
  useEffect(() => {
    let live = true;
    const start = setTimeout(async () => {
      let audio: Awaited<ReturnType<typeof decode>>;
      try {
        audio = await decode(file, RATE);
      } catch (err) {
        if (live) setState({ kind: "failed", error: t.errors[troubleOf(err)] });
        return;
      }
      if (!live) return;
      const w = new Worker(new URL("../lib/client/check.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<CheckEvent>) => onEvent(e.data);
      w.onerror = (e) => setState({ kind: "failed", error: fill(t.errors.failed, { message: e.message || "worker" }) });
      worker.current = w;
      setState({ kind: "open", busy: { step: "find", done: 0, total: 1 } });
      const request: CheckRequest = { type: "find", ...audio };
      w.postMessage(request, audio.channels.map((c) => c.buffer as ArrayBuffer));
    }, 30);
    return () => {
      live = false;
      clearTimeout(start);
      worker.current?.terminate();
      worker.current = null;
    };
    // The file alone starts this; the rest is read when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const cleanUp = () => {
    if (!worker.current) return;
    setState((s) => (s.kind === "failed" || s.kind === "open" ? s : { ...s, busy: { step: "clean", done: 0, total: 1 } }));
    const request: CheckRequest = { type: "clean" };
    worker.current.postMessage(request);
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

  const heard = state.kind === "found" ? state.found : null;
  const none = heard?.length === 0;
  const list = state.kind === "cleaned" ? [...state.left, ...state.cleaned] : (heard ?? []);
  const busy = state.kind === "failed" ? undefined : state.busy;

  return (
    <div className="flex flex-col gap-6" data-testid="check">
      <div className="flex flex-col gap-4">
        <div className={VERDICT} data-testid="check-slot">
          {state.kind === "open" && progress(state.busy)}
          {state.kind === "failed" && (
            <p role="alert" className="text-xl font-medium text-pretty text-amber-soft" data-testid="check-trouble">
              {state.error}
            </p>
          )}
          {state.kind !== "open" && state.kind !== "failed" && (
            <h2 className="text-2xl font-semibold tracking-tight text-balance" role="status" data-testid="check-verdict">
              {none ? t.none : state.kind === "found" ? plural(state.found.length, t.found) : state.left.length ? plural(state.left.length, t.left) : plural(state.cleaned.length, t.gone)}
            </h2>
          )}
        </div>

        {none && <p className="max-w-prose text-lg text-pretty text-mute">{t.noneText}</p>}

        {state.kind !== "failed" && !none && (
          // While it works, the progress line takes the button's place, at its height.
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
            {find?.(state.kind !== "open")}
            {state.kind === "open" && (
              <button type="button" disabled className={OUTLINE}>
                {t.clean.other}
              </button>
            )}
            {state.kind === "found" &&
              (busy ? (
                progress(busy)
              ) : (
                <button type="button" onClick={cleanUp} className={OUTLINE} data-testid="check-clean">
                  {plural(state.found.length, t.clean)}
                </button>
              ))}
            {state.kind === "cleaned" &&
              (busy ? (
                progress(busy)
              ) : (
                <>
                  <a href={state.url} download={`${name}-${t.suffix}.wav`} className={PRIMARY} data-testid="check-download">
                    {t.download}
                  </a>
                  {state.left.length > 0 && (
                    <button type="button" onClick={cleanUp} className={OUTLINE} data-testid="check-clean">
                      {plural(state.left.length, t.clean)}
                    </button>
                  )}
                </>
              ))}
            {elsewhere && (
              <Link href={elsewhere} className={`${QUIET} sm:ml-2`} data-testid="check-elsewhere">
                {t.elsewhere} <span aria-hidden>→</span>
              </Link>
            )}
          </div>
        )}

        {note && (
          <p className="text-pretty text-amber-soft" data-testid="where-offline">
            {note}
          </p>
        )}
        {state.kind === "cleaned" && <p className="max-w-prose text-sm text-pretty text-faint">{state.left.length ? `${t.leftText} ` : ""}{t.remux}</p>}
      </div>

      {children}

      {/* The search's own answer shows the tones it explains: here they step aside, a tap away, so its answer stays together. */}
      {list.length > 0 &&
        (fold && state.kind === "found" ? (
          <details className="group" data-testid="check-fold">
            <summary className={`${QUIET} w-fit cursor-pointer`}>{plural(list.length, t.fold)}</summary>
            <div className="mt-4">{tones(list)}</div>
          </details>
        ) : (
          tones(list)
        ))}
    </div>
  );
}

function Chip({ children }: { children: string }) {
  return <span className="pointer-events-none absolute top-1.5 right-2 rounded-full bg-night/80 px-2 py-0.5 font-mono text-[10px] tracking-wide text-mute uppercase">{children}</span>;
}
