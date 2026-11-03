"use client";

import Link from "next/link";
import type { Route } from "next";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { useI18n } from "@/components/I18n";
import { SpotPlot } from "@/components/SpotPlot";
import { TonePicture } from "@/components/TonePicture";
import { decode } from "@/lib/client/decode";
import { readMetadata, type FileMetadata } from "@/lib/client/metadata";
import { aircraftType } from "@/lib/client/types";
import { clockOf, coordinates, geocode, metresApart, offsetAt, OLDEST_DAY, osmLink, parseCoordinates, prefillOf, SQUARE, windowOf, type Place, type Prefill, type Zone } from "@/lib/client/where";
import type { Guess, WhereEvent, WhereRequest, WhereResult, WhereStep } from "@/lib/client/where.worker";
import { ANALYSIS_RATE } from "@/lib/core/pipeline";
import { httpFetcher, readDays } from "@/lib/history";

// Where and when, in the place of the drop zone: a file in, what it says about itself, what is
// missing asked for, then the search in a worker and its answer. The sound is decoded here and
// handed to the worker; only the day's flight tiles for the area searched, the ground's height
// tiles and the typed place name go out.

type Busy = { step: WhereStep | "open"; done: number; total: number };
type Picked = { file: File; meta: FileMetadata; prefill: Prefill };
type Found = Extract<WhereResult, { kind: "found" }>;

/** Planes a guess names in its lead, the rest counted. */
const NAMED = 6;

const QUIET = "text-mute underline-offset-4 transition hover:text-ink hover:underline";
const BUTTON = "w-full rounded-full bg-amber px-7 py-3 text-lg font-medium text-night transition hover:bg-amber-soft disabled:cursor-not-allowed disabled:opacity-40 sm:w-fit";
const FIELD = "rounded-xl border border-line bg-deep px-4 py-3 text-base text-ink placeholder:text-faint focus:border-amber focus:outline-none";
const TITLE = "text-3xl font-semibold tracking-tight text-balance sm:text-4xl";

