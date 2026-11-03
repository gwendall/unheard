"use client";

import { useEffect, useMemo, useState } from "react";
import type { Analysis, Recording } from "@/lib/core/pipeline";
import { candidatesOf } from "@/lib/core/pipeline";
import { STRONG, type Match } from "@/lib/core/match";
import type { AircraftMeta } from "@/lib/adsb";
import { stateAt } from "@/lib/core/track";
import { norm } from "@/lib/core/geo";
import { describe, height, km, nameOf, seconds, speed } from "@/lib/client/format";
import { identityOf, lookUp, spoken, type Identity } from "@/lib/client/names";
import { photoOf, type Photo } from "@/lib/client/photo";
import { aircraftType, isTonal } from "@/lib/client/types";
import type { Bundle } from "@/lib/bundle";
import { Donate } from "./Donate";
import { HearIt } from "./HearIt";
import { paintSpectrum, Spectrum } from "./Spectrum";
import { Share } from "./Share";
import { TrackPlot } from "./TrackPlot";

export function Result({
  analysis,
  rec,
  example,
  device,
  onBundle,
  onAgain,
}: {
  analysis: Analysis;
  rec: Recording;
  example: boolean;
  device: Bundle["device"] | null;
  onBundle: (() => void) | null;
  onAgain: () => void;
}) {
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

  // The name people use, then its photo: looked up from the phone, never for the simulated
  // example (its made-up codes belong to real aircraft).
  const [found, setFound] = useState<{ hex: string; id: Identity | null; photo: Photo | null } | null>(null);
  useEffect(() => {
    if (!best || example) return;
    let live = true;
    const hex = best.meta.hex;
    void lookUp(best.meta, rec.listener).then((id) => live && setFound((f) => ({ hex, id, photo: f?.hex === hex ? f.photo : null })));
    void photoOf(hex).then((photo) => live && setFound((f) => ({ hex, id: f?.hex === hex ? f.id : null, photo })));
    return () => {
      live = false;
    };
  }, [best, example, rec.listener]);
  const looked = found && best && found.hex === best.meta.hex ? found : null;
  const identity = best ? (looked?.id ?? identityOf(best.meta, null, null)) : null;
  const photo = looked?.photo ?? null;
  const name = identity ? spoken(identity) : null;
  const detail = identity ? [identity.route ? `${identity.route.from.city} to ${identity.route.to.city}` : null, identity.detail || null].filter(Boolean).join(" · ") : "";

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
        {best && detail && (
          <p className="text-lg text-pretty text-mute" data-testid="identity">
            {detail}
          </p>
        )}
        {verdict.kind === "possible" && <p className="text-pretty text-faint">The trace is faint, so take it as a good guess.</p>}
        {verdict.kind === "none" && (
          <p className="max-w-prose text-lg text-pretty text-mute">
            We compared your recording with {analysis.seen} {analysis.seen === 1 ? "plane" : "planes"} around you. None left a clear trace. Try again when one passes within a few kilometers, ideally a propeller plane or a helicopter: the sky screen tells you when.
          </p>
        )}
      </header>

      {best && (facts || photo) && (
        <div className={`grid gap-6 ${photo ? "lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start" : ""}`}>
          {photo && (
            <figure className="flex flex-col gap-1.5 lg:order-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- a remote photo, shown as planespotters serves it */}
              <img
                src={photo.src}
                width={photo.width}
                height={photo.height}
                alt={identity ? `${identity.title}, photographed` : "The aircraft"}
                className="h-auto w-full rounded-2xl border border-line bg-deep object-cover opacity-0 transition-opacity duration-500 data-[loaded]:opacity-100"
                onLoad={(e) => e.currentTarget.setAttribute("data-loaded", "")}
              />
              <figcaption className="text-xs text-faint">
                Photo{" "}
                <a href={photo.link} target="_blank" rel="noreferrer" className="underline-offset-4 hover:text-mute hover:underline">
                  {photo.photographer}, planespotters.net
                </a>
              </figcaption>
            </figure>
          )}
          {facts && <Facts best={best} facts={facts} />}
        </div>
      )}

      {best && facts && identity && !example && (
        <Share
          text={`My phone ${verdict.kind === "possible" ? "probably " : ""}heard ${spoken(identity)} I couldn't hear, ${km(facts.range)} away.`}
          card={{
            lead: verdict.kind === "possible" ? "My phone probably heard" : "My phone heard",
            name: spoken(identity),
            detail,
            facts: [
              [km(facts.range), "from me at its closest"],
              [height(Math.max(0, facts.height)), "above me"],
              [seconds(facts.delay), "for its sound to reach me"],
            ],
            paint: (ctx, w, h) => paintSpectrum(ctx, w, h, analysis, best, true),
          }}
        />
      )}

      <HearIt rec={rec} match={best} />

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
        <details className="group flex flex-col gap-3" open={verdict.kind === "none"}>
          <summary className="cursor-pointer text-sm font-medium tracking-wide text-mute uppercase marker:text-faint">
            Every plane we checked ({Math.min(8, verdict.ranked.length)})
          </summary>
          <ol className="mt-3 flex flex-col divide-y divide-line overflow-hidden rounded-2xl border border-line bg-deep">
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
          <p className="mt-3 text-sm text-pretty text-faint">The score says how far each plane&apos;s curve stands above chance in your recording. With no plane to find, no score has reached {STRONG.score} in our tests.</p>
        </details>
      )}

      {!example && <Donate rec={rec} analysis={analysis} device={device} />}

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

type Facts = { emitted: number; height: number; speed: number; range: number; delay: number };

/** What its hum is, by kind of aircraft. */
function humOf(type?: string): string {
  const kind = aircraftType(type)?.kind;
  if (kind === "piston" || kind === "turboprop") return "the pitch of its propeller's hum";
  if (kind === "helicopter") return "the pitch of its rotor's beat";
  if (kind === "jet") return "the pitch of its engines' hum";
  return "the pitch of its hum";
}

/** The numbers worth telling a friend, each in a word or two. */
function Facts({ best, facts }: { best: Match<AircraftMeta>; facts: Facts }) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of best.factor) {
    if (!Number.isFinite(f)) continue;
    lo = Math.min(lo, f);
    hi = Math.max(hi, f);
  }
  const fall = Number.isFinite(lo) && hi > 0 ? Math.round((1 - lo / hi) * 100) : 0;
  const items: [string, string][] = [
    [km(facts.range), "from you at its closest"],
    [height(Math.max(0, facts.height)), "above you"],
    [speed(facts.speed), "its speed"],
    [seconds(facts.delay), "for its sound to reach you"],
    [`${Math.round(best.f0)} Hz`, humOf(best.meta.type)],
  ];
  if (fall >= 1) items.push([`${fall} %`, "lower as it flew away: the Doppler effect"]);
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3" data-testid="facts">
      {items.map(([value, label]) => (
        <div key={label} className="flex flex-col gap-1">
          <dt className="order-2 text-sm text-pretty text-mute">{label}</dt>
          <dd className="order-1 font-mono text-2xl font-semibold tabular-nums text-ink sm:text-3xl">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
