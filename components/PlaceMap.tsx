"use client";

import { lazy, Suspense, useEffect, useState, useSyncExternalStore, type ComponentType, type RefObject } from "react";
import { Rich, useI18n } from "@/components/I18n";
import { SpotPlot } from "@/components/SpotPlot";
import { ARCHIVE_URL } from "@/lib/archive";
import type { Spot } from "@/lib/client/map-overlay";
import type { MapPicture } from "@/lib/client/where-card";
import type { Guess } from "@/lib/client/where.worker";

// The answer on a real map: a thin shell, so that neither the home nor the search pays for it.
// MapLibre and the tiles load when this first renders, that is when a result appears, from our own
// bucket only. The box keeps its height from the first frame to the last, and SpotPlot, today's
// diagram, takes the same box when there is no WebGL or the tiles cannot be read.

type CanvasProps = { archive: string; guess: Guess; others: Spot[]; sure: boolean; onReady: () => void; onFail: () => void; shotRef?: RefObject<MapShot | null> };

/** The map as it stands, as a picture: null when it does not show the answer. Set once it has drawn. */
export type MapShot = () => Promise<MapPicture | null>;

/** The map's code itself could not be fetched. */
function Unavailable({ onFail }: CanvasProps) {
  useEffect(onFail, [onFail]);
  return null;
}

const Canvas = lazy<ComponentType<CanvasProps>>(() => import("@/components/PlaceMapCanvas").catch(() => ({ default: Unavailable })));

/** Whether this browser draws WebGL, asked once. */
let webglSeen: boolean | null = null;
function webgl(): boolean {
  if (webglSeen === null) {
    try {
      const canvas = document.createElement("canvas");
      webglSeen = !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
    } catch {
      webglSeen = false;
    }
  }
  return webglSeen;
}
const neverChanges = () => () => {};

const NO_OTHERS: Spot[] = [];
const LINK = "underline underline-offset-2 transition hover:text-ink";

export function PlaceMap({
  guess,
  others = NO_OTHERS,
  sure = false,
  className = "h-[22.5rem] sm:h-[33.75rem]",
  archive = ARCHIVE_URL,
  shotRef,
}: {
  guess: Guess;
  others?: Spot[];
  sure?: boolean;
  /** The box's height: it holds from the first frame to the last, the diagram included. */
  className?: string;
  /** Where the map's files are: the flight archive's base, unless a test says otherwise. */
  archive?: string;
  /** Filled with a way to take the map's picture while there is a map to take. */
  shotRef?: RefObject<MapShot | null>;
}) {
  const { m } = useI18n();
  const t = m.placeMap;
  const gl = useSyncExternalStore(neverChanges, webgl, () => null);
  const [progress, setProgress] = useState<"loading" | "ready" | "failed">("loading");
  const state = gl === false || !archive ? "failed" : progress;

  return (
    <figure className="m-0 flex flex-col gap-2" data-testid="place-map" data-state={state}>
      <div className={`relative w-full overflow-hidden rounded-2xl border border-line bg-deep ${className}`}>
        {state === "failed" ? (
          <div className="mx-auto aspect-square h-full max-w-full [&_figure>div]:rounded-none [&_figure>div]:border-0">
            <SpotPlot guess={guess} sure={sure} />
          </div>
        ) : (
          gl && (
            <Suspense fallback={null}>
              <Canvas archive={archive} guess={guess} others={others} sure={sure} onReady={() => setProgress("ready")} onFail={() => setProgress("failed")} shotRef={shotRef} />
            </Suspense>
          )
        )}
        {state === "loading" && (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-faint" aria-live="polite">
            {t.loading}
          </p>
        )}
      </div>
      <figcaption className="text-sm text-pretty text-faint" data-testid="place-map-credit">
        {state === "failed" ? (
          `${t.failed} ${m.where.placesCredit}`
        ) : (
          <Rich
            text={t.credit}
            parts={{
              osm: (
                <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className={LINK}>
                  OpenStreetMap
                </a>
              ),
              protomaps: (
                <a href="https://protomaps.com" target="_blank" rel="noreferrer" className={LINK}>
                  Protomaps
                </a>
              ),
              geonames: (
                <a href="https://www.geonames.org" target="_blank" rel="noreferrer" className={LINK}>
                  GeoNames
                </a>
              ),
              terrain: (
                <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noreferrer" className={LINK}>
                  Terrain Tiles
                </a>
              ),
            }}
          />
        )}
      </figcaption>
    </figure>
  );
}
