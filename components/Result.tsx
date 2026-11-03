"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Analysis, Recording } from "@/lib/core/pipeline";
import { candidatesOf } from "@/lib/core/pipeline";
import { STRONG, type Match } from "@/lib/core/match";
import type { AircraftMeta } from "@/lib/adsb";
import { stateAt } from "@/lib/core/track";
import { norm } from "@/lib/core/geo";
import { useFormat, useLang, useT } from "@/lib/i18n/client";
import type { Dict } from "@/lib/i18n";
import { identityOf, spoken } from "@/lib/client/names";
import { photoOf, type Photo } from "@/lib/client/photo";
import { aircraftType, isTonal } from "@/lib/client/types";
import type { Bundle } from "@/lib/bundle";
import { Donate } from "./Donate";
import { HearIt } from "./HearIt";
import { paintSpectrum, Spectrum } from "./Spectrum";
import { Share } from "./Share";
import { useIdentities } from "./SkyList";
import { TrackPlot } from "./TrackPlot";
import { record, useLogbook } from "./Logbook";

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
  const all = useT();
  const t = all.result;
  const f = useFormat();
  const lang = useLang();
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

  // The names people use, looked up from the phone for every plane checked, and the found one's
  // photo: never for the simulated example (its made-up codes belong to real aircraft), which keeps
  // the names its type codes give.
  const checked = useMemo(() => (example ? [] : verdict.ranked.slice(0, 8)), [example, verdict]);
  const ids = useIdentities(checked, rec.listener);
  const known = useCallback((meta: AircraftMeta) => ids.get(meta.hex) ?? identityOf(meta, null, null), [ids]);
  const identity = best ? known(best.meta) : null;
  const [shot, setShot] = useState<{ hex: string; photo: Photo | null } | null>(null);
  useEffect(() => {
    if (!best || example) return;
    let live = true;
    const hex = best.meta.hex;
    void photoOf(hex).then((photo) => live && setShot({ hex, photo }));
    return () => {
      live = false;
    };
  }, [best, example]);
  const photo = shot && best && shot.hex === best.meta.hex ? shot.photo : null;

  // A real find goes in the logbook on this phone; a better name found a moment later replaces
  // the entry (same aircraft, same flyby).
  const sure = verdict.kind === "strong";
  const title = identity?.title ?? null;
  const kind = identity?.kind ?? null;
  const from = identity?.route?.from.city ?? null;
  const to = identity?.route?.to.city ?? null;
  const [savedAt] = useState(() => Date.now());
  useEffect(() => {
    if (example || !best || !facts || !title || !kind) return;
    record({ at: savedAt, hex: best.meta.hex, title, kind, sure, range: facts.range, height: Math.max(0, facts.height), route: from && to ? { from, to } : null });
  }, [example, best, facts, title, kind, sure, savedAt, from, to]);
  const log = useLogbook();
  const name = identity ? spoken(identity, lang) : null;
  const detail = identity ? [identity.route ? all.route(identity.route.from.city, identity.route.to.city) : null, identity.detail || null].filter(Boolean).join(" · ") : "";

  return (
    <section className="flex flex-col gap-8" aria-live="polite">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs font-medium tracking-wide text-mute uppercase">
          {example && <span className="rounded-full border border-amber/40 bg-amber/10 px-2.5 py-1 text-amber-soft normal-case tracking-normal">{all.example.chip}</span>}
          <span>{verdict.kind === "strong" ? t.found : verdict.kind === "possible" ? t.faint : t.nothing}</span>
        </div>
        <h2 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl" data-testid="verdict">
          {verdict.kind === "strong" && t.strong(name ?? "")}
          {verdict.kind === "possible" && t.possible(name ?? "")}
          {verdict.kind === "none" && t.none}
        </h2>
        {best && detail && (
          <p className="text-lg text-pretty text-mute" data-testid="identity">
            {detail}
          </p>
        )}
        {best && !example && (
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-faint">
            <a href={`https://globe.adsb.lol/?icao=${best.meta.hex}`} target="_blank" rel="noreferrer" className="text-amber-soft underline-offset-4 hover:underline" data-testid="follow">
              {all.follow} <span aria-hidden>→</span>
            </a>
            {log.some((e) => e.hex === best.meta.hex) && <span data-testid="logged">{all.logbook.added(log.length)}</span>}
          </p>
        )}
        {verdict.kind === "possible" && <p className="text-pretty text-faint">{t.guess}</p>}
        {verdict.kind === "none" && (
          <p className="max-w-prose text-lg text-pretty text-mute">
            {t.noneText(analysis.seen)}
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
                alt={identity ? t.photographed(identity.title) : t.theAircraft}
                className="h-auto w-full rounded-2xl border border-line bg-deep object-cover opacity-0 transition-opacity duration-500 data-[loaded]:opacity-100"
                onLoad={(e) => e.currentTarget.setAttribute("data-loaded", "")}
              />
              <figcaption className="text-xs text-faint">
                {t.photo}{" "}
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
          text={t.shareText(verdict.kind === "possible", spoken(identity, lang), f.km(facts.range))}
          card={{
            lead: t.shareLead(verdict.kind === "possible"),
            name: spoken(identity, lang),
            detail,
            facts: [
              [f.km(facts.range), t.shareFacts.closest],
              [f.height(Math.max(0, facts.height)), t.shareFacts.above],
              [f.seconds(facts.delay), t.shareFacts.delay],
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
              {best ? (showCurve ? t.curveShown : t.curveHidden) : t.band}
            </p>
            {best && (
              <button type="button" onClick={() => setShowCurve((v) => !v)} className="shrink-0 rounded-full border border-amber/50 px-4 py-2 text-sm font-medium text-amber-soft transition hover:bg-amber/10" data-testid="curve-toggle">
                {showCurve ? t.hideCurve : t.showCurve}
              </button>
            )}
          </div>
        </div>
        <TrackPlot candidates={candidates} bestId={best?.id ?? null} from={rec.start - 30} to={rec.start + duration} mark={facts?.emitted ?? null} />
      </div>

      {verdict.ranked.length > 0 && (
        <details className="group flex flex-col gap-3" open={verdict.kind === "none"}>
          <summary className="cursor-pointer text-sm font-medium tracking-wide text-mute uppercase marker:text-faint">
            {t.checked(Math.min(8, verdict.ranked.length))}
          </summary>
          <ol className="mt-3 flex flex-col divide-y divide-line overflow-hidden rounded-2xl border border-line bg-deep">
            {verdict.ranked.slice(0, 8).map((m) => {
              const tonal = isTonal(m.meta.type, m.meta.category);
              const top = m.id === best?.id;
              const id = known(m.meta);
              return (
                <li key={m.id} className="flex items-center gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className={`truncate font-medium ${top ? "text-amber-soft" : ""}`}>{id.title}</div>
                    <div className="truncate text-sm text-faint">
                      {[id.detail || null, m.closest ? t.atClosest(f.km(m.closest.range)) : null, tonal === false ? t.jet : null].filter(Boolean).join(" · ")}
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
          <p className="mt-3 text-sm text-pretty text-faint">{t.score(STRONG.score)}</p>
        </details>
      )}

      {!example && <Donate rec={rec} analysis={analysis} device={device} title={(meta) => known(meta).title} />}

      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="button" onClick={onAgain} className="rounded-full bg-ink px-6 py-3 font-medium text-night transition hover:bg-white">
          {example ? t.realSky : t.again}
        </button>
        {onBundle && (
          <button type="button" onClick={onBundle} className="rounded-full border border-line px-6 py-3 font-medium text-ink transition hover:border-mute" data-testid="bundle">
            {t.bundle}
          </button>
        )}
      </div>
    </section>
  );
}

type Facts = { emitted: number; height: number; speed: number; range: number; delay: number };

/** What its hum is, by kind of aircraft. */
function humOf(type: string | undefined, hum: Dict["result"]["hum"]): string {
  const kind = aircraftType(type)?.kind;
  if (kind === "piston" || kind === "turboprop") return hum.prop;
  if (kind === "helicopter") return hum.rotor;
  if (kind === "jet") return hum.jet;
  return hum.any;
}

/** The numbers worth telling a friend, each in a word or two. */
function Facts({ best, facts }: { best: Match<AircraftMeta>; facts: Facts }) {
  const { result: t, facts: label } = useT();
  const f = useFormat();
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of best.factor) {
    if (!Number.isFinite(f)) continue;
    lo = Math.min(lo, f);
    hi = Math.max(hi, f);
  }
  const fall = Number.isFinite(lo) && hi > 0 ? Math.round((1 - lo / hi) * 100) : 0;
  const items: [string, string][] = [
    [f.km(facts.range), label.closest],
    [f.height(Math.max(0, facts.height)), label.above],
    [f.speed(facts.speed), t.speed],
    [f.seconds(facts.delay), label.delay],
    [`${Math.round(best.f0)}\u00a0Hz`, humOf(best.meta.type, t.hum)],
  ];
  if (fall >= 1) items.push([`${fall}\u00a0%`, t.fall]);
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
