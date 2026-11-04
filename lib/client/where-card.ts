// What a where result's share card paints (lib/client/card.ts): the spot and the planes' paths
// above, one tone's spectrum with its curve below. Drawn in the page, and only on the sharer's click.

import { toLocal } from "../core/geo";
import type { Picture, Tone } from "../core/leak";
import { colorOf } from "./colormap";
import type { Guess, ToneView } from "./where.worker";

/** The mirror, metres east and north of a guess. */
export function mirrorOf(guess: Guess): [number, number] | null {
  if (!guess.mirror) return null;
  const p = toLocal({ lat: guess.lat, lon: guess.lon, elevation: 0 }, guess.mirror.lat, guess.mirror.lon, 0);
  return [p[0], p[1]];
}

/** How far a plot of a guess reaches: the mirror and the closest points, never tighter than 2 km. */
export function reachOf(guess: Guess): number {
  let r = 2000;
  const mirror = mirrorOf(guess);
  if (mirror) r = Math.max(r, Math.hypot(...mirror));
  for (const p of guess.paths) r = Math.max(r, Math.hypot(...p.closest));
  return Math.min(r, 30_000) * 1.25;
}

/** The spectrum around a tone, with its curve as two rails on either side of it. */
export function paintTone(ctx: CanvasRenderingContext2D, picture: Picture, tone: Tone, w: number, h: number) {
  if (!picture.width || !picture.height) return;
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
  ctx.save();
  ctx.strokeStyle = "rgba(255, 181, 71, 0.9)";
  ctx.lineWidth = Math.max(1.5, h / 100);
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
  ctx.restore();
}

/** The spot, its mirror and the planes' paths, centred, in a square of `side` pixels. */
function paintSpot(ctx: CanvasRenderingContext2D, guess: Guess, side: number) {
  const reach = reachOf(guess);
  const scale = side / (2 * reach);
  const at = (east: number, north: number): [number, number] => [(east + reach) * scale, (reach - north) * scale];
  ctx.lineCap = "round";
  ctx.strokeStyle = "#1c2640";
  ctx.lineWidth = 2;
  for (const r of [1000, 2000, 5000, 10_000, 20_000]) {
    if (r >= reach) continue;
    ctx.beginPath();
    ctx.arc(side / 2, side / 2, r * scale, 0, 2 * Math.PI);
    ctx.stroke();
  }
  ctx.lineWidth = 5;
  for (const path of guess.paths) {
    ctx.strokeStyle = "#ffb547";
    ctx.beginPath();
    path.points.forEach(([e, n], i) => {
      const [px, py] = at(e, n);
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.stroke();
    ctx.fillStyle = "#ffd58f";
    ctx.beginPath();
    ctx.arc(...at(...path.closest), 8, 0, 2 * Math.PI);
    ctx.fill();
  }
  const mirror = mirrorOf(guess);
  if (mirror) {
    ctx.strokeStyle = "#e9edf5";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(...at(...mirror), 11, 0, 2 * Math.PI);
    ctx.stroke();
  }
  ctx.fillStyle = "#e9edf5";
  ctx.beginPath();
  ctx.arc(side / 2, side / 2, 12, 0, 2 * Math.PI);
  ctx.fill();
}

/** The card's picture: the spot on the left, one tone's curve on the right. */
export function paintWhere(ctx: CanvasRenderingContext2D, w: number, h: number, guess: Guess, view: ToneView | undefined) {
  ctx.fillStyle = "#0a0f1c";
  ctx.fillRect(0, 0, w, h);
  const side = Math.min(h, view ? w * 0.5 : w);
  ctx.save();
  ctx.translate(view ? 0 : (w - side) / 2, (h - side) / 2);
  paintSpot(ctx, guess, side);
  ctx.restore();
  if (!view) return;
  ctx.save();
  ctx.translate(side, 0);
  paintTone(ctx, view.picture, view.tone, w - side, h);
  ctx.restore();
}
