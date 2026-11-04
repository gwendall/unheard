// The map's look: Protomaps' layers in the site's own palette, from files in our own bucket and
// nowhere else. The tiles, the fonts and the sprite all come from the base given.

import { layers, namedFlavor, type Flavor } from "@protomaps/basemaps";
import type { ExpressionSpecification, LayerSpecification, StyleSpecification, SymbolLayerSpecification } from "maplibre-gl";

/** One file, a day of OpenStreetMap as Protomaps built it. A new one gets a new name, here. */
export const MAP_FILE = "map/protomaps-20261103.pmtiles";

const NIGHT = "#05070d";
const PANEL = "#0e1526";
const LINE = "#1c2640";
const INK = "#e9edf5";
const MUTE = "#8d97ab";
const FAINT = "#5b6478";
const AMBER = "#ffb547";
const AMBER_SOFT = "#ffd58f";

const LAND = "#0e1526";
const LAND_TINT = "#101829";
const GREEN = "#0f1c26";
const ROAD = "#27324f";
const ROAD_MAJOR = "#364568";
const ROAD_HIGHWAY = "#46577f";
const WATER = NIGHT;
const NAME = "#c3cbdb";
const POI = "#7d889e";

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
  glacier: PANEL,
  sand: LAND_TINT,
  beach: PANEL,
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
  buildings: "#1a2340",
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
  boundaries: "#3a4665",
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
  subplace_label: MUTE,
  subplace_label_halo: NIGHT,
  city_label: NAME,
  city_label_halo: NIGHT,
  state_label: FAINT,
  state_label_halo: NIGHT,
  country_label: MUTE,
  address_label: FAINT,
  address_label_halo: NIGHT,
  pois: { blue: POI, green: POI, lapis: POI, pink: POI, red: POI, slategray: POI, tangerine: POI, turquoise: POI },
  landcover: {
    grassland: GREEN,
    barren: LAND_TINT,
    urban_area: LAND_TINT,
    farmland: LAND_TINT,
    glacier: PANEL,
    scrub: LAND_TINT,
    forest: GREEN,
  },
};

const REGULAR = ["Noto Sans Regular"];
const MEDIUM = ["Noto Sans Medium"];
const CLEAR = "rgba(0,0,0,0)";

const kind = (name: string): ExpressionSpecification => ["==", ["get", "kind"], name];

/** The words beside a mark: its `label`, with a dark edge that keeps them readable over the map. */
const words = (id: string, filter: ExpressionSpecification, font: string[], size: number, color: string, layout: SymbolLayerSpecification["layout"] = {}, halo = 1.5): LayerSpecification => ({
  id,
  type: "symbol",
  source: "answer",
  filter,
  layout: { "text-field": ["get", "label"], "text-font": font, "text-size": size, ...layout },
  paint: { "text-color": color, "text-halo-color": NIGHT, "text-halo-width": halo },
});
/** Beside its dot, on the side of the guess if it is free: the edges and the buttons are the other way. */
const beside = (id: string, filter: ExpressionSpecification, font: string[], size: number, color: string, layout: SymbolLayerSpecification["layout"] = {}): LayerSpecification[] =>
  (["east", "west"] as const).map((side) =>
    words(`${id}-${side}`, ["all", filter, ["==", ["get", "side"], side]], font, size, color, {
      "text-variable-anchor": side === "east" ? ["right", "left", "top", "bottom"] : ["left", "right", "top", "bottom"],
      "text-radial-offset": 1,
      "text-justify": "auto",
      ...layout,
    }),
  );
/** Room around a dot: an invisible letter over it, so that no name prints on a mark. */
const room = (id: string, filter: ExpressionSpecification, size: number): LayerSpecification => ({
  id,
  type: "symbol",
  source: "answer",
  filter,
  layout: { "text-field": "O", "text-font": REGULAR, "text-size": size, "text-allow-overlap": true },
  paint: { "text-opacity": 0 },
});
/** Always shown, and everything else makes room: the answer goes before the map's own names. */
const ALWAYS: SymbolLayerSpecification["layout"] = { "text-anchor": "left", "text-allow-overlap": true };

