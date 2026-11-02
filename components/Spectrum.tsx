"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Analysis } from "@/lib/core/pipeline";
import type { Match } from "@/lib/core/match";
import type { AircraftMeta } from "@/lib/adsb";
import { colorOf } from "@/lib/client/colormap";

type Band = { lo: number; hi: number };

/** The frequency band around the curve heard from `match`, or a wide default without one. */
function bandOf(match: Match<AircraftMeta> | null): Band {
  if (!match) return { lo: 40, hi: 300 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of match.factor) {
    if (!Number.isFinite(f)) continue;
    lo = Math.min(lo, f * match.f0);
    hi = Math.max(hi, f * match.f0);
  }
  if (!Number.isFinite(lo)) return { lo: 40, hi: 300 };
  const pad = Math.max(6, (hi - lo) * 0.35);
  return { lo: Math.max(20, lo - pad), hi: hi + pad };
}

/**
 * The recording's evidence map, zoomed on the band where the aircraft's tone travelled, with the
 * curve the flight data predicts drawn as two rails on either side of it (the line itself stays
 * visible between them).
 */
export function Spectrum({ analysis, match, showCurve }: { analysis: Analysis; match: Match<AircraftMeta> | null; showCurve: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const band = useMemo(() => bandOf(match), [match]);
  const { spec, evidence } = analysis;
  const duration = spec.times[spec.frames - 1] ?? 0;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const b0 = Math.max(0, Math.floor((band.lo - spec.minHz) / spec.binHz));
    const b1 = Math.min(spec.bins - 1, Math.ceil((band.hi - spec.minHz) / spec.binHz));
    const rows = Math.max(1, b1 - b0 + 1);
    const image = new ImageData(Math.max(1, spec.frames), rows);
    for (let k = 0; k < spec.frames; k++) {
      for (let r = 0; r < rows; r++) {
        const v = evidence[k * spec.bins + b0 + r];
        const [red, green, blue] = colorOf((v + 0.5) / 5);
        const o = ((rows - 1 - r) * spec.frames + k) * 4;
        image.data[o] = red;
        image.data[o + 1] = green;
        image.data[o + 2] = blue;
        image.data[o + 3] = 255;
      }
    }
    const off = document.createElement("canvas");
    off.width = image.width;
    off.height = image.height;
    off.getContext("2d")!.putImageData(image, 0, 0);

    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(off, 0, 0, w, h);

    if (showCurve && match) {
      const lo = spec.minHz + b0 * spec.binHz;
      const hi = spec.minHz + b1 * spec.binHz;
      const y = (f: number) => h - ((f - lo) / (hi - lo)) * h;
      const x = (k: number) => ((k + 0.5) / spec.frames) * w;
      const gap = Math.max(4, h * 0.035);
      ctx.strokeStyle = "rgba(255, 181, 71, 0.95)";
      ctx.lineWidth = 1.5;
      ctx.shadowColor = "rgba(255, 181, 71, 0.6)";
      ctx.shadowBlur = 6;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        let open = false;
        for (let k = 0; k < spec.frames; k++) {
          const f = match.factor[k];
          if (!Number.isFinite(f)) {
            open = false;
            continue;
          }
          const px = x(k);
          const py = y(f * match.f0) + side * gap;
          if (open) ctx.lineTo(px, py);
          else ctx.moveTo(px, py);
          open = true;
        }
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }
  }, [spec, evidence, band, match, showCurve]);

  return (
    <figure className="m-0">
      <div className="relative overflow-hidden rounded-2xl border border-line bg-night">
        <canvas ref={canvas} className="block h-56 w-full sm:h-72" aria-label="Spectrum of the recording around the aircraft's tone" />
        <div className="pointer-events-none absolute inset-y-2 left-3 flex flex-col justify-between font-mono text-[10px] text-mute">
          <span>{Math.round(band.hi)} Hz</span>
          <span>{Math.round(band.lo)} Hz</span>
        </div>
        <div className="pointer-events-none absolute right-3 bottom-2 font-mono text-[10px] text-mute">{Math.round(duration)} s</div>
      </div>
    </figure>
  );
}
