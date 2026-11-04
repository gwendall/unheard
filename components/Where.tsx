"use client";

import type { Route } from "next";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, type Heard } from "@/components/Check";
import { DoorHeader } from "@/components/DoorHeader";
import { ACCEPT, CARD, DropZone, PageDrop } from "@/components/Drop";
import { FindWhere, type Picked } from "@/components/FindWhere";
import { useI18n } from "@/components/I18n";
import { hasHeld, takeFile } from "@/lib/client/held";
import { readMetadata, type FileMetadata } from "@/lib/client/metadata";
import { coordinates, madeInWords, osmLink, prefillOf, type SoundGate } from "@/lib/client/where";
import { nearestPlace, placeLabel, type NearPlace } from "@/lib/client/places";
import { Answer } from "@/components/Answer";
import { PlaceMap } from "@/components/PlaceMap";

// One flow for a file, in the place of the drop zone, each thing as soon as it is known: what the
// file says about itself, at once; its aircraft tones, as they are found; find where it was recorded,
// open from the start and never waiting for them; and take them out. Once there is an answer it comes
// first, the only primary on the screen, and the file's own findings folded under it. Nothing of the file is ever sent.

const QUIET = "text-mute underline-offset-4 transition hover:text-ink hover:underline";
const FIND = "w-full rounded-full border border-transparent bg-amber px-7 py-3 text-lg font-medium text-night transition hover:bg-amber-soft sm:w-fit";
/** The same button when something else on the page leads: the same box, so nothing moves. */
const FIND_NEXT = "w-full rounded-full border border-line px-7 py-3 text-lg font-medium text-ink transition hover:border-mute sm:w-fit";
/** How long a file's answer waits for its name before it comes with its coordinates alone: nothing moves later. */
const NAMING_MS = 1500;
/**
 * How close the map of a file's own position goes on its own. The tiles it asks for name the area they
 * cover, so they stay this wide; the pin is drawn here. Closer only when the visitor zooms.
 */
const REGION_ZOOM = 11;

