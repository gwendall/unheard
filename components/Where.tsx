"use client";

import type { Route } from "next";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "@/components/Check";
import { ACCEPT, CARD, DropZone, PageDrop } from "@/components/Drop";
import { FindWhere, type Picked } from "@/components/FindWhere";
import { useI18n } from "@/components/I18n";
import { takeFile } from "@/lib/client/held";
import { readMetadata, type FileMetadata } from "@/lib/client/metadata";
import { coordinates, osmLink, prefillOf } from "@/lib/client/where";

// One flow for a file, in the place of the drop zone, each thing as soon as it is known: what the
// file says about itself, at once; its aircraft tones, within seconds; then the two things to do
// with them, find where it was recorded and take them out. Nothing of the file is ever sent.

const QUIET = "text-mute underline-offset-4 transition hover:text-ink hover:underline";
const FIND = "w-full rounded-full bg-amber px-7 py-3 text-lg font-medium text-night transition enabled:hover:bg-amber-soft disabled:cursor-not-allowed disabled:opacity-40 sm:w-fit";

export function Where({ archive, elsewhere, scope }: { archive: string | null; elsewhere: Route; scope: ReactNode }) {
  const { m, fill } = useI18n();
  const t = m.where;
  const [picked, setPicked] = useState<(Picked & { id: number }) | null>(null);
  const [finding, setFinding] = useState(false);
  const [settled, setSettled] = useState(false);
  const settle = useCallback(() => setSettled(true), []);
  const count = useRef(0);

  const open = useCallback(async (file: File) => {
    const meta = await readMetadata(file).catch((): FileMetadata => ({ format: "unknown" }));
    setFinding(false);
    setSettled(false);
    setPicked({ id: ++count.current, file, meta, prefill: prefillOf(meta) });
  }, []);

  // A file dropped on the home comes in with the visitor.
  useEffect(() => {
    const held = takeFile();
    // A microtask: the effect only hands the file over, opening it sets its own state.
    if (held) queueMicrotask(() => void open(held));
  }, [open]);

  const location = picked?.meta.location;
  const made = picked && [picked.prefill.day, picked.prefill.time, picked.prefill.zone === "utc" && picked.prefill.time ? "UTC" : ""].filter(Boolean).join(" ");
  const device = picked?.meta.device;

  return (
    <>
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

            <div className="flex flex-col gap-3" data-testid="where-facts">
              {location && (
                <div className="flex flex-col gap-2" data-testid="where-gps">
                  <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{fill(t.gps.title, { place: coordinates(location) })}</h2>
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

            <Check
              key={picked.id}
              file={picked.file}
              elsewhere={elsewhere}
              onSettled={settle}
              note={archive ? null : t.offline}
              fold={finding}
              find={
                archive
                  ? (ready) => (
                      <button type="button" disabled={!ready} onClick={() => setFinding(true)} aria-expanded={finding} className={FIND} data-testid="where-find">
                        {t.find}
                      </button>
                    )
                  : undefined
              }
            >
              {finding && archive && <FindWhere picked={picked} archive={archive} />}
            </Check>
          </>
        )}
      </section>
      {/* What sits under the card waits for the tones: below a card about to grow, it would jump away. */}
      {(!picked || settled) && scope}
    </>
  );
}
