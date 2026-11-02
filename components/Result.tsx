"use client";

import { useMemo, useState } from "react";
import type { Analysis, Recording } from "@/lib/core/pipeline";
import { candidatesOf } from "@/lib/core/pipeline";
import { STRONG } from "@/lib/core/match";
import { stateAt } from "@/lib/core/track";
import { norm } from "@/lib/core/geo";
import { describe, feet, km, knots, nameOf, seconds } from "@/lib/client/format";
import { isTonal } from "@/lib/client/types";
import { Spectrum } from "./Spectrum";
import { TrackPlot } from "./TrackPlot";

export function Result({ analysis, rec, example, onBundle, onAgain }: { analysis: Analysis; rec: Recording; example: boolean; onBundle: (() => void) | null; onAgain: () => void }) {
  const { verdict } = analysis;
  const best = verdict.kind === "none" ? null : verdict.best;
  const [showCurve, setShowCurve] = useState(false);
  const candidates = useMemo(() => candidatesOf(rec.polls, rec.listener), [rec]);
  const duration = rec.samples.length / rec.sampleRate;

  // Where the aircraft was, and how fast it went, when the sound heard at the closest moment left it.
  const facts = useMemo(() => {
    if (!best?.closest) return null;
    const c = candidates.find((x) => x.id === best.id);
    if (!c) return null;
    const emitted = rec.start + best.closest.heardAt + best.clock - best.closest.delay;
    const s = stateAt(c.track, emitted);
    if (!s) return null;
    return { emitted, height: s.p[2], speed: norm([s.v[0], s.v[1], 0]), range: best.closest.range, delay: best.closest.delay };
  }, [best, candidates, rec]);

  const name = best ? nameOf(best.meta) : null;
  const kindText = best ? describe(best.meta) : "";

  return (
    <section className="flex flex-col gap-8" aria-live="polite">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs font-medium tracking-wide text-mute uppercase">
          {example && <span className="rounded-full border border-amber/40 bg-amber/10 px-2.5 py-1 text-amber-soft normal-case tracking-normal">Simulated example</span>}
          <span>{verdict.kind === "strong" ? "Found it" : verdict.kind === "possible" ? "A faint match" : "Nothing clear"}</span>
        </div>
        <h2 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl" data-testid="verdict">
          {verdict.kind === "strong" && <>It was {name}.</>}
          {verdict.kind === "possible" && <>Probably {name}.</>}
          {verdict.kind === "none" && <>No plane matched.</>}
        </h2>
        {best && facts && (
          <p className="max-w-prose text-lg text-pretty text-mute">
            {kindText ? `${kindText}, ` : ""}
            {feet(Math.max(0, facts.height))} above you and {km(facts.range)} away at its closest, flying at {knots(facts.speed)}. The sound you heard then had left it {seconds(facts.delay)} earlier.
            {verdict.kind === "possible" && " The trace is faint, so take it as a good guess."}
          </p>
        )}
        {verdict.kind === "none" && (
          <p className="max-w-prose text-lg text-pretty text-mute">
            We compared your recording with {analysis.seen} {analysis.seen === 1 ? "plane" : "planes"} around you. None left a clear trace. Try again when one passes within a few kilometers, ideally a propeller plane or a helicopter.
          </p>
        )}
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-3">
          <Spectrum analysis={analysis} match={best} showCurve={showCurve} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-pretty text-mute">
              {best ? (showCurve ? "The rails show the curve this flight should have left in your recording. The line between them is what your phone heard." : "Your recording, zoomed in on the band where the tone moved. See the faint bent line?") : "Your recording between 40 and 300 Hz."}
            </p>
            {best && (
              <button type="button" onClick={() => setShowCurve((v) => !v)} className="shrink-0 rounded-full border border-amber/50 px-4 py-2 text-sm font-medium text-amber-soft transition hover:bg-amber/10" data-testid="curve-toggle">
                {showCurve ? "Hide the curve" : "Show the plane's curve"}
              </button>
            )}
          </div>
        </div>
        <TrackPlot candidates={candidates} bestId={best?.id ?? null} from={rec.start - 30} to={rec.start + duration} mark={facts?.emitted ?? null} />
      </div>

      {verdict.ranked.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium tracking-wide text-mute uppercase">Every plane we checked</h3>
          <ol className="flex flex-col divide-y divide-line overflow-hidden rounded-2xl border border-line bg-deep">
            {verdict.ranked.slice(0, 8).map((m) => {
              const tonal = isTonal(m.meta.type, m.meta.category);
              const top = m.id === best?.id;
              return (
                <li key={m.id} className="flex items-center gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className={`truncate font-medium ${top ? "text-amber-soft" : ""}`}>{nameOf(m.meta)}</div>
                    <div className="truncate text-sm text-faint">
                      {[describe(m.meta) || null, m.closest ? `${km(m.closest.range)} at closest` : null, tonal === false ? "jet" : null].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <div className="flex w-28 shrink-0 items-center gap-2 sm:w-40">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                      <div className={`h-full rounded-full ${top ? "bg-amber" : "bg-faint"}`} style={{ width: `${Math.max(3, Math.min(100, (m.score / 12) * 100))}%` }} />
                    </div>
                    <span className="w-8 text-right font-mono text-xs text-mute">{m.score.toFixed(1)}</span>
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="text-sm text-pretty text-faint">The score says how far each plane&apos;s curve stands above chance in your recording. With no plane to find, no score has reached {STRONG.score} in our tests.</p>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="button" onClick={onAgain} className="rounded-full bg-ink px-6 py-3 font-medium text-night transition hover:bg-white">
          {example ? "Listen to the real sky" : "Listen again"}
        </button>
        {onBundle && (
          <button type="button" onClick={onBundle} className="rounded-full border border-line px-6 py-3 font-medium text-ink transition hover:border-mute" data-testid="bundle">
            Download recording bundle
          </button>
        )}
      </div>
    </section>
  );
}
