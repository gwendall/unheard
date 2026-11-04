"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/components/I18n";
import { pathFor } from "@/lib/locales";

// How a file comes in: a zone to click, and the whole page taking a drop. The file stays in the
// browser.

export const ACCEPT = "audio/*,video/*";
/** The door's frame, at one place and size on the home and on /where. */
export const CARD = "flex min-h-72 flex-col gap-6 rounded-3xl border border-line bg-deep/70 p-5 sm:p-8";
const CHOOSE = "w-full rounded-full bg-amber px-7 py-3 text-lg font-medium text-night transition group-hover:bg-amber-soft sm:w-fit";

export function DropZone({ onFile }: { onFile: (file: File) => void }) {
  const t = useI18n().m.where;
  return (
    <label
      className="group flex grow cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line px-5 py-10 text-center transition hover:border-mute has-[input:focus-visible]:border-amber has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-amber"
      data-testid="where-drop"
    >
      <input
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
        }}
        data-testid="where-file"
      />
      <span className={CHOOSE}>{t.choose}</span>
      <span className="text-mute">{t.drop}</span>
      <span className="text-sm text-faint">{t.formats}</span>
    </label>
  );
}

/** Under the zone, for whoever has no file to hand: the whole answer, on a simulated file. */
export function SeeExample() {
  const { m, locale } = useI18n();
  return (
    <p className="flex flex-col items-center gap-x-4 gap-y-2 text-center text-mute sm:flex-row sm:justify-center">
      {m.where.noFile}
      <Link href={pathFor(locale, "/example")} className="group w-full rounded-full border border-line px-7 py-3 text-lg font-medium text-ink transition hover:border-mute sm:w-fit" data-testid="see-example">
        {m.where.seeExample}{" "}
        <span aria-hidden className="inline-block text-amber-soft transition group-hover:translate-x-1">
          →
        </span>
      </Link>
    </p>
  );
}

/** A drop anywhere on the page, with a frame around it while a file is held over; nothing moves. */
export function PageDrop({ onFile }: { onFile: (file: File) => void }) {
  const [over, setOver] = useState(false);
  useEffect(() => {
    // Enter and leave fire for every element crossed: the frame goes when the count is back to zero.
    let depth = 0;
    const files = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!files(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!files(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const hold = (e: DragEvent) => {
      if (files(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const file = e.dataTransfer?.files[0];
      if (file) onFile(file);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", hold);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", hold);
      window.removeEventListener("drop", drop);
    };
  }, [onFile]);
  return <div aria-hidden className={`pointer-events-none fixed inset-2 z-50 rounded-3xl border-2 border-amber bg-amber/5 transition-opacity ${over ? "opacity-100" : "opacity-0"}`} data-testid="where-page-drop" />;
}
