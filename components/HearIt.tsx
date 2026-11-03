"use client";

import { useEffect, useMemo, useState } from "react";
import type { AircraftMeta } from "@/lib/adsb";
import type { Match } from "@/lib/core/match";
import type { Recording } from "@/lib/core/pipeline";
import { asHeard, revealed, speedFor } from "@/lib/client/reveal";
import { useI18n } from "@/components/I18n";

/** The band the plane's curve went through in the recording. */
function bandOf(match: Match<AircraftMeta>): { lo: number; hi: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of match.factor) {
    if (!Number.isFinite(f)) continue;
    lo = Math.min(lo, f * match.f0);
    hi = Math.max(hi, f * match.f0);
  }
  return Number.isFinite(lo) ? { lo, hi } : null;
}

/** The recording as the phone heard it, then the plane brought out of it. */
export function HearIt({ rec, match }: { rec: Recording; match: Match<AircraftMeta> | null }) {
  const heard = useMemo(() => asHeard(rec.samples, rec.sampleRate), [rec]);
  useEffect(() => () => URL.revokeObjectURL(heard), [heard]);
  const band = useMemo(() => (match ? bandOf(match) : null), [match]);
  const speed = band ? speedFor(band.lo, band.hi) : 1;
  const [plane, setPlane] = useState<{ url: string; for: Match<AircraftMeta> } | null>(null);
  useEffect(() => {
    if (!band || !match) return;
    let url: string | null = null;
    let live = true;
    void revealed(rec.samples, rec.sampleRate, band.lo, band.hi, speed).then((u) => {
      url = u;
      if (live) setPlane({ url: u, for: match });
      else URL.revokeObjectURL(u);
    });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [rec, band, match, speed]);
  const planeUrl = plane && plane.for === match ? plane.url : null;
  const { m, fill, plural } = useI18n();
  const t = m.hearIt;
  const times = String(speed) in t.times ? t.times[String(speed) as keyof typeof t.times] : plural(speed, t.times);

  return (
    <div className="flex flex-col gap-4" data-testid="hear-it">
      <h3 className="text-sm font-medium tracking-wide text-mute uppercase">{t.title}</h3>
      <div className={`grid gap-4 ${match ? "lg:grid-cols-2" : ""}`}>
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-deep p-4">
          <p className="font-medium">{t.yours}</p>
          <p className="text-sm text-pretty text-mute">{t.yoursText}</p>
          <audio controls src={heard} className="w-full [color-scheme:dark]" preload="metadata" />
        </div>
        {match && (
          <div className="flex flex-col gap-2 rounded-2xl border border-amber/30 bg-amber/5 p-4">
            <p className="font-medium text-amber-soft">{t.plane}</p>
            <p className="text-sm text-pretty text-mute">{speed > 1 ? fill(t.planeTextFaster, { times }) : t.planeText}</p>
            {planeUrl ? <audio controls src={planeUrl} className="w-full [color-scheme:dark]" preload="metadata" data-testid="revealed" /> : <p className="text-sm text-faint">{t.preparing}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
