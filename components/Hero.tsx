"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { holdFile } from "@/lib/client/held";
import { pathFor } from "@/lib/locales";
import { DoorHeader } from "./DoorHeader";
import { CARD, DropZone, PageDrop, SeeExample } from "./Drop";
import { useI18n } from "./I18n";
import { Logbook } from "./Logbook";

const SECOND = "w-full rounded-full border border-line px-7 py-3 text-lg font-medium text-ink transition hover:border-mute sm:w-fit";

const noop = () => () => {};
/** False on the server and while hydrating, true after: units follow the visitor's language only once on the client. */
const useHydrated = () => useSyncExternalStore(noop, () => true, () => false);

export function Hero({ onListen, onExample, error, qr }: { onListen: () => void; onExample: () => void; error: string | null; qr: string }) {
  const { m, locale } = useI18n();
  const t = m.hero;
  const router = useRouter();
  const where = pathFor(locale, "/where");
  const [opening, setOpening] = useState(false);
  const [door, setDoor] = useState(false);

  useEffect(() => router.prefetch(where), [router, where]);

  // The file goes on to the one flow for a file, in memory: the page around it does not move.
  const onFile = useCallback(
    (file: File) => {
      holdFile(file);
      setOpening(true);
      // Always from the top of the page, wherever on the home it was dropped.
      window.scrollTo({ top: 0, behavior: "instant" });
      router.push(where, { scroll: false });
    },
    [router, where],
  );

  // On a computer the way to a phone comes first; a phone is already what listens outdoors.
  const listen = () => {
    if (window.matchMedia("(pointer: fine)").matches) setDoor(true);
    else onListen();
  };

  return (
    <div className="flex flex-col gap-8">
      <DoorHeader title={m.where.title} lead={m.where.lead} note={m.where.private} />
      <PageDrop onFile={onFile} />
      <section className={CARD} data-testid="door">
        {opening ? (
          <p className="flex grow items-center justify-center font-mono text-sm text-mute" role="status">
            {m.check.steps.open}
          </p>
        ) : (
          <DropZone onFile={onFile} />
        )}
        <SeeExample />
      </section>

      {/* The second door takes the narrower column: its words fill it, no hole above the link. */}
      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <div className="flex flex-col gap-4 rounded-3xl border border-line bg-deep/80 p-5 sm:p-6" data-testid="second-door">
          <h2 className="text-3xl font-semibold tracking-tight text-balance">{t.doorTitle}</h2>
          <p className="text-lg text-pretty text-mute">{t.doorText}</p>
          {error && (
            <p role="alert" className="rounded-2xl border border-amber/40 bg-amber/10 px-4 py-3 text-pretty text-amber-soft">
              {error}
            </p>
          )}
          {/* What to do sits at the foot of the card, in line with the example's own link. */}
          <div className="mt-auto flex flex-col gap-4">
            {door ? (
              <>
                <button type="button" onClick={onListen} className={SECOND} data-testid="listen-here">
                  {t.listenHere}
                </button>
                <div className="flex w-fit items-center gap-4 rounded-2xl border border-line bg-deep/70 p-4" data-testid="qr">
                  <div className="size-24 shrink-0 overflow-hidden rounded-lg bg-ink p-1.5 [&>svg]:size-full" aria-hidden dangerouslySetInnerHTML={{ __html: qr }} />
                  <p className="text-sm text-pretty text-mute">
                    <span className="block font-medium text-ink">{t.qrTitle}</span>
                    {t.qrBody}
                  </p>
                </div>
              </>
            ) : (
              <button type="button" onClick={listen} className={SECOND} data-testid="listen">
                {t.listen}
              </button>
            )}
            <Link href={pathFor(locale, "/somewhere-else")} className="group w-fit text-pretty text-mute transition hover:text-ink" data-testid="elsewhere-link">
              {m.elsewhere.link}{" "}
              <span aria-hidden className="inline-block text-amber-soft transition group-hover:translate-x-1">
                →
              </span>
            </Link>
          </div>
        </div>
        <ExampleCard onOpen={onExample} />
      </div>
      <Logbook />
    </div>
  );
}

/**
 * What a result looks like, before anything is asked of the visitor: the example's own verdict
 * and numbers (lib/client/example.ts: the Cessna passes 420 m to the side, 550 m up), and the
 * way into it.
 */
function ExampleCard({ onOpen }: { onOpen: () => void }) {
  const hydrated = useHydrated();
  const { m, f } = useI18n();
  const { example: t, facts: label } = m;
  const facts: [string, string][] = [
    [f.km(690), label.closest],
    // Feet for American English, known only once in the browser.
    [hydrated ? f.height(550) : f.km(550), label.above],
    [f.seconds(2), label.delay],
  ];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-col gap-5 rounded-3xl border border-line bg-deep/80 p-5 text-left transition hover:border-mute sm:p-6"
      aria-label={t.label}
      data-testid="example"
    >
      <span className="flex flex-wrap items-center gap-2 text-xs font-medium tracking-wide text-mute uppercase">
        <span className="rounded-full border border-amber/40 bg-amber/10 px-2.5 py-1 tracking-normal text-amber-soft normal-case">{t.chip}</span>
        {t.found}
      </span>
      <span className="text-3xl font-semibold tracking-tight text-balance">{t.verdict}</span>
      <ExampleSpectrum />
      <span className="grid grid-cols-3 gap-4">
        {facts.map(([value, label]) => (
          <span key={label} className="flex flex-col gap-1">
            <span className="font-mono text-lg font-semibold whitespace-nowrap text-ink tabular-nums sm:text-2xl">{value}</span>
            <span className="text-sm text-pretty text-mute">{label}</span>
          </span>
        ))}
      </span>
      <span className="mt-auto font-medium text-amber-soft">
        {t.open}{" "}
        <span aria-hidden className="inline-block transition group-hover:translate-x-1">
          →
        </span>
      </span>
    </button>
  );
}

// Two harmonics of a Doppler curve, as the spectrum shows a plane passing: higher while it comes,
// lower once it leaves.
const W = 320;
const H = 120;
const CURVES = [1, 2].map((h) => {
  const pts: string[] = [];
  for (let x = 0; x <= W; x += 4) {
    const f = 1 + 0.14 * Math.tanh(-(x - 150) / 34);
    pts.push(`${x},${(H + 6 - h * 44 * f).toFixed(1)}`);
  }
  return { h, d: `M${pts.join(" L")}` };
});

function ExampleSpectrum() {
  return (
    <svg aria-hidden viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-28 w-full overflow-hidden rounded-xl border border-line">
      <defs>
        <filter id="example-noise" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.16 0.09" numOctaves={2} seed={7} />
          <feColorMatrix type="matrix" values="0 0 0 0 0.24  0 0 0 0 0.31  0 0 0 0 0.72  0 0 0 1 0" />
          <feComponentTransfer>
            <feFuncA type="discrete" tableValues="0 0 0 0.1 0.25 0.42 0.6" />
          </feComponentTransfer>
        </filter>
      </defs>
      <rect width={W} height={H} fill="#070b18" />
      <rect width={W} height={H} filter="url(#example-noise)" />
      {CURVES.map(({ h, d }) => (
        <path key={h} d={d} fill="none" stroke="#ffb547" strokeWidth={h === 1 ? 4 : 3} strokeOpacity={h === 1 ? 0.9 : 0.5} strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}
