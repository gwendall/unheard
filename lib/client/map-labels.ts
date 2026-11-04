// Where the answer's words go, in pixels of the map as it stands. The map's own label placement
// knows nothing of the frame, the buttons or the tracks, so a name could be cut by the edge or lie
// across a line. Here each word gets the first spot beside its mark that is inside the frame and
// clear of everything already there, the guess first. A word with nowhere clean to go is left out,
// except the guess and the mirror, which are part of the answer: they take the spot that crosses the
// fewest lines. No map library here: the page loads none until a result appears, and tests read this.

import type { Overlay, OverlayFeature } from "./map-overlay";

export type Rect = { left: number; top: number; right: number; bottom: number };
export type Point = { x: number; y: number };
export type Segment = [x1: number, y1: number, x2: number, y2: number];
export type Scene = { width: number; height: number; keepOut: Rect[] };
/** What a word weighs: its type size, and its width in pixels for that size. */
export type Measure = (label: string, size: number) => number;

/** A word and where it was put: its box in the frame, and its offset from the mark in ems. */
export type Word = { kind: string; label: string; size: number; at: [lon: number, lat: number]; box: Rect; offset: [number, number] };

/** Type sizes, and the size of each dot, in pixels. */
const SIZES: Record<string, { size: number; dot: number }> = {
  guess: { size: 16, dot: 10 },
  mirror: { size: 13, dot: 8 },
  other: { size: 12, dot: 6 },
  closest: { size: 12, dot: 6 },
  "ring-label": { size: 11, dot: 0 },
};
/** First come, first served: what matters most gets its spot first. */
const ORDER = ["guess", "mirror", "other", "closest", "ring-label"];
const MUST = new Set(["guess", "mirror"]);
/** Clear of the frame's edge, and between a word and whatever is next to it. */
const EDGE = 6;
const AIR = 3;
/** From a dot to its word: further out only when all around it is taken. */
const GAPS = [4, 10, 20];
const LINE_HEIGHT = 1.25;
/** A ring is a help only if it can be told from the marks and fits the picture. */
const RING_MIN = 40;

const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const grown = (r: Rect, by: number): Rect => ({ left: r.left - by, top: r.top - by, right: r.right + by, bottom: r.bottom + by });
const inside = (r: Rect, width: number, height: number) => r.left >= EDGE && r.top >= EDGE && r.right <= width - EDGE && r.bottom <= height - EDGE;

/** Whether a segment touches a box (Liang-Barsky). */
export function crosses([x1, y1, x2, y2]: Segment, r: Rect): boolean {
  let from = 0;
  let to = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  for (const [p, q] of [
    [-dx, x1 - r.left],
    [dx, r.right - x1],
    [-dy, y1 - r.top],
    [dy, r.bottom - y1],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) from = Math.max(from, t);
      else to = Math.min(to, t);
      if (from > to) return false;
    }
  }
  return true;
}

/** The centres to try for a word beside its mark, offsets in pixels: its own side first, toward the middle of the frame. */
function besideMark(width: number, height: number, dot: number, toRight: boolean): [number, number][] {
  const out: [number, number][] = [];
  const near = toRight ? 1 : -1;
  for (const gap of GAPS) {
    const side = dot + gap + width / 2;
    const up = dot + gap + height / 2;
    const slant = dot * 0.7 + gap;
    out.push(
      [near * side, 0],
      [-near * side, 0],
      [0, up],
      [0, -up],
      [near * (slant + width / 2), slant + height / 2],
      [near * (slant + width / 2), -(slant + height / 2)],
      [-near * (slant + width / 2), slant + height / 2],
      [-near * (slant + width / 2), -(slant + height / 2)],
    );
  }
  return out;
}

/** The centres to try for a ring's name, offsets from its point: around the ring, the corners first. */
function alongRing(p: Point, centre: Point): [number, number][] {
  const radius = Math.hypot(p.x - centre.x, p.y - centre.y);
  return [45, 315, 135, 225, 0, 90, 180, 270].map((degrees) => {
    const angle = (degrees * Math.PI) / 180;
    return [centre.x + radius * Math.sin(angle) - p.x, centre.y - radius * Math.cos(angle) - p.y];
  });
}

/** The rings to draw at this zoom: those large enough to read, and the largest within the frame. */
export function ringsToShow(radii: { radius: number; pixels: number }[], width: number, height: number): number[] {
  const reach = Math.hypot(width, height) / 2;
  return radii.filter((r) => r.pixels >= RING_MIN && r.pixels <= reach).map((r) => r.radius);
}

const lonLatOf = (f: OverlayFeature) => f.geometry.coordinates as [number, number];