export function Where({ archive, elsewhere, scope }: { archive: string | null; elsewhere: Route; scope: ReactNode }) {
  const { m, fill, locale } = useI18n();
  const a = m.answer;
  const t = m.where;
  const [picked, setPicked] = useState<(Picked & { id: number; near: NearPlace | null }) | null>(null);
  // From the moment a file comes in, the one from the home included.
  const [filed, setFiled] = useState(hasHeld);
  const [answered, setAnswered] = useState(false);
  const [finding, setFinding] = useState(false);
  const [settled, setSettled] = useState(false);
  // One long job at a time: while a search runs the check gives way, and shows the tones the search finds.
  const [searching, setSearching] = useState(false);
  const [heard, setHeard] = useState<Heard | null>(null);
  // What the sound alone says, by the search's own count: too few passes or none, and the search has nothing to ask for.
  const [refused, setRefused] = useState<SoundGate["refused"]>(null);
  const settle = useCallback(() => setSettled(true), []);
  const count = useRef(0);

  const open = useCallback(async (file: File) => {
    setFiled(true);
    const meta = await readMetadata(file).catch((): FileMetadata => ({ format: "unknown" }));
    const { location: spot } = meta;
    const near = spot ? await Promise.race([nearestPlace(spot.lat, spot.lon, { locale }), new Promise<null>((done) => setTimeout(done, NAMING_MS, null))]) : null;
    setFinding(false);
    setSettled(false);
    setHeard(null);
    setRefused(null);
    setAnswered(false);
    setPicked({ id: ++count.current, file, meta, prefill: prefillOf(meta), near });
  }, [locale]);

  // A file dropped on the home comes in with the visitor.
  useEffect(() => {
    const held = takeFile();
    // A microtask: the effect only hands the file over, opening it sets its own state.
    if (held) queueMicrotask(() => void open(held));
  }, [open]);

  const location = picked?.meta.location;
  // A file that says where it was made answers that, whatever it holds of planes; for the others,
  // too few or none is the answer, with no search behind it.
  const few = !location && refused === "few";
  const silent = !location && !finding && refused === "none";
  const made = picked && [picked.prefill.day, picked.prefill.time, picked.prefill.zone === "utc" && picked.prefill.time ? "UTC" : ""].filter(Boolean).join(" ");
  const device = picked?.meta.device;
  const near = picked?.near ?? null;
  const spoken = picked ? madeInWords(picked.meta.createdAt, location ? { lon: location.lon, zone: near?.zone } : undefined, locale) : null;
  // From the tags, which can be edited or copied: it says so, as the place does.
  const stated = spoken && (spoken.time ? fill(a.when, { date: spoken.date, time: spoken.time }) : spoken.date);
  const when = stated ? fill(a.fileWhen, { when: [stated, device].filter(Boolean).join(", ") }) : device ? fill(a.fileDevice, { device }) : null;
  const spot = useMemo(() => (location ? { lat: location.lat, lon: location.lon, start: 0, mirror: null, planes: [], paths: [] } : null), [location]);
  const another = (
    <label className={`${FIND_NEXT} cursor-pointer text-center has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-amber`}>
      <input
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void open(file);
        }}
        data-testid="answer-another"
      />
      {a.another}
    </label>
  );

  const facts = (
    <div className="flex flex-col gap-3" data-testid="where-facts">
      {location && (
        <div className="flex flex-col gap-2" data-testid="where-gps">
          <p className="text-lg text-pretty text-ink tabular-nums">{fill(t.gps.title, { place: coordinates(location) })}</p>
          <a href={osmLink(location)} target="_blank" rel="noreferrer" className={`${QUIET} w-fit`}>
            {t.result.osm} <span aria-hidden>→</span>
          </a>
          <p className="max-w-prose text-pretty text-mute">{t.gps.still}</p>
        </div>
      )}
      {(made || device) && (
        <dl className="flex flex-wrap gap-x-10 gap-y-3">
          {made && (
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-mute">{t.facts.made}</dt>
              <dd className="font-mono text-lg text-ink tabular-nums" data-testid="where-made">
                {made}
              </dd>
            </div>
          )}
          {device && (
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-mute">{t.facts.device}</dt>
              <dd className="text-lg text-ink" data-testid="where-device">
                {device}
              </dd>
            </div>
          )}
        </dl>
      )}
      {!location && !made && !device && (
        <p className="text-pretty text-mute" data-testid="where-facts-none">
          {t.facts.nothing}
        </p>
      )}
    </div>
  );

  return (
    <>
      <DoorHeader title={t.title} lead={filed ? undefined : t.lead} note={filed ? t.privateShort : t.private} />
      <section className={CARD} data-testid="where">
        <PageDrop onFile={(file) => void open(file)} />
        {!picked && <DropZone onFile={(file) => void open(file)} />}
        {picked && (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <p className="min-w-0 truncate font-medium text-ink" data-testid="where-name">
                {picked.file.name}
              </p>
              <label className={`${QUIET} cursor-pointer has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-amber`}>
                <input
                  type="file"
                  accept={ACCEPT}
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void open(file);
                  }}
                  data-testid="where-another"
                />
                {t.another}
              </label>
            </div>

            <Check
              key={picked.id}
              file={picked.file}
              elsewhere={elsewhere}
              onSettled={settle}
              note={archive ? null : t.offline}
              facts={facts}
              fold={finding}
              hold={searching}
              heard={heard}
              answered={answered || few || silent}
              when={when}
              another={another}
              lead={
                location && spot
                  ? (part) => (
                      <Answer
                        map={<PlaceMap guess={spot} sure zoom={REGION_ZOOM} className="h-60 sm:h-96" />}
                        title={near ? fill(a.gps, { place: placeLabel(near) }) : fill(a.gpsAt, { place: coordinates(location, 2) })}
                        titleProps={{ "data-testid": "answer-title" }}
                        when={when}
                        why={a.why.gps}
                        actions={
                          <>
                            {part.copyButton(part.cleaned ? "second" : "primary")}
                            {another}
                          </>
                        }
                        quiet={
                          <>
                            {part.copyNote}
                            {part.clean(true)}
                          </>
                        }
                        after={
                          <p className="text-sm text-pretty text-faint" data-testid="answer-map-note">
                            {a.mapNote}
                          </p>
                        }
                        summary={a.details.gps}
                        details={part.details}
                      />
                    )
                  : undefined
              }
              gate={!location && !finding}
              onRefused={setRefused}
              tagged={!!(location || made || device)}
              find={
                archive && !answered && !few && !silent
                  ? (leads) => (
                      <button type="button" onClick={() => setFinding(true)} aria-expanded={finding} className={leads ? FIND : FIND_NEXT} data-testid="where-find">
                        {t.find}
                      </button>
                    )
                  : undefined
              }
            >
              {((finding && archive) || few || silent) && <FindWhere picked={picked} archive={archive ?? ""} few={few} silent={silent} when={when} another={another} onSearching={setSearching} onHeard={setHeard} onAnswered={setAnswered} />}
            </Check>
          </>
        )}
      </section>
      {/* What sits under the card waits for the tones: below a card about to grow, it would jump away. */}
      {(!picked || settled) && scope}
    </>
  );
}
