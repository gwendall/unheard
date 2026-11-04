// The share card: a 1080 x 1350 picture (4:5, what feeds and chats show whole) of what the phone
// found, drawn on a canvas in the page. The listening card names the aircraft and shows the curve,
// never where or when: no place, no time. The where page's card (lib/client/where-card.ts) says
// both, because that is its answer and the sharer asked for it.

export type Card = {
  lead: string;
  name: string;
  detail: string;
  facts: [string, string][];
  /** Paints the spectrum with the plane's curve into a w x h area. */
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  /** Whose data the picture shows, in small type under it. */
  credit?: string;
};

export const CARD = { width: 1080, height: 1350 };
const PAD = 90;
const INK = "#e9edf5";
const MUTE = "#8b93a7";
const AMBER = "#ffb547";

/** Splits text into lines that fit `width`, at most `max` lines (the last one ends with "..."). */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > max) {
    const kept = lines.slice(0, max);
    kept[max - 1] = `${kept[max - 1]}...`;
    return kept;
  }
  return lines;
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Draws the card and returns it as a PNG. `font` is the page's font family. */
export async function drawCard(card: Card, font: string): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = CARD.width;
  canvas.height = CARD.height;
  const ctx = canvas.getContext("2d")!;
  const w = CARD.width - 2 * PAD;

  const bg = ctx.createLinearGradient(0, 0, 0, CARD.height);
  bg.addColorStop(0, "#0b1020");
  bg.addColorStop(1, "#05070d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CARD.width, CARD.height);

  let y = PAD + 30;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = AMBER;
  ctx.font = `600 30px ${font}`;
  ctx.letterSpacing = "8px";
  ctx.fillText("UNHEARD", PAD, y);
  ctx.letterSpacing = "0px";

  y += 90;
  ctx.fillStyle = MUTE;
  ctx.font = `500 44px ${font}`;
  ctx.fillText(card.lead, PAD, y);

  ctx.fillStyle = INK;
  ctx.font = `600 84px ${font}`;
  for (const line of wrap(ctx, card.name, w, 3)) {
    y += 96;
    ctx.fillText(line, PAD, y);
  }

  if (card.detail) {
    y += 64;
    ctx.fillStyle = MUTE;
    ctx.font = `400 36px ${font}`;
    ctx.fillText(wrap(ctx, card.detail, w, 1)[0], PAD, y);
  }

  // The spectrum with the curve, in a rounded frame.
  const facts = card.facts.slice(0, 3);
  const factsTop = CARD.height - PAD - 70 - 150;
  const top = y + 60;
  const height = Math.max(240, factsTop - top - 60);
  ctx.save();
  rounded(ctx, PAD, top, w, height, 28);
  ctx.clip();
  ctx.translate(PAD, top);
  card.paint(ctx, w, height);
  ctx.restore();
  rounded(ctx, PAD, top, w, height, 28);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 2;
  ctx.stroke();

  if (card.credit) {
    ctx.fillStyle = MUTE;
    ctx.font = `400 24px ${font}`;
    ctx.fillText(wrap(ctx, card.credit, w, 1)[0], PAD, top + height + 38);
  }

  // Three facts in a row.
  const col = w / facts.length;
  facts.forEach(([value, label], i) => {
    const x = PAD + i * col;
    ctx.fillStyle = INK;
    ctx.font = `600 56px ${font}`;
    ctx.fillText(value, x, factsTop + 56);
    ctx.fillStyle = MUTE;
    ctx.font = `400 28px ${font}`;
    wrap(ctx, label, col - 24, 2).forEach((line, j) => ctx.fillText(line, x, factsTop + 104 + j * 36));
  });

  ctx.fillStyle = AMBER;
  ctx.font = `500 32px ${font}`;
  ctx.fillText("unheard.gwendall.com", PAD, CARD.height - PAD + 10);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no image"))), "image/png"));
}