export function Where({ archive, check }: { archive: string | null; check: Route }) {
  const { m, f, fill, plural, locale } = useI18n();
  const t = m.where;
  const [picked, setPicked] = useState<Picked | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  // The days the archive holds: undefined until known, null when it has no list.
  const [days, setDays] = useState<string[] | null | undefined>(undefined);
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [zone, setZone] = useState<Zone>("local");
  const [text, setText] = useState("");
  const [place, setPlace] = useState<Place | null>(null);
  const [matches, setMatches] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [result, setResult] = useState<WhereResult | null>(null);
  const [searchedDay, setSearchedDay] = useState(false);
  const [shown, setShown] = useState(0);
  const worker = useRef<Worker | null>(null);
  const run = useRef(0);
  const typing = useRef<{ timer?: ReturnType<typeof setTimeout>; abort?: AbortController }>({});

  useEffect(() => () => worker.current?.terminate(), []);

  // The days the archive holds, to offer only those. Without the list, any day can be typed, and
  // the search says when the archive has none for it.
  useEffect(() => {
    if (archive) void readDays(httpFetcher(new URL(archive, window.location.href).href)).then(setDays);
  }, [archive]);

  const chosen = days === null || days?.includes(day) ? day : "";
  // A date field can hold a year of six digits, which no clock reads: not a day to search.
  const span = place && /^\d{4}-\d{2}-\d{2}$/.test(chosen) ? windowOf({ day: chosen, time, zone }, place) : null;
  const fileDay = picked?.prefill.day;
  const absent = days && fileDay && !days.includes(fileDay) ? fileDay : null;
  const heldDays = days && (days.length <= 8 ? days.join(", ") : fill(t.daysRange, { n: days.length, first: days[0], last: days[days.length - 1] }));

  const stop = () => {
    run.current++;
    worker.current?.terminate();
    worker.current = null;
    setBusy(null);
    setResult(null);
    setShown(0);
    setError(null);
  };

  const chooseText = (value: string) => {
    setText(value);
    setMatches(null);
    typing.current.abort?.abort();
    clearTimeout(typing.current.timer);
    const typed = parseCoordinates(value);
    setPlace(typed && { name: coordinates(typed), ...typed });
    if (typed || value.trim().length < 2) return;
    // A pause in the typing, then the name alone goes to the geocoder.
    typing.current.timer = setTimeout(() => {
      const abort = new AbortController();
      typing.current.abort = abort;
      geocode(value.trim(), locale, abort.signal).then(setMatches, () => undefined);
    }, 350);
  };

  const open = async (file: File | undefined) => {
    if (!file) return;
    stop();
    const meta = await readMetadata(file);
    const prefill = prefillOf(meta);
    setDay(prefill.day ?? "");
    setTime(prefill.time ?? "");
    setZone(prefill.zone);
    const spot = meta.location ? { name: coordinates(meta.location), lat: meta.location.lat, lon: meta.location.lon } : null;
    setPlace(spot);
    setText(spot?.name ?? "");
    setMatches(null);
    setPicked({ file, meta, prefill });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void open(e.dataTransfer.files[0]);
  };

  const search = async () => {
    if (!picked || !place || !span || !archive) return;
    stop();
    const mine = run.current;
    setBusy({ step: "open", done: 0, total: 1 });
    setSearchedDay(!time);
    let audio: Awaited<ReturnType<typeof decode>>;
    try {
      audio = await decode(picked.file, ANALYSIS_RATE);
    } catch {
      if (mine !== run.current) return;
      setBusy(null);
      setError(t.errors.open);
      return;
    }
    if (mine !== run.current) return;
    const w = new Worker(new URL("../lib/client/where.worker.ts", import.meta.url), { type: "module" });
    const onEvent = (e: WhereEvent) => {
      if (e.type === "progress") return setBusy({ step: e.step, done: e.done, total: e.total });
      w.terminate();
      worker.current = null;
      setBusy(null);
      if (e.type === "result") setResult(e.result);
      else setError(fill(t.errors.failed, { message: e.message }));
    };
    w.onmessage = (e: MessageEvent<WhereEvent>) => onEvent(e.data);
    w.onerror = (e) => onEvent({ type: "error", message: e.message || "worker" });
    worker.current = w;
    const request: WhereRequest = {
      ...audio,
      history: new URL(archive, window.location.href).href,
      window: span,
      area: { lat: place.lat, lon: place.lon, side: SQUARE },
    };
    w.postMessage(request, audio.channels.map((c) => c.buffer as ArrayBuffer));
  };

  const progress = (b: Busy) => {
    const n = Math.round((100 * b.done) / Math.max(1, b.total));
    return (
      <p className="flex min-h-13 items-center gap-3 font-mono text-sm text-mute tabular-nums" role="status" data-testid="where-progress">
        <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-amber" />
        {fill(t.steps[b.step], { n })}
      </p>
    );
  };

  /** The planes of a guess and their tones, the spectrum with the curve on each. */
  const planes = (g: Guess, views: Found["views"], sure: boolean) => (
    <section className="flex flex-col gap-4" aria-labelledby="where-planes">
      <h3 id="where-planes" className="text-sm font-medium tracking-wide text-mute uppercase">
        {sure ? t.result.planes : t.result.planesGuess}
      </h3>
      <ul className="flex flex-col gap-6" data-testid="where-planes">
        {g.planes.map((p) => (
          <li key={p.hex} className="flex flex-col gap-2">
            <p className="text-pretty tabular-nums">
              <span className="font-medium text-ink">{p.registration || p.hex}</span>{" "}
              <span className="text-mute">{fill(t.result.plane, { type: aircraftType(p.type)?.name ?? (p.type || t.result.noType), distance: f.km(p.metres), time: clockOf(p.at) })}</span>
            </p>
            {views[p.tone] && <TonePicture picture={views[p.tone].picture} tone={views[p.tone].tone} />}
          </li>
        ))}
      </ul>
    </section>
  );

  /** Under the flag, an answer; otherwise every word stays a guess, however close it may be. */
  const startOf = (g: Guess, sure: boolean) => {
    const offset = place ? offsetAt(place, g.start) : 0;
    const line = fill(sure ? t.result.started : t.result.startedGuess, { day: new Date(g.start * 1000).toISOString().slice(0, 10), utc: clockOf(g.start), local: clockOf(g.start, offset) });
    return place?.zone ? line : `${line} ${t.result.about}`;
  };

  /** The best answer, first and whole. It stays put while the other answers are looked through. */
  const lead = (g: Guess, sure: boolean) => {
    const named = g.planes.map((p) => p.registration || p.hex);
    const more = named.length - NAMED;
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <p className="font-mono text-2xl text-ink tabular-nums" data-testid="where-spot">
            {coordinates(g)}
          </p>
          <a href={osmLink(g)} target="_blank" rel="noreferrer" className={QUIET} data-testid="where-osm">
            {t.result.osm} <span aria-hidden>→</span>
          </a>
        </div>
        <p className="text-lg text-mute tabular-nums" data-testid="where-start">
          {startOf(g, sure)}
        </p>
        {named.length > 0 && (
          <p className="text-lg text-pretty text-ink tabular-nums" data-testid="where-explains">
            {plural(named.length, t.result.explains, { planes: `${named.slice(0, NAMED).join(", ")}${more > 0 ? ` +${more}` : ""}` })}
          </p>
        )}
      </div>
    );
  };

  /** The answer picked: where it lies, the mirror, the planes and their tones. */
  const answer = (g: Guess, views: Found["views"], sure: boolean, best: boolean) => (
    <div className="grid gap-8 lg:grid-cols-2">
      <div className="flex flex-col gap-3 lg:sticky lg:top-6 lg:self-start">
        <SpotPlot guess={g} sure={sure} />
        <p className="text-sm text-faint">{t.result.credit}</p>
      </div>
      <div className="flex flex-col gap-8">
        {(!best || g.mirror) && (
          <div className="flex flex-col gap-2">
            {!best && (
              <>
                <p className="font-mono text-xl text-ink tabular-nums" data-testid="where-shown-spot">
                  {coordinates(g)}
                </p>
                <p className="text-mute tabular-nums" data-testid="where-shown-start">
                  {startOf(g, sure)}
                </p>
                <a href={osmLink(g)} target="_blank" rel="noreferrer" className={`${QUIET} w-fit`}>
                  {t.result.osm} <span aria-hidden>→</span>
                </a>
              </>
            )}
            {g.mirror && (
              <p className="text-pretty text-mute" data-testid="where-mirror">
                {fill(t.result.mirror, { place: coordinates(g.mirror) })}{" "}
                <a href={osmLink(g.mirror)} target="_blank" rel="noreferrer" className="underline underline-offset-4 transition hover:text-ink">
                  {t.result.osm}
                </a>
              </p>
            )}
          </div>
        )}
        {planes(g, views, sure)}
      </div>
    </div>
  );

  const showing = (r: WhereResult) => {
    if (r.kind === "none") return { title: t.result.none, text: t.result.noneText };
    if (r.kind === "missing") return { title: fill(t.result.missing, { day: r.day }), text: t.result.missingText };
    if (!r.guesses.length) return { title: t.result.nothing, text: t.result.nothingText };
    if (r.confident) return { title: t.result.sure, text: t.result.sureText };
    return { title: t.result.best, text: t.result.honest };
  };

  const header = picked && (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
      <p className="min-w-0 truncate font-medium text-ink" data-testid="where-name">
        {picked.file.name}
      </p>
      <label className={`${QUIET} cursor-pointer`}>
        <input type="file" accept="audio/*,video/*" className="sr-only" onChange={(e) => void open(e.target.files?.[0])} />
        {t.another}
      </label>
    </div>
  );

  const location = picked?.meta.location;
  const when = picked?.prefill.from && !absent && (
    <p className="text-sm text-pretty text-mute" data-testid="where-from-file">
      {fill(t.fromFile[picked.prefill.from], { source: picked.prefill.source ?? "" })}
    </p>
  );

  const form = picked && !result && (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-2">
          <span className="font-medium text-ink">{t.day}</span>
          {days !== null ? (
            <select
              required
              disabled={!days}
              value={chosen}
              onChange={(e) => {
                setDay(e.target.value);
                // The file's hour says nothing about another day than the file's.
                if (absent) setTime("");
              }}
              className={`${FIELD} w-full`}
              data-testid="where-day"
            >
              <option value="" disabled>
                {t.dayPick}
              </option>
              {[...(days ?? [])].reverse().map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          ) : (
            <input type="date" required value={day} onChange={(e) => setDay(e.target.value)} className={`${FIELD} w-full`} data-testid="where-day" />
          )}
        </label>
        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor="where-time" className="font-medium text-ink">
            {t.hour}
          </label>
          <div className="flex gap-2">
            <input id="where-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className={`${FIELD} min-w-0 flex-1`} data-testid="where-time" />
            <select value={zone} onChange={(e) => setZone(e.target.value as Zone)} aria-label={t.zone} className={`${FIELD} min-w-0 shrink-0`} data-testid="where-zone">
              <option value="local">{t.zones.local}</option>
              <option value="utc">{t.zones.utc}</option>
            </select>
          </div>
        </div>
      </div>
      {days && !days.length && <p className="text-pretty text-amber-soft">{t.noDays}</p>}
      {heldDays && days?.length ? (
        <p className={`text-pretty ${absent ? "text-amber-soft" : "text-mute"}`} data-testid={absent ? "where-day-absent" : "where-days"}>
          {absent ? fill(absent < OLDEST_DAY ? t.dayBefore : t.dayAbsent, { day: absent, days: heldDays, oldest: OLDEST_DAY }) : fill(t.daysHeld, { days: heldDays })}
        </p>
      ) : null}
      <p className="text-pretty text-ink" data-testid="where-hour-why">
        {t.hourWhy}
      </p>
      {when}
      <label className="flex flex-col gap-2">
        <span className="font-medium text-ink">{t.place}</span>
        <input type="text" value={text} onChange={(e) => chooseText(e.target.value)} placeholder={t.placePlaceholder} autoComplete="off" className={`${FIELD} w-full`} data-testid="where-place" />
      </label>
      {matches && !place && (
        <ul className="flex flex-col gap-1" data-testid="where-matches">
          {matches.length === 0 && <li className="text-pretty text-mute">{t.noPlace}</li>}
          {matches.map((p) => (
            <li key={`${p.lat},${p.lon}`}>
              <button
                type="button"
                className="w-full rounded-xl px-4 py-2 text-left text-ink transition hover:bg-line/50"
                onClick={() => {
                  setPlace(p);
                  setText(p.name);
                  setMatches(null);
                }}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-pretty text-mute" data-testid="where-place-hint">
        {place ? fill(t.placeChosen, { place: place.name }) : t.placeHint}
      </p>
      {busy ? (
        progress(busy)
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
          <button type="button" onClick={() => void search()} disabled={!span} className={BUTTON} data-testid="where-search">
            {t.search}
          </button>
          {span && (
            <p className="text-sm text-balance text-mute tabular-nums" data-testid="where-window">
              {fill(t.window, { from: `${new Date(span[0] * 1000).toISOString().slice(0, 10)} ${clockOf(span[0]).slice(0, 5)}`, to: `${new Date(span[1] * 1000).toISOString().slice(0, 10)} ${clockOf(span[1]).slice(0, 5)}` })}
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-2xl border border-amber/40 bg-amber/10 px-4 py-3 text-pretty text-amber-soft">
          {error}
        </p>
      )}
    </div>
  );

  const said = result && showing(result);
  const found = result?.kind === "found" && result.guesses.length ? result : null;
  const best = found?.guesses[0];
  const guess = found?.guesses[shown] ?? best;
  const unsure = found && !found.confident;

  return (
    <section className="flex min-h-72 flex-col gap-6 rounded-3xl border border-line bg-deep/70 p-5 sm:p-8" aria-live="polite" data-testid="where">
      {!archive && (
        <p className="text-lg text-pretty text-amber-soft" data-testid="where-offline">
          {t.offline}
        </p>
      )}

      {!picked && (
        <label
          className={`flex grow cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-5 py-10 text-center transition has-[input:focus-visible]:border-amber ${over ? "border-amber bg-amber/5" : "border-line hover:border-mute"}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          data-testid="where-drop"
        >
          <input type="file" accept="audio/*,video/*" className="sr-only" onChange={(e) => void open(e.target.files?.[0])} data-testid="where-file" />
          <span className={BUTTON}>{t.choose}</span>
          <span className="text-mute">{t.drop}</span>
          <span className="text-sm text-faint">{t.formats}</span>
        </label>
      )}

      {header}

      {location && (
        <div className="flex flex-col gap-2" data-testid="where-gps">
          <h2 className={TITLE}>{fill(t.gps.title, { place: coordinates(location) })}</h2>
          <a href={osmLink(location)} target="_blank" rel="noreferrer" className={`${QUIET} w-fit`}>
            {t.result.osm} <span aria-hidden>→</span>
          </a>
          {archive && !result && <p className="max-w-prose text-pretty text-mute">{t.gps.still}</p>}
        </div>
      )}

      {picked && !archive && !location && <p className="text-lg text-pretty text-mute">{t.gps.nothing}</p>}
      {picked && !archive && picked.prefill.day && (
        <p className="text-lg text-pretty text-mute" data-testid="where-from-file">
          {fill(t.gps.made, { when: [picked.prefill.day, picked.prefill.time, picked.prefill.zone === "utc" && picked.prefill.time ? "UTC" : ""].filter(Boolean).join(" "), source: picked.prefill.source ?? "" })}
        </p>
      )}

      {archive && form}

      {result && said && (
        <div className="flex flex-col gap-8" data-testid="where-result">
          <header className="flex flex-col gap-3">
            <h2 className={TITLE} data-testid="where-verdict">
              {said.title}
            </h2>
            {found && best && lead(best, found.confident)}
            <p className={`text-pretty text-mute ${found ? "" : "max-w-prose text-lg"}`} data-testid="where-said">
              {said.text}
            </p>
            {unsure && found.passes < 2 && <p className="text-pretty text-mute">{t.result.onePass}</p>}
            {unsure && searchedDay && <p className="text-pretty text-ink">{t.result.dayHint}</p>}
          </header>

          {found && best && found.guesses.length > 1 && (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap" role="group" aria-label={t.result.guesses} data-testid="where-guesses">
              {found.guesses.map((g, i) => {
                const values = { n: i + 1, place: coordinates(g, 2), distance: f.km(metresApart(best, g)) };
                return (
                  <button
                    key={`${g.lat},${g.lon},${g.start}`}
                    type="button"
                    onClick={() => setShown(i)}
                    aria-pressed={i === shown}
                    className={`rounded-xl border px-4 py-2 text-left text-sm tabular-nums transition ${i === shown ? "border-amber text-ink" : "border-line text-mute hover:border-mute"}`}
                  >
                    {fill(i === 0 ? t.result.first : i === 1 ? t.result.next : t.result.later, values)}
                  </button>
                );
              })}
            </div>
          )}

          {found && guess && answer(guess, found.views, found.confident, guess === best)}

          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
            <button type="button" onClick={stop} className={`${QUIET} w-fit`} data-testid="where-again">
              {t.result.again}
            </button>
            <Link href={check} className={`${QUIET} w-fit`} data-testid="where-check">
              {t.result.check} <span aria-hidden>→</span>
            </Link>
          </div>
          {!found && <p className="text-sm text-faint">{t.result.stored}</p>}
        </div>
      )}
    </section>
  );
}