/**
 * Every word of the answer placed, and which rings to draw. `project` turns a position into pixels of
 * the frame. What cannot be placed is simply not in the list.
 */
export function placeWords(overlay: Overlay, project: (at: [number, number]) => Point, scene: Scene, measure: Measure): { words: Word[]; rings: number[] } {
  const { width, height, keepOut } = scene;
  const guess = overlay.features.find((f) => f.properties.kind === "guess");
  const centre = guess ? project(lonLatOf(guess)) : { x: width / 2, y: height / 2 };

  const lines: Segment[] = [];
  const taken: Rect[] = [...keepOut];
  for (const f of overlay.features) {
    if (f.properties.kind === "track" && f.geometry.type === "LineString") {
      const pixels = f.geometry.coordinates.map((c) => project(c));
      for (let i = 1; i < pixels.length; i++) lines.push([pixels[i - 1].x, pixels[i - 1].y, pixels[i].x, pixels[i].y]);
    }
    const dot = SIZES[f.properties.kind]?.dot;
    if (dot) {
      const p = project(lonLatOf(f));
      taken.push({ left: p.x - dot, top: p.y - dot, right: p.x + dot, bottom: p.y + dot });
    }
  }

  const ringLabels = overlay.features.filter((f) => f.properties.kind === "ring-label");
  const radii = ringLabels.map((f) => {
    const p = project(lonLatOf(f));
    return { radius: f.properties.radius ?? 0, pixels: Math.hypot(p.x - centre.x, p.y - centre.y) };
  });
  const rings = ringsToShow(radii, width, height);

  const words: Word[] = [];
  const marks = overlay.features
    .filter((f) => f.properties.label && SIZES[f.properties.kind])
    .filter((f) => f.properties.kind !== "ring-label" || rings.includes(f.properties.radius ?? 0))
    .sort((a, b) => ORDER.indexOf(a.properties.kind) - ORDER.indexOf(b.properties.kind));
  for (const f of marks) {
    const { kind, label } = f.properties;
    const { size, dot } = SIZES[kind];
    const at = lonLatOf(f);
    const p = project(at);
    if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) continue;
    const w = measure(label!, size);
    const h = size * LINE_HEIGHT;
    const tries = kind === "ring-label" ? alongRing(p, centre) : besideMark(w, h, dot, p.x <= centre.x);

    let best: { box: Rect; dx: number; dy: number; crossings: number } | null = null;
    for (const [dx, dy] of tries) {
      const box = { left: p.x + dx - w / 2, top: p.y + dy - h / 2, right: p.x + dx + w / 2, bottom: p.y + dy + h / 2 };
      if (!inside(box, width, height)) continue;
      const clear = grown(box, AIR);
      if (taken.some((t) => overlaps(clear, t))) continue;
      const crossings = lines.filter((l) => crosses(l, clear)).length;
      if (!best || crossings < best.crossings) best = { box, dx, dy, crossings };
      if (!crossings) break;
    }
    if (!best || (best.crossings > 0 && !MUST.has(kind))) continue;
    taken.push(best.box);
    words.push({ kind, label: label!, size, at, box: best.box, offset: [best.dx / size, best.dy / size] });
  }
  return { words, rings };
}

/** The outlines the map's own names must not touch: the frame, so that none is cut, and what lies over the map. */
export function edgesOf({ width, height, keepOut }: Scene, unproject: (x: number, y: number) => [number, number]): [number, number][][] {
  const outline = ({ left, top, right, bottom }: Rect) =>
    [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
      [left, top],
    ].map(([x, y]) => unproject(x, y));
  return [outline({ left: 0, top: 0, right: width, bottom: height }), ...keepOut.map(outline)];
}

type WordFeature = {
  type: "Feature";
  properties: { kind: string; label: string; offset: [number, number] };
  geometry: { type: "Point"; coordinates: [number, number] } | { type: "LineString"; coordinates: [number, number][] };
};

/** The words as map data, one point each with its offset, and the outlines the map's names keep off. */
export function wordsData(words: Word[], edges: [number, number][][] = []): { type: "FeatureCollection"; features: WordFeature[] } {
  return {
    type: "FeatureCollection",
    features: [
      ...words.map((w): WordFeature => ({ type: "Feature", properties: { kind: w.kind, label: w.label, offset: w.offset }, geometry: { type: "Point", coordinates: w.at } })),
      ...edges.map((coordinates): WordFeature => ({ type: "Feature", properties: { kind: "edge", label: "", offset: [0, 0] }, geometry: { type: "LineString", coordinates } })),
    ],
  };
}
