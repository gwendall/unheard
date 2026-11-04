"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/components/I18n";
import { Share } from "@/components/Share";
import { PlaceMap } from "@/components/PlaceMap";
import { TonePicture } from "@/components/TonePicture";
import { decode, troubleOf } from "@/lib/client/decode";
import type { FileMetadata } from "@/lib/client/metadata";
import { aircraftType } from "@/lib/client/types";
import { clockOf, coordinates, metresApart, offsetAt, OLDEST_DAY, osmLink, parseCoordinates, secondsLeft, SQUARE, windowOf, type Place, type Prefill, type Zone } from "@/lib/client/where";
import type { Guess, WhereEvent, WhereRequest, WhereResult, WhereStep } from "@/lib/client/where.worker";
import { ANALYSIS_RATE } from "@/lib/core/pipeline";
import { nearestPlace, placeLabel, searchPlaces, type NearPlace, type PlaceHit } from "@/lib/client/places";
import { paintWhere } from "@/lib/client/where-card";
import { httpFetcher, readDays } from "@/lib/history";

// "Find where", once a file is open: what is missing asked for, the day and hour already filled in
// from the file, then the search in a worker, cancellable, and its answer. The sound is decoded
// here and handed to the worker; only the day's flight tiles for the area searched, the ground's
// height tiles, the place names of those squares and the first letters of a typed name are asked
// for, all from our own files.

/** `since`: when this step last started over, for the estimate. */
type Busy = { step: WhereStep | "open"; done: number; total: number; since: number };
export type Picked = { file: File; meta: FileMetadata; prefill: Prefill };
type Found = Extract<WhereResult, { kind: "found" }>;

/** Planes a guess names in its lead, the rest counted. */
const NAMED = 6;
/** How long an answer waits for its name before it comes with its coordinates alone: nothing moves later. */
const NAMING_MS = 1500;

const spotKey = (p: { lat: number; lon: number }) => `${p.lat},${p.lon}`;

/** The towns nearest a result's answers, by what the moment allows. */
async function namesOf(result: WhereResult, locale: string): Promise<Map<string, NearPlace>> {
  const names = new Map<string, NearPlace>();
  if (result.kind !== "found") return names;
  const asked = result.guesses.map(async (g) => {
    const near = await nearestPlace(g.lat, g.lon, { locale });
    if (near) names.set(spotKey(g), near);
  });
  await Promise.race([Promise.all(asked), new Promise((done) => setTimeout(done, NAMING_MS))]);
  return names;
}

const QUIET = "text-mute underline-offset-4 transition hover:text-ink hover:underline";
const SECOND = "rounded-full border border-line px-5 py-3 text-ink transition hover:border-mute disabled:opacity-50";
const BUTTON = "w-full rounded-full bg-amber px-7 py-3 text-lg font-medium text-night transition hover:bg-amber-soft disabled:cursor-not-allowed disabled:opacity-40 sm:w-fit";
const FIELD = "rounded-xl border border-line bg-deep px-4 py-3 text-base text-ink placeholder:text-faint focus:border-amber";
const TITLE = "text-3xl font-semibold tracking-tight text-balance sm:text-4xl";

