"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { pathFor } from "@/lib/locales";
import { useI18n } from "./I18n";
import { Logbook } from "./Logbook";

const noop = () => () => {};
/** False on the server and while hydrating, true after: units follow the visitor's language only once on the client. */
const useHydrated = () => useSyncExternalStore(noop, () => true, () => false);

export function Hero({ onListen, onExample, error, qr }: { onListen: () => void; onExample: () => void; error: string | null; qr: string }) {
  const { m, locale } = useI18n();
  const t = m.hero;
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-5xl leading-[1.02] font-semibold tracking-tight text-balance sm:text-6xl">{t.title}</h1>
      <div className="grid gap-10 lg:grid-cols-2 lg:items-start lg:gap-14">
        <div className="flex flex-col gap-6">
          <p className="text-lg text-pretty text-mute sm:text-xl">
            {t.lead}
          </p>
          {error && (
            <p role="alert" className="rounded-2xl border border-amber/40 bg-amber/10 px-4 py-3 text-pretty text-amber-soft">
              {error}
            </p>
          )}
          <button type="button" onClick={onListen} className="w-full rounded-full bg-amber px-7 py-3.5 text-lg font-medium text-night transition hover:bg-amber-soft sm:w-fit" data-testid="listen">
            {t.listen}
          </button>
          <ul className="flex flex-col gap-2 text-mute">
            {t.needs.map((need) => (
              <li key={need} className="flex items-baseline gap-3">
                <span aria-hidden className="size-1.5 shrink-0 translate-y-[-0.15em] rounded-full bg-amber/70" />
                {need}
              </li>
            ))}
          </ul>
          {/* On a computer (a mouse, no touch screen): the way to the phone, which is what listens outdoors. */}
          <div className="hidden w-fit items-center gap-4 rounded-2xl border border-line bg-deep/70 p-4 pointer-fine:flex" data-testid="qr">
            <div className="size-24 shrink-0 overflow-hidden rounded-lg bg-ink p-1.5 [&>svg]:size-full" aria-hidden dangerouslySetInnerHTML={{ __html: qr }} />
            <p className="text-sm text-pretty text-mute">
              <span className="block font-medium text-ink">{t.qrTitle}</span>
              {t.qrBody}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <ExampleCard onOpen={onExample} />
          <Link href={pathFor(locale, "/check")} className="group w-fit text-pretty text-mute transition hover:text-ink" data-testid="check-link">
            {m.check.link}{" "}
            <span aria-hidden className="inline-block text-amber-soft transition group-hover:translate-x-1">
              →
            </span>
          </Link>
          <Link href={pathFor(locale, "/somewhere-else")} className="group w-fit text-pretty text-mute transition hover:text-ink" data-testid="elsewhere-link">
            {m.elsewhere.link}{" "}
            <span aria-hidden className="inline-block text-amber-soft transition group-hover:translate-x-1">
              →
            </span>
          </Link>
        </div>
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
      <span className="font-medium text-amber-soft">
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
    <svg aria-hidden viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-28 w-full overflow-hidden rounded-xl border border-line sm:h-32">
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
