"use client";

import { addProtocol, Map as MapLibre, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/components/I18n";
import { boundsOf, overlayOf, type OverlayLabels, type Spot } from "@/lib/client/map-overlay";
import { styleOf } from "@/lib/client/map-style";
import type { Guess } from "@/lib/client/where.worker";

// The map itself, in its own chunk (components/PlaceMap.tsx loads it). Its worker comes from our
// own site, its tiles, fonts and sprite from our own bucket, by range requests on one file.

setWorkerUrl(new URL("../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href);
addProtocol("pmtiles", new Protocol().tile);

/** The tiles stop at zoom 15; MapLibre stretches them beyond, up to here. */
const MAX_ZOOM = 18;
/** How close "the spot" is: streets and buildings. */
const SPOT_ZOOM = 15;
/** Tiles failed in a row, none read between them, before the diagram takes over. */
const FAILURES = 3;
/** The first picture, or the diagram. */
const FIRST_PICTURE_MS = 25_000;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Room around the answer: for the guess's label, and on the right for the buttons. */
const paddingOf = (container: HTMLElement) => (container.clientWidth >= 480 ? { top: 56, bottom: 56, left: 72, right: 72 } : { top: 40, bottom: 40, left: 28, right: 68 });

const BUTTON =
  "flex size-11 items-center justify-center bg-panel/90 text-ink backdrop-blur transition hover:bg-line focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-amber sm:size-9";

const NO_LABELS: OverlayLabels = { guess: "", mirror: "", other: () => "", plane: () => undefined };

export default function PlaceMapCanvas({ archive, guess, others, sure, onReady, onFail }: { archive: string; guess: Guess; others: Spot[]; sure: boolean; onReady: () => void; onFail: () => void }) {
  const { m, locale, fill } = useI18n();
  const t = m.placeMap;
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  /** What the map's own events read: the answer of the last render, not of the first. */
  const latest = useRef({ guess, others, onReady, onFail, labels: NO_LABELS });
  const [close, setClose] = useState(false);

  useEffect(() => {
    latest.current = {
      guess,
      others,
      onReady,
      onFail,
      labels: {
        guess: sure ? m.where.result.here : m.where.result.hereGuess,
        mirror: m.where.result.mirrorLabel,
        other: (n) => fill(t.other, { n }),
        plane: (hex) => guess.planes.find((p) => p.hex === hex)?.registration || undefined,
      },
    };
  });

  // One map for the life of this box: only the answer changes on it.
  useEffect(() => {
    const container = box.current;
    if (!container) return;
    const base = new URL(archive, window.location.href).href.replace(/\/$/, "");
    let instance: MapLibre;
    let failures = 0;
    let tilesRead = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      latest.current.onFail();
    };
    const timer = setTimeout(fail, FIRST_PICTURE_MS);

    try {
      instance = new MapLibre({
        container,
        style: styleOf(base, locale),
        bounds: boundsOf(latest.current.guess),
        fitBoundsOptions: { padding: paddingOf(container), maxZoom: SPOT_ZOOM },
        maxZoom: MAX_ZOOM,
        attributionControl: false,
        // A finger scrolls the page and two move the map; Ctrl or Cmd with the wheel zooms.
        cooperativeGestures: true,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        locale: {
          "Map.Title": t.label,
          "CooperativeGesturesHandler.WindowsHelpText": t.gestureWindows,
          "CooperativeGesturesHandler.MacHelpText": t.gestureMac,
          "CooperativeGesturesHandler.MobileHelpText": t.gestureTouch,
        },
      });
    } catch {
      fail();
      return;
    }
    map.current = instance;
    instance.touchZoomRotate.disableRotation();
    instance.keyboard.disableRotation();

    instance.on("error", (event) => {
      const { sourceId, tile } = event as unknown as { sourceId?: string; tile?: unknown };
      if (sourceId !== "protomaps") return;
      // No tile named: the file's own header could not be read, and no tile will be.
      if (!tile || ++failures >= FAILURES) fail();
    });
    instance.on("data", (event) => {
      const { sourceId, tile, dataType } = event as unknown as { sourceId?: string; tile?: unknown; dataType?: string };
      if (dataType === "source" && sourceId === "protomaps" && tile) {
        tilesRead++;
        failures = 0;
      }
    });
    instance.getCanvas().addEventListener("webglcontextlost", fail);
    const figure = container.closest("figure");
    const report = () => {
      figure?.setAttribute("data-zoom", instance.getZoom().toFixed(2));
      const { lng, lat } = instance.getCenter();
      figure?.setAttribute("data-center", `${lat.toFixed(5)},${lng.toFixed(5)}`);
    };
    instance.on("moveend", report);
    instance.once("load", () => {
      const { guess, others, labels } = latest.current;
      (instance.getSource("answer") as GeoJSONSource | undefined)?.setData(overlayOf(guess, others, labels));
      report();
    });
    instance.once("idle", () => {
      if (settled) return;
      if (!tilesRead) return fail();
      settled = true;
      clearTimeout(timer);
      latest.current.onReady();
    });

    return () => {
      settled = true;
      clearTimeout(timer);
      map.current = null;
      instance.remove();
    };
    // The map is made once; the effect below follows the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fit = (instance: MapLibre) => {
    instance.fitBounds(boundsOf(latest.current.guess), { padding: paddingOf(instance.getContainer()), maxZoom: SPOT_ZOOM, animate: !reducedMotion(), duration: 500 });
  };

  // Another answer picked: the same map, new marks, and it moves there.
  const answer = `${guess.lat},${guess.lon},${guess.start},${sure},${others.map((o) => `${o.lat},${o.lon}`).join(";")}`;
  const shown = useRef(answer);
  useEffect(() => {
    const instance = map.current;
    if (shown.current === answer || !instance?.isStyleLoaded()) return;
    shown.current = answer;
    const { guess, others, labels } = latest.current;
    (instance.getSource("answer") as GeoJSONSource | undefined)?.setData(overlayOf(guess, others, labels));
    setClose(false);
    fit(instance);
  }, [answer]);

  const lookCloser = () => {
    const instance = map.current;
    if (!instance) return;
    if (close) fit(instance);
    else instance.easeTo({ center: [guess.lon, guess.lat], zoom: SPOT_ZOOM, duration: reducedMotion() ? 0 : 500 });
    setClose(!close);
  };

  return (
    <>
      {/* The map's own stylesheet makes its element position: relative, so the size comes from a parent. */}
      <div className="absolute inset-0">
        <div ref={box} className="h-full w-full [&_canvas:focus-visible]:outline-2 [&_canvas:focus-visible]:outline-offset-[-2px] [&_canvas:focus-visible]:outline-amber" data-testid="place-map-canvas" />
      </div>
      <div className="absolute top-3 right-3 flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line shadow-lg">
        <button type="button" className={BUTTON} aria-label={t.zoomIn} title={t.zoomIn} onClick={() => map.current?.zoomIn({ duration: reducedMotion() ? 0 : 250 })} data-testid="place-map-in">
          <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
        <button type="button" className={BUTTON} aria-label={t.zoomOut} title={t.zoomOut} onClick={() => map.current?.zoomOut({ duration: reducedMotion() ? 0 : 250 })} data-testid="place-map-out">
          <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <path d="M3 8h10" />
          </svg>
        </button>
        <button type="button" className={BUTTON} aria-label={close ? t.showFlights : t.showSpot} title={close ? t.showFlights : t.showSpot} onClick={lookCloser} data-testid="place-map-spot">
          <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            {close ? <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /> : <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />}
          </svg>
        </button>
      </div>
    </>
  );
}
