"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Ghost } from "@/lib/core/explain";
import type { Analysis } from "@/lib/core/pipeline";
import type { Match } from "@/lib/core/match";
import type { AircraftMeta } from "@/lib/adsb";
import { colorOf } from "@/lib/client/colormap";
import { useI18n } from "@/components/I18n";

type Band = { lo: number; hi: number };

/** The frequency band around the curve heard from `match` and the ghosts' curves, or a wide default without any. */
function bandOf(match: Match<AircraftMeta> | null, ghosts: Ghost[] = []): Band {
  let lo = Infinity;
  let hi = -Infinity;
  const take = (f: number) => {
    if (!Number.isFinite(f)) return;
    lo = Math.min(lo, f);
    hi = Math.max(hi, f);
  };
  if (match) for (const f of match.factor) take(f * match.f0);
  for (const g of ghosts) for (const f of g.curve) take(f);
  if (!Number.isFinite(lo)) return { lo: 40, hi: 300 };
  const pad = Math.max(6, (hi - lo) * 0.35);
  return { lo: Math.max(20, lo - pad), hi: hi + pad };
}

/**
 * The recording's evidence map, zoomed on the band where the aircraft's tone travelled, with the
 * curve the flight data predicts drawn as two rails on either side of it (the line itself stays
 * visible between them).
 */
/**
 * Paints the evidence map, zoomed on `band`, into a w x h area of a 2D context (already scaled),
 * with the predicted curve as two rails when `showCurve` and each ghost's flyby as two dashed
 * rails of its own. Also used by the share card, without ghosts.
 */
export function paintSpectrum(ctx: CanvasRenderingContext2D, w: number, h: number, analysis: Analysis, match: Match<AircraftMeta> | null, showCurve: boolean, ghosts: Ghost[] = []) {
  const { spec, evidence } = analysis;
  const band = bandOf(match, ghosts);
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
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(off, 0, 0, w, h);

  const lo = spec.minHz + b0 * spec.binHz;
  const hi = spec.minHz + b1 * spec.binHz;
  const y = (f: number) => h - ((f - lo) / (hi - lo)) * h;
  const x = (k: number) => ((k + 0.5) / spec.frames) * w;
  const gap = Math.max(4, h * 0.035);
  const rails = (hz: (k: number) => number, color: string, glow: string, dash: number[]) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, h / 190);
    ctx.shadowColor = glow;
    ctx.shadowBlur = 6;
    ctx.setLineDash(dash);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      let open = false;
      for (let k = 0; k < spec.frames; k++) {
        const f = hz(k);
        if (!Number.isFinite(f)) {
          open = false;
          continue;
        }
        const px = x(k);
        const py = y(f) + side * gap;
        if (open) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
        open = true;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
  };
  if (showCurve && match) rails((k) => match.factor[k] * match.f0, "rgba(255, 181, 71, 0.95)", "rgba(255, 181, 71, 0.6)", []);
  for (const g of ghosts) rails((k) => g.curve[k], "rgba(143, 208, 255, 0.95)", "rgba(143, 208, 255, 0.5)", [6, 5]);
}

export function Spectrum({ analysis, match, showCurve, ghosts }: { analysis: Analysis; match: Match<AircraftMeta> | null; showCurve: boolean; ghosts?: Ghost[] }) {
  const label = useI18n().m.plots.spectrum;
  const canvas = useRef<HTMLCanvasElement>(null);
  const band = useMemo(() => bandOf(match, ghosts), [match, ghosts]);
  const { spec } = analysis;
  const duration = spec.times[spec.frames - 1] ?? 0;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintSpectrum(ctx, w, h, analysis, match, showCurve, ghosts);
  }, [analysis, match, showCurve, ghosts]);

  return (
    <figure className="m-0">
      <div className="relative overflow-hidden rounded-2xl border border-line bg-night">
        <canvas ref={canvas} className="block h-56 w-full sm:h-72" aria-label={label} />
        <div className="pointer-events-none absolute inset-y-2 left-3 flex flex-col justify-between font-mono text-[10px] text-mute">
          <span>{Math.round(band.hi)} Hz</span>
          <span>{Math.round(band.lo)} Hz</span>
        </div>
        <div className="pointer-events-none absolute right-3 bottom-2 font-mono text-[10px] text-mute">{Math.round(duration)} s</div>
      </div>
    </figure>
  );
}
