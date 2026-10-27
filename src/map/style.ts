// Dark "tactical" basemap on OpenFreeMap's free OpenMapTiles vector tiles.
// Natural Earth land (bundled) keeps the globe readable if tiles are offline.

import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";

export const PALETTE = {
  ocean: "#04080d",
  land: "#0c1319",
  landLow: "#0e161d",
  wood: "#0d1814",
  grass: "#0e1814",
  sand: "#14150f",
  ice: "#141c22",
  residential: "#0f161c",
  industrial: "#11151b",
  water: "#061019",
  waterway: "#0a1b29",
  minor: "#1b252e",
  secondary: "#25313c",
  primary: "#2f3c48",
  motorway: "#4a4331",
  rail: "#2a3038",
  border: "#3c5262",
  admin: "#22313c",
  label: "#a7b6c3",
  labelDim: "#73828f",
  halo: "#04080d",
  grid: "rgba(94, 234, 212, 0.09)",
  accent: "#5eead4",
};

const NAME: ExpressionSpecification = ["coalesce", ["get", "name:zh-Hant"], ["get", "name:zh"], ["get", "name"]];
const FONT = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];

function graticule(): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let lng = -180; lng <= 180; lng += 15) {
    const line: [number, number][] = [];
    for (let lat = -80; lat <= 80; lat += 4) line.push([lng, lat]);
    features.push({ type: "Feature", properties: { equator: false }, geometry: { type: "LineString", coordinates: line } });
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const line: [number, number][] = [];
    for (let lng = -180; lng <= 180; lng += 4) line.push([lng, lat]);
    features.push({ type: "Feature", properties: { equator: lat === 0 }, geometry: { type: "LineString", coordinates: line } });
  }
  return { type: "FeatureCollection", features };
}

const road = (id: string, classes: string[], color: string, widths: [number, number][], minzoom = 5): LayerSpecification => ({
  id,
  type: "line",
  source: "omt",
  "source-layer": "transportation",
  minzoom,
  filter: ["all", ["in", ["get", "class"], ["literal", classes]], ["!=", ["get", "brunnel"], "tunnel"]],
  layout: { "line-cap": "round", "line-join": "round" },
  paint: {
    "line-color": color,
    "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], ...widths.flat()] as unknown as ExpressionSpecification,
  },
});

