// What the answer draws on the map, as plain data: the same elements as SpotPlot, in degrees. No
// map library here: the page loads none until a result appears, and this is what the tests read.

import { fromLocal } from "../core/geo";
import { metresApart } from "./where";
import type { Guess } from "./where.worker";

export type Spot = { lat: number; lon: number };
export type Bounds = [[west: number, south: number], [east: number, north: number]];

export type OverlayLabels = {
  guess: string;
  mirror: string;
  /** The other answers, the first of them being answer 2. */
  other: (n: number) => string;
  /** The name of a plane by its code, when it has one. */
  plane: (hex: string) => string | undefined;
};

type Geometry = { type: "Point"; coordinates: [number, number] } | { type: "LineString"; coordinates: [number, number][] };
export type OverlayFeature = { type: "Feature"; properties: { kind: "ring" | "ring-label" | "track" | "closest" | "other" | "mirror" | "guess"; label?: string; radius?: number }; geometry: Geometry };
export type Overlay = { type: "FeatureCollection"; features: OverlayFeature[] };

/** The rings SpotPlot draws, and the same rule for which: up to about what was close. */
const RINGS = [1000, 2000, 5000, 10_000, 20_000];
const CIRCLE_STEPS = 96;
const NEAREST_REACH = 2000;
const FARTHEST_REACH = 30_000;
const NORTH_EAST = Math.PI / 4;

/** How far around the guess the rings go: the mirror and the planes' closest points. */
function reachOf(guess: Guess): number {
  let reach = NEAREST_REACH;
  if (guess.mirror) reach = Math.max(reach, metresApart(guess, guess.mirror));
  for (const path of guess.paths) reach = Math.max(reach, Math.hypot(...path.closest));
  return Math.min(reach, FARTHEST_REACH) * 1.25;
}

const lonLat = ({ lat, lon }: Spot): [number, number] => [lon, lat];

export function overlayOf(guess: Guess, others: Spot[], labels: OverlayLabels): Overlay {
  const at = (east: number, north: number) => lonLat(fromLocal({ lat: guess.lat, lon: guess.lon, elevation: 0 }, east, north));
  const features: OverlayFeature[] = [];
  const reach = reachOf(guess);
  for (const radius of RINGS.filter((r) => r < reach)) {
    const coordinates = Array.from({ length: CIRCLE_STEPS + 1 }, (_, i) => {
      const angle = (i / CIRCLE_STEPS) * 2 * Math.PI;
      return at(radius * Math.sin(angle), radius * Math.cos(angle));
    });
    features.push({ type: "Feature", properties: { kind: "ring", radius }, geometry: { type: "LineString", coordinates } });
    features.push({
      type: "Feature",
      properties: { kind: "ring-label", label: `${radius / 1000} km`, radius },
      geometry: { type: "Point", coordinates: at(radius * Math.sin(NORTH_EAST), radius * Math.cos(NORTH_EAST)) },
    });
  }

  for (const path of guess.paths) {
    features.push({ type: "Feature", properties: { kind: "track" }, geometry: { type: "LineString", coordinates: path.points.map(([e, n]) => at(e, n)) } });
    features.push({ type: "Feature", properties: { kind: "closest", label: labels.plane(path.hex) }, geometry: { type: "Point", coordinates: at(path.closest[0], path.closest[1]) } });
  }

  others.forEach((other, i) => {
    features.push({ type: "Feature", properties: { kind: "other", label: labels.other(i + 2) }, geometry: { type: "Point", coordinates: lonLat(other) } });
  });
  if (guess.mirror) features.push({ type: "Feature", properties: { kind: "mirror", label: labels.mirror }, geometry: { type: "Point", coordinates: lonLat(guess.mirror) } });
  features.push({ type: "Feature", properties: { kind: "guess", label: labels.guess }, geometry: { type: "Point", coordinates: lonLat(guess) } });

  return { type: "FeatureCollection", features };
}

/** How far off another answer may be, for the size of the rest, and still share the picture. */
const OTHER_REACH = 0.75;

/** The view that holds the guess, its mirror, the tracks, and the other answers close enough to belong. */
export function boundsOf(guess: Guess, others: Spot[] = []): Bounds {
  let west = guess.lon;
  let east = guess.lon;
  let south = guess.lat;
  let north = guess.lat;
  const take = ({ lat, lon }: Spot) => {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  };
  if (guess.mirror) take(guess.mirror);
  for (const path of guess.paths) for (const [e, n] of path.points) take(fromLocal({ lat: guess.lat, lon: guess.lon, elevation: 0 }, e, n));
  const span = metresApart({ lat: south, lon: west }, { lat: north, lon: east });
  for (const other of others) if (metresApart(guess, other) <= span * OTHER_REACH) take(other);
  return [
    [west, south],
    [east, north],
  ];
}
