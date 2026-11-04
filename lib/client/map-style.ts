// The map's look: Protomaps' layers in the site's own palette, from files in our own bucket and
// nowhere else. The tiles, the fonts and the sprite all come from the base given.

import { layers, namedFlavor, type Flavor } from "@protomaps/basemaps";
import type { ExpressionSpecification, FilterSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";

/** One file, a day of OpenStreetMap as Protomaps built it. A new one gets a new name, here. */
export const MAP_FILE = "map/protomaps-20261103.pmtiles";

const NIGHT = "#05070d";
const LINE = "#1c2640";
const INK = "#e9edf5";
const MUTE = "#8d97ab";
const FAINT = "#5b6478";
const AMBER = "#ffb547";
const AMBER_SOFT = "#ffd58f";

const LAND = "#1a2438";
const LAND_TINT = "#1d283e";
const GREEN = "#1a2b35";
const ROAD = "#33415f";
const ROAD_MAJOR = "#4a5b80";
const ROAD_HIGHWAY = "#6478a3";
const WATER = NIGHT;
/** The edge between land and water. */
const COAST = "#4d6088";
const NAME = "#dfe5f0";
const POI = "#8f9ab0";

/** Dark, blue and quiet, so that the answer is the only thing in colour. */
export const FLAVOR: Flavor = {
  ...namedFlavor("dark"),
  background: LAND,
  earth: LAND,
  park_a: GREEN,
  park_b: GREEN,
  hospital: LAND_TINT,
  industrial: LAND_TINT,
  school: LAND_TINT,
  wood_a: GREEN,
  wood_b: GREEN,
  pedestrian: LAND_TINT,
  scrub_a: LAND_TINT,
  scrub_b: LAND_TINT,
  glacier: LAND_TINT,
  sand: LAND_TINT,
  beach: LAND_TINT,
  aerodrome: LAND_TINT,
  runway: ROAD,
  water: WATER,
  zoo: LAND_TINT,
  military: LAND_TINT,
  tunnel_other_casing: LAND,
  tunnel_minor_casing: LAND,
  tunnel_link_casing: LAND,
  tunnel_major_casing: LAND,
  tunnel_highway_casing: LAND,
  tunnel_other: LINE,
  tunnel_minor: LINE,
  tunnel_link: LINE,
  tunnel_major: LINE,
  tunnel_highway: LINE,
  pier: LINE,
  buildings: "#293550",
  minor_service_casing: LAND,
  minor_casing: LAND,
  link_casing: LAND,
  major_casing_late: LAND,
  highway_casing_late: LAND,
  other: LINE,
  minor_service: LINE,
  minor_a: ROAD,
  minor_b: ROAD,
  link: ROAD_MAJOR,
  major_casing_early: LAND,
  major: ROAD_MAJOR,
  highway_casing_early: LAND,
  highway: ROAD_HIGHWAY,
  railway: LINE,
  boundaries: "#39445f",
  bridges_other_casing: LAND,
  bridges_minor_casing: LAND,
  bridges_link_casing: LAND,
  bridges_major_casing: LAND,
  bridges_highway_casing: LAND,
  bridges_other: LINE,
  bridges_minor: ROAD,
  bridges_link: ROAD_MAJOR,
  bridges_major: ROAD_MAJOR,
  bridges_highway: ROAD_HIGHWAY,
  roads_label_minor: MUTE,
  roads_label_minor_halo: NIGHT,
  roads_label_major: MUTE,
  roads_label_major_halo: NIGHT,
  ocean_label: FAINT,
  subplace_label: "#aab3c5",
  subplace_label_halo: NIGHT,
  city_label: NAME,
  city_label_halo: NIGHT,
  state_label: MUTE,
  state_label_halo: NIGHT,
  country_label: "#aab3c5",
  address_label: FAINT,
  address_label_halo: NIGHT,
  pois: { blue: POI, green: POI, lapis: POI, pink: POI, red: POI, slategray: POI, tangerine: POI, turquoise: POI },
  landcover: {
    grassland: GREEN,
    barren: LAND_TINT,
    urban_area: LAND_TINT,
    farmland: LAND_TINT,
    glacier: LAND_TINT,
    scrub: LAND_TINT,
    forest: GREEN,
  },
};

const REGULAR = ["Noto Sans Regular"];
const MEDIUM = ["Noto Sans Medium"];
const CLEAR = "rgba(0,0,0,0)";

const kind = (name: string): ExpressionSpecification => ["==", ["get", "kind"], name];

/** The answer's words: placed by lib/client/map-labels.ts, one offset each, shown as placed. The map's own names keep clear of them. */
const words = (id: string, name: string, font: string[], size: number, color: string, halo = 1.5): LayerSpecification => ({
  id,
  type: "symbol",
  source: "answer-words",
  filter: kind(name),
  layout: {
    "text-field": ["get", "label"],
    "text-font": font,
    "text-size": size,
    "text-anchor": "center",
    "text-offset": ["array", "number", 2, ["get", "offset"]],
    "text-allow-overlap": true,
  },
  paint: { "text-color": color, "text-halo-color": NIGHT, "text-halo-width": halo },
});
/** Room held by invisible letters, over a dot or along a track, so that the map's own names keep off it. */
const room = (id: string, filter: ExpressionSpecification, size: number, layout: Record<string, unknown> = {}, source = "answer"): LayerSpecification =>
  ({
    id,
    type: "symbol",
    source,
    filter,
    layout: { "text-field": "O", "text-font": REGULAR, "text-size": size, "text-allow-overlap": true, ...layout },
    paint: { "text-opacity": 0 },
  }) as LayerSpecification;

/** Which rings to draw: lib/client/map-labels.ts says, for the zoom of the moment. */
export const ringsFilter = (radii: number[]): FilterSpecification => ["all", kind("ring"), ["in", ["get", "radius"], ["literal", radii]]];

/** The answer's lines: over the land and the roads, under the names of places. */
const ANSWER_LINES: LayerSpecification[] = [
  { id: "answer-rings", type: "line", source: "answer", filter: ringsFilter([]), paint: { "line-color": "#d5dded", "line-opacity": 0.55, "line-width": 1, "line-dasharray": [2, 4] } },
  { id: "answer-track-casing", type: "line", source: "answer", filter: kind("track"), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": NIGHT, "line-width": 5, "line-opacity": 0.8 } },
  { id: "answer-track", type: "line", source: "answer", filter: kind("track"), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": AMBER, "line-width": 2.5 } },
];

const ALONG = { "symbol-placement": "line", "symbol-spacing": 24, "text-max-angle": 180, "text-keep-upright": false };

/** The answer's points and words: over everything, the guess last, so that nothing hides it. */
const ANSWER_MARKS: LayerSpecification[] = [
  { id: "answer-other", type: "circle", source: "answer", filter: kind("other"), paint: { "circle-radius": 5, "circle-color": CLEAR, "circle-stroke-color": MUTE, "circle-stroke-width": 1.5 } },
  { id: "answer-closest", type: "circle", source: "answer", filter: kind("closest"), paint: { "circle-radius": 5, "circle-color": AMBER_SOFT, "circle-stroke-color": NIGHT, "circle-stroke-width": 1.5 } },
  { id: "answer-mirror", type: "circle", source: "answer", filter: kind("mirror"), paint: { "circle-radius": 7, "circle-color": CLEAR, "circle-stroke-color": INK, "circle-stroke-width": 2 } },
  { id: "answer-guess-halo", type: "circle", source: "answer", filter: kind("guess"), paint: { "circle-radius": 20, "circle-color": INK, "circle-opacity": 0.16 } },
  { id: "answer-guess", type: "circle", source: "answer", filter: kind("guess"), paint: { "circle-radius": 8, "circle-color": INK, "circle-stroke-color": NIGHT, "circle-stroke-width": 2 } },
  words("answer-ring-labels", "ring-label", REGULAR, 11, "#c3cbdb"),
  words("answer-closest-labels", "closest", MEDIUM, 12, AMBER_SOFT),
  words("answer-other-labels", "other", REGULAR, 12, "#c3cbdb"),
  words("answer-mirror-label", "mirror", MEDIUM, 13, INK),
  words("answer-guess-label", "guess", MEDIUM, 16, INK, 2),
  // Last, so placed first: what the map's names then keep clear of.
  room("answer-room-tracks", kind("track"), 10, ALONG),
  room("answer-room-edges", kind("edge"), 10, ALONG, "answer-words"),
  room("answer-room-dots", ["any", kind("closest"), kind("other"), kind("mirror")], 12),
  room("answer-room-guess", kind("guess"), 20),
];

/** A zoom expression's sizes, all scaled by the same amount: an expression on zoom cannot be wrapped in a sum. */
export function scaled(value: unknown, by: number): unknown {
  if (typeof value === "number") return Math.round(value * by * 10) / 10;
  if (!Array.isArray(value)) return value;
  if (value[0] === "interpolate") return value.map((part, i) => (i >= 3 && (i - 3) % 2 === 1 ? scaled(part, by) : part));
  if (value[0] === "case") return value.map((part, i) => (i > 0 && (i % 2 === 0 || i === value.length - 1) ? scaled(part, by) : part));
  return value;
}

/** Larger than Protomaps draws them: this map is looked at small, and these say where it is. */
const NAME_SCALE: Record<string, number> = { places_locality: 1.3, places_subplace: 1.1, places_region: 1.1 };

/** The edge of the land, on water's own shapes: rivers are lines, and have none. */
const COASTLINE: LayerSpecification = {
  id: "coastline",
  type: "line",
  source: "protomaps",
  "source-layer": "water",
  filter: ["==", "$type", "Polygon"],
  paint: { "line-color": COAST, "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.5, 9, 1, 15, 1.5] },
};

function basemapLayers(language: string): LayerSpecification[] {
  const out: LayerSpecification[] = [];
  for (const layer of layers("protomaps", FLAVOR, { lang: language }) as LayerSpecification[]) {
    if (layer.id === "pois") {
      // Places of interest by their names alone: the sprite's icons have colours of their own.
      out.push({ ...layer, layout: { ...layer.layout, "icon-image": "" } } as LayerSpecification);
    } else if (NAME_SCALE[layer.id] && layer.type === "symbol") {
      out.push({ ...layer, layout: { ...layer.layout, "text-size": scaled(layer.layout?.["text-size"], NAME_SCALE[layer.id]) } } as LayerSpecification);
    } else {
      out.push(layer);
    }
    if (layer.id === "water") out.push(COASTLINE);
  }
  return out;
}

/** The whole style, the answer's layers included, with its source still empty. */
export function styleOf(base: string, language: string): StyleSpecification {
  const basemap = basemapLayers(language);
  const firstName = basemap.findIndex((layer) => layer.type === "symbol");
  return {
    version: 8,
    glyphs: `${base}/map/fonts/{fontstack}/{range}.pbf`,
    sprite: `${base}/map/sprites/v4/dark`,
    sources: {
      protomaps: { type: "vector", url: `pmtiles://${base}/${MAP_FILE}` },
      answer: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      "answer-words": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [...basemap.slice(0, firstName), ...ANSWER_LINES, ...basemap.slice(firstName), ...ANSWER_MARKS],
  };
}