export function tacticalStyle(base = "./"): StyleSpecification {
  return {
    version: 8,
    name: "Baiyan Tactical Dark",
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    projection: { type: "globe" },
    sky: {
      "sky-color": "#000000",
      "horizon-color": "#0b2a33",
      "fog-color": "#04080d",
      "sky-horizon-blend": 0.6,
      "horizon-fog-blend": 0.6,
      "fog-ground-blend": 0.8,
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0],
    },
    sources: {
      omt: {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
        attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> 資料 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
      land: { type: "geojson", data: `${base}data/land-110m.json`, maxzoom: 5, attribution: "Natural Earth" },
      grid: { type: "geojson", data: graticule(), maxzoom: 4 },
    },
    layers: [
      {
        id: "background",
        type: "background",
        // Ocean-coloured while only the coarse land layer is shown; vector
        // tiles draw water polygons over land-coloured ground from z4 on.
        paint: { "background-color": ["step", ["zoom"], PALETTE.ocean, 4, PALETTE.land] },
      },
      { id: "land-fallback", type: "fill", source: "land", maxzoom: 4, paint: { "fill-color": PALETTE.landLow } },
      {
        id: "landcover",
        type: "fill",
        source: "omt",
        "source-layer": "landcover",
        paint: {
          "fill-color": ["match", ["get", "class"], "wood", PALETTE.wood, "grass", PALETTE.grass, "sand", PALETTE.sand, "ice", PALETTE.ice, PALETTE.grass],
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0.5, 10, 1],
        },
      },
      {
        id: "landuse",
        type: "fill",
        source: "omt",
        "source-layer": "landuse",
        minzoom: 8,
        paint: {
          "fill-color": ["match", ["get", "class"], ["industrial", "commercial", "railway"], PALETTE.industrial, PALETTE.residential],
          "fill-opacity": 0.8,
        },
      },
      { id: "park", type: "fill", source: "omt", "source-layer": "park", minzoom: 8, paint: { "fill-color": PALETTE.wood, "fill-opacity": 0.7 } },
      { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": PALETTE.water } },
      {
        id: "waterway",
        type: "line",
        source: "omt",
        "source-layer": "waterway",
        minzoom: 8,
        paint: { "line-color": PALETTE.waterway, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 14, 2] },
      },
      { id: "grid", type: "line", source: "grid", maxzoom: 4, paint: { "line-color": PALETTE.grid, "line-width": ["case", ["get", "equator"], 1.2, 0.6] } },
      {
        id: "aeroway",
        type: "line",
        source: "omt",
        "source-layer": "aeroway",
        minzoom: 10,
        filter: ["==", ["get", "class"], "runway"],
        paint: { "line-color": "#2a3540", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 15, 18] },
      },
      road("road-minor", ["minor", "service", "track"], PALETTE.minor, [[12, 0.4], [18, 10]], 12),
      road("road-secondary", ["secondary", "tertiary"], PALETTE.secondary, [[8, 0.4], [18, 14]], 8),
      road("road-primary", ["primary", "trunk"], PALETTE.primary, [[6, 0.5], [18, 18]], 6),
      road("road-motorway", ["motorway"], PALETTE.motorway, [[5, 0.6], [18, 22]], 5),
      {
        id: "rail",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 10,
        filter: ["==", ["get", "class"], "rail"],
        paint: { "line-color": PALETTE.rail, "line-width": 1, "line-dasharray": [3, 2] },
      },
      {
        id: "boundary-admin",
        type: "line",
        source: "omt",
        "source-layer": "boundary",
        minzoom: 6,
        filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
        paint: { "line-color": PALETTE.admin, "line-width": 0.8, "line-dasharray": [2, 2] },
      },
      {
        id: "boundary-country",
        type: "line",
        source: "omt",
        "source-layer": "boundary",
        filter: ["all", ["<=", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
        paint: { "line-color": PALETTE.border, "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.5, 8, 1.4] },
      },
      {
        id: "road-label",
        type: "symbol",
        source: "omt",
        "source-layer": "transportation_name",
        minzoom: 13,
        layout: { "symbol-placement": "line", "text-field": NAME, "text-font": FONT, "text-size": 11 },
        paint: { "text-color": PALETTE.labelDim, "text-halo-color": PALETTE.halo, "text-halo-width": 1.4 },
      },
      {
        id: "water-label",
        type: "symbol",
        source: "omt",
        "source-layer": "water_name",
        layout: { "text-field": NAME, "text-font": FONT, "text-size": 11 },
        paint: { "text-color": "#3f6a86", "text-halo-color": PALETTE.halo, "text-halo-width": 1 },
      },
      {
        id: "place-minor",
        type: "symbol",
        source: "omt",
        "source-layer": "place",
        minzoom: 11,
        filter: ["in", ["get", "class"], ["literal", ["suburb", "quarter", "neighbourhood", "village", "hamlet"]]],
        layout: { "text-field": NAME, "text-font": FONT, "text-size": 11 },
        paint: { "text-color": PALETTE.labelDim, "text-halo-color": PALETTE.halo, "text-halo-width": 1.4 },
      },
      {
        id: "place-town",
        type: "symbol",
        source: "omt",
        "source-layer": "place",
        minzoom: 7,
        filter: ["in", ["get", "class"], ["literal", ["town", "city"]]],
        layout: {
          "text-field": NAME,
          "text-font": FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 7, 11, 14, 16],
        },
        paint: { "text-color": PALETTE.label, "text-halo-color": PALETTE.halo, "text-halo-width": 1.6 },
      },
      {
        id: "place-country",
        type: "symbol",
        source: "omt",
        "source-layer": "place",
        maxzoom: 7,
        filter: ["in", ["get", "class"], ["literal", ["country", "state"]]],
        layout: {
          "text-field": NAME,
          "text-font": FONT_BOLD,
          "text-size": ["interpolate", ["linear"], ["zoom"], 1, 10, 6, 14],
          "text-letter-spacing": 0.15,
        },
        paint: { "text-color": PALETTE.labelDim, "text-halo-color": PALETTE.halo, "text-halo-width": 1.4 },
      },
    ],
  };
}
