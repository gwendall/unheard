"use client";

import Link from "next/link";
import type { Route } from "next";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bar } from "@/components/Bar";
import { useI18n } from "@/components/I18n";
import { TonePicture } from "@/components/TonePicture";
import { decode, troubleOf } from "@/lib/client/decode";
import { isPhone } from "@/lib/client/device";
import { forget, newFolder } from "@/lib/client/folder";
import { clock, timeLeft } from "@/lib/client/format";
import type { CheckEvent, CheckPartial, CheckRequest, Found, Kind, Removed, Step } from "@/lib/client/check.worker";
import type { Picture, Tone, View } from "@/lib/core/leak";

// A file's aircraft tones, and taking them out. A worker does it all, reading the file as a stream;
// when it cannot, the sound is decoded here (Web Audio takes the audio of most video containers, the
// whole file at once) and handed to it. Nothing of it is ever sent. The verdict, the actions and the
// tones keep their places as each arrives. `find` is the other thing to do with the file
// (components/Where.tsx), `children` what it opens: neither waits for the tones. `hold`: a search is
// running, and finding the tones starts again after it, so a phone never does both; `heard` is what
// that search has found meanwhile. `answered`: what `children` opened has its answer, which comes
// first, with `facts` and the rest under it, quieter.

/** Tones so far, and where each lies. */
export type Heard = { tone: Tone; view: View }[];

/** `fraction` and `left`: the whole job's, from the worker, once it has started. */
type Busy = { step: Step; done: number; total: number; fraction?: number; left?: number | null };
type Cleaned = { cleaned: Found[]; left: Found[]; url: string; written: Kind };
/** On the page: a tone the worker has told it of has an id, and its pictures for the asking. */
type Shown = Heard[number] & { id?: number; gone?: boolean };
/** A tone's pictures, once drawn. */
type Drawn = { before: Picture; after?: Picture };
type State = { kind: "failed"; error: string } | { kind: "open"; busy: Busy; soFar?: Heard } | { kind: "found"; found: Found[]; busy?: Busy } | ({ kind: "cleaned"; busy?: Busy } & Cleaned);

/**
 * Web Audio resamples to the rate it is asked for, and taking tones out costs in proportion to the
 * rate: it is asked for the file's own. This one is for a file whose container does not say, and
 * below this floor a browser may refuse.
 */
const RATE = 48_000;
const LOWEST = 8_000;

/** m:ss, or h:mm:ss past an hour. */
const at = (s: number) => (s < 3600 ? clock(s) : `${Math.floor(s / 3600)}:${clock(s % 3600).padStart(5, "0")}`);

const blanks = new WeakMap<View, Picture>();
/** A tone's curve goes on a dark picture of the same size until the real one comes. The same one each time, so nothing is painted again. */
function blank(view: View): Picture {
  const known = blanks.get(view);
  if (known) return known;
  const picture = { ...view, width: 1, height: 1, cells: new Uint8Array(1) };
  blanks.set(view, picture);
  return picture;
}

/** The check and a search find the same tones in the same order of the file: whichever has got further, so the list only grows. */
const further = (a: Heard = [], b: Heard = []) => (b.length > a.length ? b : a);

/** In the file's order, so a tone that arrives later never moves those above it. */
const inOrder = <T extends Shown>(list: T[]) => [...list].sort((a, b) => a.tone.times[0] - b.tone.times[0]);

/** The tones on the page without asking: the strongest. A real hour holds dozens, each a tall panel. */
const SHOWN = 3;

/** The verdict's place, at the height of its longest wording, so nothing under it moves. */
const VERDICT = "flex min-h-16 items-center sm:min-h-13";
/** At one width whether it says "it" or "them", so the link beside it stays. */
const OUTLINE = "w-full rounded-full border border-line px-7 py-3 text-lg font-medium text-ink transition enabled:hover:border-mute disabled:cursor-not-allowed disabled:opacity-40 sm:w-fit sm:min-w-52";
const PRIMARY = "w-full rounded-full bg-amber px-7 py-3 text-center text-lg font-medium text-night transition hover:bg-amber-soft sm:w-fit";
const QUIET = "text-mute underline-offset-4 transition hover:text-ink hover:underline";

