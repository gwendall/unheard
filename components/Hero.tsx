"use client";

import { useSyncExternalStore } from "react";
import { height, km, seconds } from "@/lib/client/format";

const noop = () => () => {};
/** False on the server and while hydrating, true after: units follow the visitor's language only once on the client. */
const useHydrated = () => useSyncExternalStore(noop, () => true, () => false);

export function Hero({ onListen, onExample, error, qr }: { onListen: () => void; onExample: () => void; error: string | null; qr: string }) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <p className="font-mono text-sm tracking-[0.2em] text-amber uppercase">Unheard</p>
        <h1 className="text-5xl leading-[1.02] font-semibold tracking-tight text-balance sm:text-6xl">There&apos;s a plane you can&apos;t hear.</h1>
      </div>
      <div className="grid gap-10 lg:grid-cols-2 lg:items-start lg:gap-14">
        <div className="flex flex-col gap-6">
          <p className="text-lg text-pretty text-mute sm:text-xl">
            Your phone can. Unheard shows you the planes passing nearby, listens while one flies over, and finds its faint hum in the noise to tell you which plane it was.
          </p>
          {error && (
            <p role="alert" className="rounded-2xl border border-amber/40 bg-amber/10 px-4 py-3 text-pretty text-amber-soft">
              {error}
            </p>
          )}
          <button type="button" onClick={onListen} className="w-full rounded-full bg-amber px-7 py-3.5 text-lg font-medium text-night transition hover:bg-amber-soft sm:w-fit" data-testid="listen">
            Listen to the sky
          </button>
          <ul className="flex flex-col gap-2 text-mute">
            {["A phone, outdoors, and a minute or two", "Best with propeller planes and helicopters", "Your recording stays on your phone unless you choose to give it"].map((t) => (
              <li key={t} className="flex items-baseline gap-3">
                <span aria-hidden className="size-1.5 shrink-0 translate-y-[-0.15em] rounded-full bg-amber/70" />
                {t}
              </li>
            ))}
          </ul>
          {/* On a computer (a mouse, no touch screen): the way to the phone, which is what listens outdoors. */}
          <div className="hidden w-fit items-center gap-4 rounded-2xl border border-line bg-deep/70 p-4 pointer-fine:flex" data-testid="qr">
            <div className="size-24 shrink-0 overflow-hidden rounded-lg bg-ink p-1.5 [&>svg]:size-full" aria-hidden dangerouslySetInnerHTML={{ __html: qr }} />
            <p className="text-sm text-pretty text-mute">
              <span className="block font-medium text-ink">Better on a phone, outdoors.</span>
              Point your phone&apos;s camera here to open Unheard on it.
            </p>
          </div>
        </div>
        <ExampleCard onOpen={onExample} />
      </div>
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
  const facts: [string, string][] = [
    [km(690), "from you at its closest"],
    [hydrated ? height(550) : "550 m", "above you"],
    [seconds(2), "for its sound to reach you"],
  ];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-col gap-5 rounded-3xl border border-line bg-deep/80 p-5 text-left transition hover:border-mute sm:p-6"
      aria-label="See an example result: a Cessna 172 Skyhawk found in a simulated recording"
      data-testid="example"
    >
      <span className="flex flex-wrap items-center gap-2 text-xs font-medium tracking-wide text-mute uppercase">
        <span className="rounded-full border border-amber/40 bg-amber/10 px-2.5 py-1 tracking-normal text-amber-soft normal-case">Simulated example</span>
        Found it
      </span>
      <span className="text-3xl font-semibold tracking-tight text-balance">It was a Cessna 172 Skyhawk.</span>
      <ExampleSpectrum />
      <span className="grid grid-cols-3 gap-4">
        {facts.map(([value, label]) => (
          <span key={label} className="flex flex-col gap-1">
            <span className="font-mono text-xl font-semibold text-ink tabular-nums sm:text-2xl">{value}</span>
            <span className="text-sm text-pretty text-mute">{label}</span>
          </span>
        ))}
      </span>
      <span className="font-medium text-amber-soft">
        See this example in full{" "}
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
