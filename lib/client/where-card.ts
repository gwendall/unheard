// What a where result's share card paints (lib/client/card.ts): the map as the sharer sees it, or
// the spot and the planes' paths without one, beside one tone's spectrum with its curve. Drawn in
// the page, and only on the sharer's click.

import { toLocal } from "../core/geo";
import type { Picture, Tone } from "../core/leak";
import { colorOf } from "./colormap";
import type { Guess, ToneView } from "./where.worker";

/** How much of the picture's width the map takes when a curve stands beside it. */
const MAP_SHARE = 0.62;

/** The map as it stood: its pixels, and where the spot lies in them, as shares of its width and height. */
export type MapPicture = { picture: HTMLCanvasElement; spot: [number, number] };

/**
 * Where a picture `drawn` long starts in a frame `room` long, the spot as central as the picture
 * allows, so that what a different shape cuts off is never the spot.
 */
export function cropStart(room: number, drawn: number, spot: number): number {
  return Math.min(0, Math.max(room - drawn, room / 2 - spot * drawn));
}

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

/** The map's picture filling `w` x `h`. */
function paintMap(ctx: CanvasRenderingContext2D, { picture, spot }: MapPicture, w: number, h: number) {
  const scale = Math.max(w / picture.width, h / picture.height);
  const [drawnW, drawnH] = [picture.width * scale, picture.height * scale];
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(picture, cropStart(w, drawnW, spot[0]), cropStart(h, drawnH, spot[1]), drawnW, drawnH);
  ctx.restore();
}

/** The card's picture: the map, or the spot without one, on the left; one tone's curve on the right. */
export function paintWhere(ctx: CanvasRenderingContext2D, w: number, h: number, guess: Guess, view: ToneView | undefined, map?: MapPicture | null) {
  ctx.fillStyle = "#0a0f1c";
  ctx.fillRect(0, 0, w, h);
  const side = map ? (view ? w * MAP_SHARE : w) : Math.min(h, view ? w * 0.5 : w);
  if (map) paintMap(ctx, map, side, h);
  else {
    ctx.save();
    ctx.translate(view ? 0 : (w - side) / 2, (h - side) / 2);
    paintSpot(ctx, guess, side);
    ctx.restore();
  }
  if (!view) return;
  ctx.save();
  ctx.translate(side, 0);
  paintTone(ctx, view.picture, view.tone, w - side, h);
  ctx.restore();
}
