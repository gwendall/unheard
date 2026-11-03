"use client";

import { useMemo } from "react";
import { stateAt, type Track } from "@/lib/core/track";
import type { Candidate } from "@/lib/core/match";
import type { AircraftMeta } from "@/lib/adsb";
import { nameOf } from "@/lib/client/format";
import { useT } from "@/lib/i18n/client";

type Path = { id: string; name: string; points: [number, number][]; mark: [number, number] | null };

function pathOf(c: Candidate<AircraftMeta>, from: number, to: number, mark: number | null): Path {
  const points: [number, number][] = [];
  for (let t = from; t <= to; t += 2) {
    const s = stateAt(c.track as Track, t);
    if (s) points.push([s.p[0], s.p[1]]);
  }
  const m = mark === null ? null : stateAt(c.track, mark);
  return { id: c.id, name: nameOf(c.meta), points, mark: m ? [m.p[0], m.p[1]] : null };
}

/**
 * The flights around the listener (north up, the listener at the centre) during the recording:
 * the matched one in amber, with a dot where it was when the sound you heard closest left it.
 */
export function TrackPlot({ candidates, bestId, from, to, mark }: { candidates: Candidate<AircraftMeta>[]; bestId: string | null; from: number; to: number; mark: number | null }) {
  const t = useT().plots;
  const paths = useMemo(() => candidates.map((c) => pathOf(c, from, to, c.id === bestId ? mark : null)).filter((p) => p.points.length > 1), [candidates, bestId, from, to, mark]);
  const best = paths.find((p) => p.id === bestId) ?? null;

  // Frame the matched flight (or everything within 15 km), never tighter than 2 km.
  const reach = useMemo(() => {
    const pts = best ? best.points : paths.flatMap((p) => p.points);
    let r = 2000;
    for (const [e, n] of pts) r = Math.max(r, Math.min(15000, Math.hypot(e, n)));
    return best ? Math.min(r, 15000) * 1.1 : 15000;
  }, [paths, best]);

  const rings = [1000, 2000, 5000, 10000].filter((r) => r < reach);
  const sx = (e: number) => e;
  const sy = (n: number) => -n;
  const stroke = reach / 160;

  return (
    <figure className="m-0">
      <div className="overflow-hidden rounded-2xl border border-line bg-deep">
        <svg viewBox={`${-reach} ${-reach} ${reach * 2} ${reach * 2}`} className="block aspect-square w-full" role="img" aria-label={t.map}>
          <defs>
            <clipPath id="plot-clip">
              <rect x={-reach} y={-reach} width={reach * 2} height={reach * 2} />
            </clipPath>
          </defs>
          {rings.map((r) => (
            <g key={r}>
              <circle cx={0} cy={0} r={r} fill="none" stroke="#1c2640" strokeWidth={stroke} />
              <text x={r * 0.71 + stroke * 2} y={-r * 0.71 - stroke * 2} fill="#5b6478" fontSize={reach / 22} fontFamily="var(--font-geist-mono)">
                {r / 1000} km
              </text>
            </g>
          ))}
          <text x={0} y={-reach + reach / 12} textAnchor="middle" fill="#5b6478" fontSize={reach / 20} fontFamily="var(--font-geist-mono)">
            N
          </text>
          <g clipPath="url(#plot-clip)">
            {paths
              .filter((p) => p.id !== bestId)
              .map((p) => (
                <polyline key={p.id} points={p.points.map(([e, n]) => `${sx(e)},${sy(n)}`).join(" ")} fill="none" stroke="#3a4560" strokeWidth={stroke * 1.2} strokeLinecap="round" />
              ))}
            {best && (
              <>
                <polyline points={best.points.map(([e, n]) => `${sx(e)},${sy(n)}`).join(" ")} fill="none" stroke="#ffb547" strokeWidth={stroke * 2.2} strokeLinecap="round" />
                <Arrow points={best.points} size={stroke * 9} />
                {best.mark && <circle cx={sx(best.mark[0])} cy={sy(best.mark[1])} r={stroke * 4} fill="#ffd58f" />}
              </>
            )}
          </g>
          <circle cx={0} cy={0} r={stroke * 4.5} fill="#e9edf5" />
          <text x={stroke * 7} y={stroke * 3} fill="#e9edf5" fontSize={reach / 18}>
            {t.you}
          </text>
        </svg>
      </div>
    </figure>
  );
}

function Arrow({ points, size }: { points: [number, number][]; size: number }) {
  const [e1, n1] = points[points.length - 1];
  const [e0, n0] = points[Math.max(0, points.length - 3)];
  const a = Math.atan2(-(n1 - n0), e1 - e0);
  const tip = [e1, -n1];
  const left = [tip[0] - size * Math.cos(a - 0.45), tip[1] - size * Math.sin(a - 0.45)];
  const right = [tip[0] - size * Math.cos(a + 0.45), tip[1] - size * Math.sin(a + 0.45)];
  return <polygon points={`${tip.join(",")} ${left.join(",")} ${right.join(",")}`} fill="#ffb547" />;
}
