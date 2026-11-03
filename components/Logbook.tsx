"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { addToLog, clearLog, KEY, readLog, type Entry } from "@/lib/client/logbook";
import { LANGUAGES } from "@/lib/locales";
import { useI18n } from "./I18n";

// The logbook in this tab and the others: localStorage, with an event for this tab's own writes
// (the storage event only reaches the other tabs).
const CHANGED = "unheard:logbook";
const SHOWN = 5;

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}
const raw = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

/** The planes found on this phone, newest first; empty on the server and while hydrating. */
export function useLogbook(): Entry[] {
  const value = useSyncExternalStore(subscribe, raw, () => null);
  return useMemo(() => (value ? readLog({ getItem: () => value, setItem: () => {}, removeItem: () => {} }) : []), [value]);
}

export function record(entry: Entry): void {
  try {
    addToLog(localStorage, entry);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGED));
}

function forget(): void {
  try {
    clearLog(localStorage);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** The home's list of the planes found on this phone: nothing at all until there is one. */
export function Logbook() {
  const log = useLogbook();
  const { locale, m: all, f, fill } = useI18n();
  const t = all.logbook;
  const [open, setOpen] = useState(false);
  const when = useMemo(() => new Intl.DateTimeFormat(LANGUAGES[locale].tag, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }), [locale]);
  if (!log.length) return null;
  const shown = open ? log : log.slice(0, SHOWN);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="logbook" data-testid="logbook">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="logbook" className="text-sm font-medium tracking-wide text-mute uppercase">
          {fill(t.title, { n: log.length })}
        </h2>
        <button type="button" onClick={() => window.confirm(t.confirmClear) && forget()} className="text-sm text-faint transition hover:text-ink">
          {t.clear}
        </button>
      </div>
      <ol className="flex flex-col divide-y divide-line overflow-hidden rounded-2xl border border-line bg-deep">
        {shown.map((e) => (
          <li key={`${e.hex}-${e.at}`} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <div className="truncate font-medium">{e.title}</div>
              <div className="truncate text-sm text-faint">
                {[e.route ? fill(all.route, { from: e.route.from, to: e.route.to }) : null, e.sure ? null : t.probably, fill(t.away, { distance: f.km(e.range) })].filter(Boolean).join(" · ")}
              </div>
            </div>
            <time dateTime={new Date(e.at).toISOString()} className="shrink-0 text-right text-sm text-faint tabular-nums">
              {when.format(e.at)}
            </time>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-faint">
        <p>{t.note}</p>
        {log.length > SHOWN && (
          <button type="button" onClick={() => setOpen((v) => !v)} className="text-mute transition hover:text-ink">
            {open ? t.less : fill(t.more, { n: log.length })}
          </button>
        )}
      </div>
    </section>
  );
}
