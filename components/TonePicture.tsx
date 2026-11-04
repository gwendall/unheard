"use client";

import { useEffect, useRef } from "react";
import type { Picture, Tone } from "@/lib/core/leak";
import { paintTone } from "@/lib/client/where-card";
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
    paintTone(ctx, picture, tone, w, h);
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
