"use client";

import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { LANG_COOKIE, LANGUAGES, LOCALES, pageOf, pathFor, type Locale } from "@/lib/locales";

// A year: the site opens in this language from then on (next.config.ts). English is a choice too:
// it keeps a French browser on the English pages.
function remember(code: Locale) {
  document.cookie = `${LANG_COOKIE}=${code}; path=/; max-age=31536000; samesite=lax`;
}

// The language switch, opening the list of the languages, each named in itself, as plain links to
// the same page in it. In the header it shows the current code; at the foot of the page, the
// language's name, its list opening upward.
export function LanguageMenu({ current, label, full = false }: { current: Locale; label: string; full?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useId();
  const page = pageOf(usePathname() ?? "/");

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative" data-testid={full ? "language-footer" : "language"}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={list}
        title={label}
        onClick={() => setOpen((o) => !o)}
        className="group flex h-9 items-center gap-2 rounded-full border border-line px-3 text-sm text-mute transition hover:border-faint hover:text-ink aria-expanded:border-faint aria-expanded:text-ink"
      >
        <Globe />
        <span className={full ? "" : "font-mono tracking-wider uppercase"}>{full ? LANGUAGES[current].name : current}</span>
        <svg aria-hidden viewBox="0 0 10 6" className="size-2.5 transition-transform group-aria-expanded:rotate-180">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <ul
        id={list}
        hidden={!open}
        className={`absolute z-50 w-44 rounded-2xl border border-line bg-deep p-1.5 shadow-[0_24px_64px_-28px_rgba(0,0,0,0.8)] ${full ? "bottom-11 left-0" : "top-11 right-0"}`}
      >
        {LOCALES.map((code) => (
          <li key={code}>
            <a
              href={pathFor(code, page)}
              hrefLang={LANGUAGES[code].tag}
              lang={LANGUAGES[code].tag}
              aria-current={code === current ? "page" : undefined}
              onClick={() => remember(code)}
              className="flex h-10 items-center justify-between gap-3 rounded-xl px-3 text-mute transition hover:bg-line/60 hover:text-ink aria-[current=page]:text-ink"
            >
              {LANGUAGES[code].name}
              {code === current && <span aria-hidden className="size-1.5 rounded-full bg-amber" />}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Globe() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4">
      <g fill="none" stroke="currentColor" strokeWidth="1.2">
        <circle cx="8" cy="8" r="6.4" />
        <ellipse cx="8" cy="8" rx="2.8" ry="6.4" />
        <path d="M1.8 8h12.4" />
      </g>
    </svg>
  );
}