export function FindWhere({ picked, archive }: { picked: Picked; archive: string }) {
  const { m, f, fill, plural, locale } = useI18n();
  const t = m.where;
  const spot = picked.meta.location;
  const [error, setError] = useState<string | null>(null);
  // The days the archive holds: undefined until known, null when it has no list.
  const [days, setDays] = useState<string[] | null | undefined>(undefined);
  const [day, setDay] = useState(picked.prefill.day ?? "");
  const [time, setTime] = useState(picked.prefill.time ?? "");
  const [zone, setZone] = useState<Zone>(picked.prefill.zone);
  const [text, setText] = useState(spot ? coordinates(spot) : "");
  const [place, setPlace] = useState<Place | null>(spot ? { name: coordinates(spot), lat: spot.lat, lon: spot.lon } : null);
  const [matches, setMatches] = useState<PlaceHit[] | null>(null);
  const [active, setActive] = useState(0);
  const [names, setNames] = useState<Map<string, NearPlace>>(new Map());
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [now, setNow] = useState(0);
  const [result, setResult] = useState<WhereResult | null>(null);
  const [searchedDay, setSearchedDay] = useState(false);
  const [shown, setShown] = useState(0);
  const worker = useRef<Worker | null>(null);
  const run = useRef(0);
  const typing = useRef<{ timer?: ReturnType<typeof setTimeout>; asked: number }>({ asked: 0 });
  const placeField = useRef<HTMLInputElement>(null);
  const dayField = useRef<HTMLElement | null>(null);
  const started = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const verdict = useRef<HTMLHeadingElement>(null);
  const watching = useRef(false);

  useEffect(() => () => worker.current?.terminate(), []);

  // The days the archive holds, to offer only those. Without the list, any day can be typed, and
  // the search says when the archive has none for it.
  useEffect(() => {
    if (archive) void readDays(httpFetcher(new URL(archive, window.location.href).href)).then(setDays);
  }, [archive]);

  const chosen = days === null || days?.includes(day) ? day : "";
  // A date field can hold a year of six digits, which no clock reads: not a day to search.
  const span = place && /^\d{4}-\d{2}-\d{2}$/.test(chosen) ? windowOf({ day: chosen, time, zone }, place) : null;
  const fileDay = picked.prefill.day;
  const absent = days && fileDay && !days.includes(fileDay) ? fileDay : null;
  const heldDays = days && (days.length <= 8 ? days.join(", ") : fill(t.daysRange, { n: days.length, first: days[0], last: days[days.length - 1] }));

  /** Back to the form, whatever was running: the answers it gave, the fields as they were. */
  const stop = () => {
    run.current++;
    worker.current?.terminate();
    worker.current = null;
    setBusy(null);
    setResult(null);
    setShown(0);
    setError(null);
  };

  // The form gives way to the answer: if the visitor was watching, take them to its first line.
  useEffect(() => {
    if (result && watching.current) verdict.current?.focus();
  }, [result]);

  // The clock of the estimate, only while something runs.
  const running = !!busy;
  useEffect(() => {
    if (!running) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [running]);

  const chooseText = (value: string) => {
    setText(value);
    setMatches(null);
    setActive(0);
    const asked = ++typing.current.asked;
    clearTimeout(typing.current.timer);
    const typed = parseCoordinates(value);
    setPlace(typed && { name: coordinates(typed), ...typed });
    if (typed || value.trim().length < 2) return;
    // A short pause in the typing, then our own files: only the first letters reach them.
    typing.current.timer = setTimeout(() => {
      void searchPlaces(value.trim(), { locale, limit: 5 }).then((hits) => {
        if (asked === typing.current.asked) setMatches(hits);
      });
    }, 150);
  };

  const pick = (hit: PlaceHit) => {
    const name = placeLabel(hit, true);
    typing.current.asked++;
    setPlace({ name, lat: hit.lat, lon: hit.lon, zone: hit.zone });
    setText(name);
    setMatches(null);
  };

  /** The field's keys while it offers places: the focus stays in the field. */
  const onPlaceKey = (key: string, prevent: () => void) => {
    if (!matches?.length) return;
    if (key === "ArrowDown" || key === "ArrowUp") {
      prevent();
      setActive((at) => (at + (key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
    } else if (key === "Enter") {
      prevent();
      pick(matches[active]);
    } else if (key === "Escape") setMatches(null);
  };

  /** The browser's own position, kept here: it only picks the square to search. */
  const locate = () => {
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setLocating(false);
        const here = { lat: coords.latitude, lon: coords.longitude };
        chooseText(coordinates(here));
      },
      () => {
        setLocating(false);
        setError(t.locateFailed);
      },
      { timeout: 15_000, maximumAge: 300_000 },
    );
  };

  const search = async () => {
    if (!place || !span) return;
    stop();
    const mine = run.current;
    setNow(Date.now());
    setBusy({ step: "open", done: 0, total: 1, since: Date.now() });
    setSearchedDay(!time);
    // Coordinates come with no time zone. A local hour needs one: the town nearest them gives it,
    // asked only now, from the same square the search reads.
    const local = zone === "local" && !place.zone ? (await nearestPlace(place.lat, place.lon))?.zone : place.zone;
    if (mine !== run.current) return;
    const searched = windowOf({ day: chosen, time, zone }, { lon: place.lon, zone: local });
    let audio: Awaited<ReturnType<typeof decode>>;
    try {
      audio = await decode(picked.file, ANALYSIS_RATE);
    } catch (err) {
      if (mine !== run.current) return;
      setBusy(null);
      setError(m.check.errors[troubleOf(err)]);
      return;
    }
    if (mine !== run.current) return;
    const w = new Worker(new URL("../lib/client/where.worker.ts", import.meta.url), { type: "module" });
    const onEvent = async (e: WhereEvent) => {
      // A step that goes back starts over: its estimate with it.
      if (e.type === "progress") return setBusy((b) => (b?.step === e.step && e.done >= b.done ? { ...b, done: e.done, total: e.total } : { step: e.step, done: e.done, total: e.total, since: Date.now() }));
      w.terminate();
      worker.current = null;
      if (e.type === "result") {
        // The answer and its name arrive as one: nothing moves under the visitor.
        const named = await namesOf(e.result, locale);
        if (mine !== run.current) return;
        const box = panel.current?.getBoundingClientRect();
        watching.current = !!box && box.bottom > 0 && box.top < window.innerHeight;
        setNames(named);
        setResult(e.result);
      } else setError(fill(t.errors.failed, { message: e.message }));
      setBusy(null);
    };
    w.onmessage = (e: MessageEvent<WhereEvent>) => void onEvent(e.data);
    w.onerror = (e) => void onEvent({ type: "error", message: e.message || "worker" });
    worker.current = w;
    const request: WhereRequest = {
      ...audio,
      history: new URL(archive, window.location.href).href,
      window: searched,
      area: { lat: place.lat, lon: place.lon, side: SQUARE },
    };
    w.postMessage(request, audio.channels.map((c) => c.buffer as ArrayBuffer));
  };

  const progress = (b: Busy) => {
    const n = Math.round((100 * b.done) / Math.max(1, b.total));
    const elapsed = Math.max(0, now - b.since);
    const left = secondsLeft(b.done, b.total, elapsed);
    const estimate = left === null ? fill(t.elapsed, { time: f.clock(elapsed / 1000) }) : left < 60 ? fill(t.leftSeconds, { n: Math.max(5, Math.ceil(left / 5) * 5) }) : fill(t.leftMinutes, { n: Math.ceil(left / 60) });
    return (
      <div className="flex min-h-13 flex-wrap items-center gap-x-6 gap-y-2">
        <p className="flex items-center gap-3 font-mono text-sm text-mute tabular-nums" role="status" data-testid="where-progress">
          <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-amber" />
          <span>
            {fill(t.steps[b.step], { n })} <span data-testid="where-estimate">{estimate}</span>
          </span>
        </p>
        <button type="button" onClick={stop} className={SECOND} data-testid="where-cancel">
          {t.cancel}
        </button>
      </div>
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
    const local = names.get(spotKey(g))?.zone ?? place?.zone;
    const offset = offsetAt({ lon: g.lon, zone: local }, g.start);
    const line = fill(sure ? t.result.started : t.result.startedGuess, { day: new Date(g.start * 1000).toISOString().slice(0, 10), utc: clockOf(g.start), local: clockOf(g.start, offset) });
    return local ? line : `${line} ${t.result.about}`;
  };

  /** "Near Oyster Bay, New York, United States", or nothing out at sea or with the names out of reach. */
  const nearText = (g: Guess) => {
    const near = names.get(spotKey(g));
    return near ? fill(t.result.near, { place: placeLabel(near, true) }) : null;
  };

  /** The best answer, first and whole. It stays put while the other answers are looked through. */
  const lead = (g: Guess, sure: boolean) => {
    const named = g.planes.map((p) => p.registration || p.hex);
    const more = named.length - NAMED;
    const near = nearText(g);
    return (
      <div className="flex flex-col gap-2">
        {near && (
          <p className="text-2xl font-semibold tracking-tight text-balance text-ink sm:text-3xl" data-testid="where-place-name">
            {near}
          </p>
        )}
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <p className={`font-mono tabular-nums ${near ? "text-lg text-mute" : "text-2xl text-ink"}`} data-testid="where-spot">
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
  const answer = (g: Guess, views: Found["views"], sure: boolean, best: boolean, others: { lat: number; lon: number }[]) => (
    <div className="grid gap-8 lg:grid-cols-2">
      <div className="flex flex-col gap-3 lg:sticky lg:top-6 lg:self-start">
        <PlaceMap guess={g} others={others} sure={sure} />
        <p className="text-sm text-pretty text-faint">{t.result.credit}</p>
      </div>
      <div className="flex flex-col gap-8">
        {(!best || g.mirror) && (
          <div className="flex flex-col gap-2">
            {!best && (
              <>
                {nearText(g) && (
                  <p className="text-xl font-semibold tracking-tight text-balance text-ink" data-testid="where-shown-name">
                    {nearText(g)}
                  </p>
                )}
                <p className={`font-mono tabular-nums ${nearText(g) ? "text-mute" : "text-xl text-ink"}`} data-testid="where-shown-spot">
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

  const when = picked.prefill.from && !absent && (
    <p className="text-sm text-pretty text-mute" data-testid="where-from-file">
      {fill(t.fromFile[picked.prefill.from], { source: picked.prefill.source ?? "" })}
    </p>
  );

  const form = !result && (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-2">
          <span className="font-medium text-ink">{t.day}</span>
          {days !== null ? (
            <select
              ref={(el) => {
                dayField.current = el;
              }}
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
            <input
              ref={(el) => {
                dayField.current = el;
              }}
              type="date"
              required
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className={`${FIELD} w-full`}
              data-testid="where-day"
            />
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
      <div className="flex flex-col gap-2">
        <label htmlFor="where-place-field" className="w-fit font-medium text-ink">
          {t.place}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          {/* The places offered lie over what follows: nothing moves as they come and go. */}
          <div className="relative min-w-0 grow">
            <input
              ref={placeField}
              id="where-place-field"
              type="text"
              role="combobox"
              aria-expanded={!!matches?.length}
              aria-controls="where-matches"
              aria-autocomplete="list"
              aria-activedescendant={matches?.length ? `where-match-${active}` : undefined}
              value={text}
              onChange={(e) => chooseText(e.target.value)}
              onKeyDown={(e) => onPlaceKey(e.key, () => e.preventDefault())}
              onBlur={() => {
                typing.current.asked++;
                setMatches(null);
              }}
              placeholder={t.placePlaceholder}
              autoComplete="off"
              className={`${FIELD} w-full`}
              data-testid="where-place"
            />
            {!!matches?.length && (
              <ul id="where-matches" role="listbox" aria-label={t.place} className="absolute top-full left-0 z-20 mt-1 flex w-full flex-col gap-0.5 rounded-xl border border-line bg-deep p-1 shadow-xl shadow-night" data-testid="where-matches">
                {matches.map((p, i) => (
                  <li
                    key={`${p.lat},${p.lon}`}
                    id={`where-match-${i}`}
                    role="option"
                    aria-selected={i === active}
                    // The field keeps the focus, so the list is still there for the click.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(p)}
                    className={`cursor-pointer rounded-lg px-3 py-2 text-pretty text-ink transition ${i === active ? "bg-line/70" : "hover:bg-line/40"}`}
                  >
                    {placeLabel(p, true)}
                  </li>
                ))}
              </ul>
            )}
            {matches?.length === 0 && (
              <p role="status" className="absolute top-full left-0 z-20 mt-1 w-full rounded-xl border border-line bg-deep px-4 py-2 text-pretty text-mute shadow-xl shadow-night" data-testid="where-no-place">
                {t.noPlace}
              </p>
            )}
          </div>
          <button type="button" onClick={locate} disabled={locating} className={`${SECOND} shrink-0`} data-testid="where-locate">
            {locating ? t.locating : t.locate}
          </button>
        </div>
      </div>
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
          {/* Coordinates and a local hour: the time zone is only asked for when the search starts. */}
          {span && (zone === "utc" || place?.zone) && (
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

  // Nothing missing: straight to the search. Otherwise the focus goes to the first thing the visitor
  // must answer; not on a touch screen, where a focused field opens the keyboard and throws the page.
  const known = days !== undefined;
  const complete = !!span && !!time;
  useEffect(() => {
    if (!known || started.current) return;
    started.current = true;
    // A microtask: the effect only decides, the search sets its own state.
    if (complete) queueMicrotask(() => void search());
    else if (!window.matchMedia("(pointer: coarse)").matches) (chosen ? (place ? null : placeField.current) : dayField.current)?.focus();
  });

  const said = result && showing(result);
  const found = result?.kind === "found" && result.guesses.length ? result : null;
  const best = found?.guesses[0];
  const guess = found?.guesses[shown] ?? best;
  const unsure = found && !found.confident;
  // The map numbers the other answers from 2: they are drawn beside the best one, not beside another.
  const others = useMemo(() => (found && shown === 0 ? found.guesses.slice(1).map(({ lat, lon }) => ({ lat, lon })) : []), [found, shown]);

  return (
    <div ref={panel} className="flex flex-col gap-6" data-testid="where-find-panel">
      {form}

      {result && said && (
        <div className="flex flex-col gap-8" data-testid="where-result">
          <header className="flex flex-col gap-3">
            <h2 ref={verdict} tabIndex={-1} className={`${TITLE} scroll-mt-4 outline-none`} data-testid="where-verdict">
              {said.title}
            </h2>
            {found && best && lead(best, found.confident)}
            <p className={`text-pretty text-mute ${found ? "" : "max-w-prose text-lg"}`} data-testid="where-said">
              {said.text}
            </p>
            {unsure && found.passes < 2 && <p className="text-pretty text-mute">{t.result.onePass}</p>}
            {unsure && searchedDay && <p className="text-pretty text-ink">{t.result.dayHint}</p>}
          </header>

          {found && best && (
            <div className="flex flex-col gap-2" data-testid="where-share">
              <Share
                label={t.result.share}
                text={fill(t.result.shareText, { verdict: said.title, place: nearText(best) ?? coordinates(best, 2) })}
                card={{
                  lead: said.title,
                  name: nearText(best) ?? coordinates(best, 2),
                  // The day, and the coordinates once the name has taken their place above.
                  detail: `${new Date(best.start * 1000).toISOString().slice(0, 10)}${nearText(best) ? ` - ${coordinates(best)}` : ""}`,
                  facts: [
                    [`${clockOf(best.start).slice(0, 5)} UTC`, t.result.cardStart],
                    [String(best.planes.length), t.result.cardFlyovers],
                  ],
                  paint: (ctx, w, h) => paintWhere(ctx, w, h, best, found.views[best.planes[0]?.tone]),
                }}
              />
              <p className="text-sm text-pretty text-faint">{t.result.shareNote}</p>
            </div>
          )}

          {found && best && found.guesses.length > 1 && (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap" role="group" aria-label={t.result.guesses} data-testid="where-guesses">
              {found.guesses.map((g, i) => {
                const near = names.get(spotKey(g));
                const values = { n: i + 1, place: near ? placeLabel(near) : coordinates(g, 2), distance: f.km(metresApart(best, g)) };
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

          {found && guess && answer(guess, found.views, found.confident, guess === best, others)}

          <button type="button" onClick={stop} className={`${QUIET} w-fit`} data-testid="where-again">
            {t.result.again}
          </button>
        </div>
      )}
    </div>
  );
}