/** The answer's lines: over the land and the roads, under the names of places. */
const ANSWER_LINES: LayerSpecification[] = [
  { id: "answer-rings", type: "line", source: "answer", filter: kind("ring"), paint: { "line-color": "#62708f", "line-width": 1, "line-dasharray": [2, 3] } },
  { id: "answer-track-casing", type: "line", source: "answer", filter: kind("track"), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": NIGHT, "line-width": 5, "line-opacity": 0.8 } },
  { id: "answer-track", type: "line", source: "answer", filter: kind("track"), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": AMBER, "line-width": 2.5 } },
];

/** The answer's points and words: over everything, the guess last, so that nothing hides it. */
const ANSWER_MARKS: LayerSpecification[] = [
  { id: "answer-other", type: "circle", source: "answer", filter: kind("other"), paint: { "circle-radius": 5, "circle-color": CLEAR, "circle-stroke-color": MUTE, "circle-stroke-width": 1.5 } },
  { id: "answer-closest", type: "circle", source: "answer", filter: kind("closest"), paint: { "circle-radius": 5, "circle-color": AMBER_SOFT, "circle-stroke-color": NIGHT, "circle-stroke-width": 1.5 } },
  { id: "answer-mirror", type: "circle", source: "answer", filter: kind("mirror"), paint: { "circle-radius": 7, "circle-color": CLEAR, "circle-stroke-color": INK, "circle-stroke-width": 2 } },
  { id: "answer-guess-halo", type: "circle", source: "answer", filter: kind("guess"), paint: { "circle-radius": 20, "circle-color": INK, "circle-opacity": 0.16 } },
  { id: "answer-guess", type: "circle", source: "answer", filter: kind("guess"), paint: { "circle-radius": 8, "circle-color": INK, "circle-stroke-color": NIGHT, "circle-stroke-width": 2 } },
  words("answer-ring-labels", kind("ring-label"), REGULAR, 11, MUTE),
  ...beside("answer-closest-labels", ["all", kind("closest"), ["has", "label"]], REGULAR, 12, AMBER_SOFT),
  ...beside("answer-other-labels", kind("other"), REGULAR, 12, MUTE),
  // On a free side if there is one, and shown anyway: part of the answer, where a plane's name is a detail.
  ...beside("answer-mirror-label", kind("mirror"), MEDIUM, 13, INK, { "text-allow-overlap": true }),
  words("answer-guess-label", kind("guess"), MEDIUM, 16, INK, { ...ALWAYS, "text-offset": [1.6, 0] }, 2),
  // Last, so placed first: what the words above and the map's names then keep clear of.
  room("answer-room-dots", ["any", kind("closest"), kind("other"), kind("mirror")], 12),
  room("answer-room-guess", kind("guess"), 20),
];

/** The whole style, the answer's layers included, with its source still empty. */
export function styleOf(base: string, language: string): StyleSpecification {
  // Places of interest by their names alone: the sprite's icons have colours of their own.
  const basemap = (layers("protomaps", FLAVOR, { lang: language }) as LayerSpecification[]).map((layer) =>
    layer.id === "pois" ? { ...layer, layout: { ...layer.layout, "icon-image": "" } } as LayerSpecification : layer,
  );
  const firstName = basemap.findIndex((layer) => layer.type === "symbol");
  return {
    version: 8,
    glyphs: `${base}/map/fonts/{fontstack}/{range}.pbf`,
    sprite: `${base}/map/sprites/v4/dark`,
    sources: {
      protomaps: { type: "vector", url: `pmtiles://${base}/${MAP_FILE}` },
      answer: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [...basemap.slice(0, firstName), ...ANSWER_LINES, ...basemap.slice(firstName), ...ANSWER_MARKS],
  };
}
