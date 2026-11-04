"use client";

import { useMemo } from "react";
import { useI18n } from "@/components/I18n";
import { mirrorOf, reachOf } from "@/lib/client/where-card";
import type { Guess } from "@/lib/client/where.worker";

/**
 * The answer on a plain plot, north up, in the style of TrackPlot: the spot at the centre, its
 * mirror if there is one, and the path of each plane heard, with a dot at its closest. The rings
 * give the scale; the map itself is one link away (OpenStreetMap), with no map loaded here.
 */
export function SpotPlot({ guess }: { guess: Guess }) {
  const { m } = useI18n();
  const t = m.plots;
  const here = m.where.result;
  const mirror = useMemo(() => mirrorOf(guess), [guess]);
  const reach = useMemo(() => reachOf(guess), [guess]);

  const rings = [1000, 2000, 5000, 10_000, 20_000].filter((r) => r < reach);
  const stroke = reach / 160;

  return (
    <figure className="m-0" data-testid="where-plot">
      <div className="overflow-hidden rounded-2xl border border-line bg-deep">
        <svg viewBox={`${-reach} ${-reach} ${reach * 2} ${reach * 2}`} className="block aspect-square w-full" role="img" aria-label={t.map}>
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
          {guess.paths.map((p) => (
            <g key={p.hex}>
              <polyline points={p.points.map(([e, n]) => `${e},${-n}`).join(" ")} fill="none" stroke="#ffb547" strokeWidth={stroke * 1.6} strokeLinecap="round" />
              <circle cx={p.closest[0]} cy={-p.closest[1]} r={stroke * 3} fill="#ffd58f" />
            </g>
          ))}
          {mirror && (
            <g>
              <circle cx={mirror[0]} cy={-mirror[1]} r={stroke * 4.5} fill="none" stroke="#e9edf5" strokeWidth={stroke} />
              <text x={mirror[0] + stroke * 7} y={-mirror[1] + stroke * 3} fill="#8d97ab" fontSize={reach / 22}>
                {here.mirrorLabel}
              </text>
            </g>
          )}
          <circle cx={0} cy={0} r={stroke * 4.5} fill="#e9edf5" />
          <text x={stroke * 7} y={stroke * 3} fill="#e9edf5" fontSize={reach / 18}>
            {here.here}
          </text>
        </svg>
      </div>
    </figure>
  );
}