export function Check({ file, elsewhere, note, facts, find, fold, hold, heard, answered, onSettled, children }: { file: File; elsewhere?: Route; note?: string | null; facts?: ReactNode; find?: ReactNode; fold?: boolean; hold?: boolean; heard?: Heard | null; answered?: boolean; onSettled?: () => void; children?: ReactNode }) {
  const { m, fill, plural, locale } = useI18n();
  const t = m.check;
  const [state, setState] = useState<State>({ kind: "open", busy: { step: "open", done: 0, total: 1 } });
  const [drawn, setDrawn] = useState<Record<number, Drawn>>({});
  const [workers, setWorkers] = useState<number | undefined>();
  const name = file.name.replace(/\.[^.]+$/, "") || "recording";
  const worker = useRef<Worker | null>(null);
  const folder = useRef<string | null>(null);
  const asked = useRef(new Set<number>());
  const url = state.kind === "cleaned" ? state.url : null;

  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const opening = state.kind === "open";
  useEffect(() => {
    if (!opening) onSettled?.();
  }, [opening, onSettled]);

  /** The worker cannot read this file: Web Audio may, here, the whole file at once. */
  const decodeHere = async (w: Worker, rate: number | undefined) => {
    try {
      const audio = await decode(file, rate && rate >= LOWEST ? rate : RATE);
      const request: CheckRequest = { type: "sound", ...audio };
      w.postMessage(request, audio.channels.map((c) => c.buffer as ArrayBuffer));
    } catch (err) {
      setState({ kind: "failed", error: t.errors[troubleOf(err)] });
    }
  };

  const onEvent = (e: CheckEvent | CheckPartial, w: Worker) => {
    if (e.type === "progress") setState((s) => (s.kind === "failed" ? s : { ...s, busy: { step: e.step, done: e.done, total: e.total, fraction: e.fraction, left: e.secondsLeft } }));
    else if (e.type === "tones") setState((s) => (s.kind === "open" ? { ...s, soFar: further(s.soFar, e.tones) } : s));
    else if (e.type === "decode-here") void decodeHere(w, e.sampleRate);
    else if (e.type === "no-sound") setState({ kind: "failed", error: t.errors.noSound });
    else if (e.type === "found") setState({ kind: "found", found: e.found });
    else if (e.type === "workers") setWorkers(e.count);
    else if (e.type === "drawn") setDrawn((d) => ({ ...d, [e.id]: { before: e.before, after: e.after } }));
    else if (e.type === "cleaned") setState({ kind: "cleaned", cleaned: e.cleaned, left: e.left, url: URL.createObjectURL(e.file), written: e });
    else setState({ kind: "failed", error: fill(t.errors.failed, { message: e.message }) });
  };

  // After the first paint, so what the file says shows before the work starts; once per file, and
  // once more after a search that came before the end. Going stops the work and clears what it kept
  // on this device.
  const waiting = !!hold && state.kind === "open";
  useEffect(() => {
    if (waiting) return;
    const start = setTimeout(() => {
      setState((s) => (s.kind === "open" ? { ...s, busy: { step: "open", done: 0, total: 1 } } : s));
      asked.current.clear();
      setDrawn({});
      const w = new Worker(new URL("../lib/client/check.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<CheckEvent | CheckPartial>) => onEvent(e.data, w);
      w.onerror = (e) => setState({ kind: "failed", error: fill(t.errors.failed, { message: e.message || "worker" }) });
      worker.current = w;
      folder.current = newFolder();
      const request: CheckRequest = { type: "open", file, folder: folder.current, partial: true, phone: isPhone() };
      w.postMessage(request);
    }, 30);
    return () => {
      clearTimeout(start);
      // A worker let go while it still loads its scripts reports that as an error: it no longer speaks for this file.
      if (worker.current) worker.current.onerror = worker.current.onmessage = null;
      worker.current?.terminate();
      worker.current = null;
      if (folder.current) void forget(folder.current);
      folder.current = null;
    };
    // The file and the search alone start this; the rest is read when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, waiting]);

  const cleanUp = () => {
    if (!worker.current) return;
    setState((s) => (s.kind === "failed" || s.kind === "open" ? s : { ...s, busy: { step: "clean", done: 0, total: 1 } }));
    const request: CheckRequest = { type: "clean" };
    worker.current.postMessage(request);
  };

  /** A tone's pictures, the first time it is on the page. */
  const ask = useCallback((id: number) => {
    if (asked.current.has(id)) return;
    asked.current.add(id);
    const request: CheckRequest = { type: "draw", id };
    worker.current?.postMessage(request);
  }, []);

  const progress = (busy: Busy, wide = false) => {
    const n = Math.round(100 * (busy.fraction ?? busy.done / Math.max(1, busy.total)));
    const text = fill(t.steps[busy.step], { n });
    const left = busy.left == null ? "" : ` ${timeLeft(busy.left, m.where, fill)}`;
    return (
      <div className={`flex min-h-13 flex-col justify-center gap-2 ${wide ? "w-full" : "w-full sm:w-fit sm:min-w-52"}`}>
        <p className="flex items-center gap-3 font-mono text-sm text-mute tabular-nums" role="status" data-testid="check-progress">
          <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-amber" />
          {text}
          {left}
        </p>
        <Bar fraction={busy.fraction ?? 0} label={text} testid="check-bar" />
      </div>
    );
  };

  const caption = (f: Shown) => {
    const { times, freq, confidence } = f.tone;
    const sure = confidence >= 20 ? t.sure.clear : confidence >= 8 ? t.sure.likely : t.sure.faint;
    return fill(t.tone, { start: at(times[0]), end: at(times[times.length - 1]), from: Math.round(freq[0]), to: Math.round(freq[freq.length - 1]), sure });
  };

  const tones = (list: Shown[], testid = "check-tones") => (
    <ul className="flex flex-col gap-6" data-testid={testid}>
      {list.map((f) => {
        const pictures = f.id === undefined ? undefined : drawn[f.id];
        return (
          <li key={`${f.tone.times[0]}-${f.tone.freq[0]}`} className="flex flex-col gap-2">
            {f.id !== undefined && <Asks id={f.id} ask={ask} />}
            <p className="text-sm text-pretty text-mute tabular-nums">{caption(f)}</p>
            <div className="relative">
              <TonePicture picture={pictures?.before ?? blank(f.view)} tone={f.tone} />
              {f.gone && <Chip>{t.before}</Chip>}
            </div>
            {f.gone && (
              <div className="relative">
                <TonePicture picture={pictures?.after ?? blank(f.view)} tone={f.tone} />
                <Chip>{t.after}</Chip>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );

  /** What the video said about itself and the new file does not, named from what it really held. */
  const removedLine = ({ createdAt, location, device, tracks }: Removed) => {
    const items: string[] = [];
    if (location) items.push(fill(t.video.place, { place: `${location.lat.toFixed(3)}, ${location.lon.toFixed(3)}` }));
    if (createdAt) {
      const day = new Date((createdAt.utc + (createdAt.offsetMinutes ?? 0) * 60) * 1000);
      items.push(fill(t.video.date, { date: new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(day) }));
    }
    if (device) items.push(fill(t.video.device, { device }));
    if (tracks > 0) items.push(plural(tracks, t.video.tracks));
    return items.length ? fill(t.video.removed, { list: new Intl.ListFormat(locale).format(items) }) : t.video.nothing;
  };

  const soFar = state.kind === "open" ? state.soFar : undefined;
  const sketches: Shown[] = further(soFar, heard ?? undefined);

  const found = state.kind === "found" ? state.found : null;
  const none = found?.length === 0;
  const list: Shown[] = state.kind === "cleaned" ? [...state.left, ...state.cleaned] : (found ?? (state.kind === "open" ? sketches : []));
  const strongest = [...list].sort((a, b) => b.tone.confidence - a.tone.confidence).slice(0, SHOWN);
  const others = list.filter((f) => !strongest.includes(f));
  const busy = state.kind === "failed" ? undefined : state.busy;

  const findings = (
    <div className="flex flex-col gap-6">
      {facts}
      <div className="flex flex-col gap-4">
        <div className={VERDICT} data-testid="check-slot">
          {state.kind === "open" &&
            (hold ? (
              <p className="font-mono text-sm text-pretty text-mute" role="status" data-testid="check-held">
                {t.steps.held}
              </p>
            ) : (
              progress(state.busy, true)
            ))}
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

        {none && !fold && <p className="max-w-prose text-lg text-pretty text-mute">{t.noneText}</p>}

        {/* A search already open keeps its place, whatever this look comes to. */}
        {(fold || (state.kind !== "failed" && !none)) && (
          // While it works, the progress line takes the button's place, at its height.
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
            {find}
            {/* Held in its place with nothing to take out, so that a search open under it does not move. */}
            {(state.kind === "open" || (none && !answered)) && (
              <button type="button" disabled className={OUTLINE}>
                {t.clean.other}
              </button>
            )}
            {state.kind === "found" &&
              !none &&
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
                  <a href={state.url} download={`${name}-${t.suffix}.${state.written.extension}`} className={answered ? `${OUTLINE} text-center hover:border-mute` : PRIMARY} data-testid="check-download">
                    {state.written.video ? t.video.download : t.download}
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
        {state.kind === "cleaned" && (
          <div className="flex max-w-prose flex-col gap-2 text-sm text-pretty text-faint" data-testid="check-about">
            {state.left.length > 0 && <p>{t.leftText}</p>}
            {state.written.video ? (
              <>
                <p>{t.video.kept}</p>
                <p data-testid="check-removed">{removedLine(state.written.removed)}</p>
                <p data-testid="check-seen">{t.video.seen}</p>
              </>
            ) : (
              <>
                {state.written.why && <p data-testid="check-why">{t.video.why[state.written.why]}</p>}
                <p>{t.remux}</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-6" data-testid="check" data-workers={workers}>
      {/* Above what the search opens until it has its answer, then under it. `children` keeps its place, and its state, between the two. */}
      {!answered && findings}

      {children}

      {answered && findings}

      {/* Under the search, so that what it has on the page stays where it is. */}
      {none && fold && <p className="max-w-prose text-lg text-pretty text-mute">{t.noneSearch}</p>}

      {/* The search's own answer shows the tones it explains: here they step aside, a tap away, so its answer stays together. */}
      {/* No count before the check's own: pieces of one tone may still be joined, and the search's come cut differently. */}
      {list.length > 0 &&
        (answered ? (
          <Folded summary={state.kind === "open" ? t.soFar : plural(list.length, t.fold)} testid="check-fold">
            {tones(inOrder(list))}
          </Folded>
        ) : (
          <div className="flex flex-col gap-6">
            {tones(inOrder(strongest))}
            {others.length > 0 && (
              <Folded summary={state.kind === "open" ? t.soFar : fill(t.all, { n: list.length })} testid="check-all">
                {tones(inOrder(others), "check-others")}
              </Folded>
            )}
          </div>
        ))}
    </div>
  );
}

/** On the page: ask for what it shows, and only then. */
function Asks({ id, ask }: { id: number; ask: (id: number) => void }) {
  useEffect(() => ask(id), [id, ask]);
  return null;
}

/** What opens is not drawn until it is opened, and goes again when it is closed: dozens of panels weigh on a phone. */
function Folded({ summary, testid, children }: { summary: string; testid: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details data-testid={testid} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className={`${QUIET} w-fit cursor-pointer`}>{summary}</summary>
      {open && <div className="mt-6">{children}</div>}
    </details>
  );
}

function Chip({ children }: { children: string }) {
  return <span className="pointer-events-none absolute top-1.5 right-2 rounded-full bg-night/80 px-2 py-0.5 font-mono text-[10px] tracking-wide text-mute uppercase">{children}</span>;
}
