"use client";

import { useEffect, useRef, useState } from "react";
import type { AircraftMeta } from "@/lib/adsb";
import type { Nearby } from "@/lib/client/nearby";
import { audible, HORIZON } from "@/lib/client/chance";
import { nameOf } from "@/lib/client/format";
import { useI18n } from "./I18n";
import { lookUp, type Identity } from "@/lib/client/names";

/** Identities of the aircraft shown, looked up once each, filled in as the answers come. */
/** The names people use (flight, model), looked up once per aircraft from the phone. */
export function useIdentities(list: { meta: AircraftMeta }[], at: { lat: number; lon: number } | null): Map<string, Identity> {
  const [ids, setIds] = useState<Map<string, Identity>>(() => new Map());
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const n of list) {
      if (asked.current.has(n.meta.hex)) continue;
      asked.current.add(n.meta.hex);
      void lookUp(n.meta, at).then((id) => setIds((m) => new Map(m).set(n.meta.hex, id)));
    }
  }, [list, at]);
  return ids;
}

/** Seconds until an aircraft is closest, counted down since the poll that said so. */
export const countdown = (n: Nearby, receivedAt: number, now: number) => n.closestIn - (now - receivedAt) / 1000;

export function titleOf(n: Nearby, ids: Map<string, Identity>): string {
  return ids.get(n.meta.hex)?.title ?? nameOf(n.meta);
}

/** The aircraft that can be heard first, then the rest by distance. */
export function ranked(around: Nearby[], limit = 6): Nearby[] {
  return [...around].sort((a, b) => Number(audible(b)) - Number(audible(a)) || a.distance - b.distance).slice(0, limit);
}

export function SkyList({ list, ids, receivedAt, now, target }: { list: Nearby[]; ids: Map<string, Identity>; receivedAt: number; now: number; target: string | null }) {
  const { m, f, fill } = useI18n();
  const t = m.list;
  if (!list.length) return null;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium tracking-wide text-mute uppercase">{t.title}</h3>
      <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-2xl border border-line bg-deep" data-testid="sky-list">
        {list.map((n) => {
          const id = ids.get(n.meta.hex);
          const hear = audible(n);
          const left = countdown(n, receivedAt, now);
          const route = id?.route ? fill(m.route, { from: id.route.from.city, to: id.route.to.city }) : null;
          const detail = [route, id?.detail || null, fill(t.up, { height: f.height(Math.max(0, n.height)) })].filter(Boolean).join(" · ");
          const when = Math.abs(left) <= 15 ? t.passingNow : left < 0 ? t.movingAway : left < HORIZON ? fill(t.closestIn, { when: f.clock(left), distance: f.km(n.closestAt) }) : t.farOff;
          return (
            <li key={n.meta.hex} className={`flex items-center justify-between gap-4 px-4 py-3 ${n.meta.hex === target ? "bg-amber/5" : ""}`}>
              <div className="min-w-0">
                <div className="flex items-start gap-2">
                  {hear && <span className="mt-2 size-2 shrink-0 rounded-full bg-amber" aria-label={t.audible} />}
                  <span className="line-clamp-2 font-medium text-balance break-words">{titleOf(n, ids)}</span>
                </div>
                <div className="truncate text-sm text-faint">{detail}</div>
              </div>
              <div className="shrink-0 text-right text-sm">
                <div className="font-mono tabular-nums">{f.km(n.distance)}</div>
                <div className={`tabular-nums ${hear ? "text-amber-soft" : "text-faint"}`}>{when}</div>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-pretty text-faint">
        <span className="mr-1.5 inline-block size-2 rounded-full bg-amber align-middle" />
        {t.legend}
      </p>
    </div>
  );
}
