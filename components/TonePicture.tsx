"use client";

import { useEffect, useRef } from "react";
import type { Picture, Tone } from "@/lib/core/leak";
import { colorOf } from "@/lib/client/colormap";
import { useI18n } from "@/components/I18n";

/**
 * The evidence map around a tone (lib/core/leak.ts pictureOf), in the colours of the result's
 * spectrum, with the tone's curve as two rails on either side of it: before cleaning the line
 * glows between them, after it the space between them is the recording's own noise.
 */
export function TonePicture({ picture, tone }: { picture: Picture; tone: Tone }) {
  const label = useI18n().m.check.picture;
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx || !picture.width || !picture.height) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const image = new ImageData(picture.width, picture.height);
    for (let i = 0; i < picture.cells.length; i++) {
      const [r, g, b] = colorOf(picture.cells[i] / 255);
      image.data.set([r, g, b, 255], i * 4);
    }
    const off = document.createElement("canvas");
    off.width = picture.width;
    off.height = picture.height;
    off.getContext("2d")!.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(off, 0, 0, w, h);

    const x = (t: number) => ((t - picture.start) / Math.max(1e-6, picture.end - picture.start)) * w;
    const y = (f: number) => h - ((f - picture.lo) / Math.max(1e-6, picture.hi - picture.lo)) * h;
    const gap = Math.max(4, h * 0.05);
    ctx.strokeStyle = "rgba(255, 181, 71, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "rgba(255, 181, 71, 0.5)";
    ctx.shadowBlur = 4;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      tone.times.forEach((t, i) => {
        const px = x(t);
        const py = y(tone.freq[i]) + side * gap;
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      });
      ctx.stroke();
    }
  }, [picture, tone]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-night">
      <canvas ref={canvas} className="block h-32 w-full sm:h-40" aria-label={label} />
      {/* A dark backing: the labels sit on the picture's brightest pixels as often as not. */}
      <div className="pointer-events-none absolute inset-y-1.5 left-1.5 flex flex-col items-start justify-between font-mono text-[10px] text-ink">
        <span className="rounded bg-night/80 px-1 py-px">{Math.round(picture.hi)} Hz</span>
        <span className="rounded bg-night/80 px-1 py-px">{Math.round(picture.lo)} Hz</span>
      </div>
    </div>
  );
}
