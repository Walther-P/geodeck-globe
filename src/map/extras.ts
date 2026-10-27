// Map effects that work on every basemap: 3D buildings (from the OpenFreeMap
// tiles' heights) and the live day/night line with twilight bands. Both can
// be switched off in 圖層.

import type { ExpressionSpecification, GeoJSONSource } from "maplibre-gl";
import { nightRing, subsolarPoint, terminatorLat } from "../data/sun";
import { read, write } from "../lib/store";
import type { Basemap, BaseId } from "./basemap";
import type { GlobeMap } from "./globe";

const KEY = "gdg.extras.v1";
export interface ExtrasState {
  buildings: boolean;
  daynight: boolean;
}

// Building colour ramps by height, tuned to each basemap.
const ramp = (stops: Array<[number, string]>): ExpressionSpecification => ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 0], ...stops.flat()] as ExpressionSpecification;
const BUILDINGS: Record<"own" | BaseId, { color: ExpressionSpecification; opacity: number }> = {
  own: { color: ramp([[0, "#1f2f3c"], [30, "#28465a"], [100, "#2f6b7a"], [250, "#3fa3a8"]]), opacity: 0.92 },
  baiyan: { color: ramp([[0, "#1f2f3c"], [30, "#28465a"], [100, "#2f6b7a"], [250, "#3fa3a8"]]), opacity: 0.92 },
  "g-road": { color: ramp([[0, "#e7e9ed"], [100, "#d3d9e0"], [250, "#bcc7d2"]]), opacity: 0.85 },
  "g-terrain": { color: ramp([[0, "#e7e9ed"], [100, "#d3d9e0"], [250, "#bcc7d2"]]), opacity: 0.85 },
  "g-dark": { color: ramp([[0, "#283139"], [100, "#34485a"], [250, "#4a6a80"]]), opacity: 0.9 },
  "g-sat": { color: ramp([[0, "#d5dbe0"], [250, "#eef2f5"]]), opacity: 0.6 },
};
// Each band (sunset, then civil, nautical and astronomical dusk) darkens a little more.
const BANDS = [0, -6, -12, -18];

export class MapExtras {
  private state: ExtrasState = { buildings: true, daynight: true, ...read<Partial<ExtrasState>>(KEY, {}) };
  private timer = 0;

  constructor(
    private map: GlobeMap,
    private basemap: Basemap,
  ) {
    const start = () => {
      this.addLayers();
      this.apply();
    };
    if (map.isStyleLoaded()) start();
    else map.once("load", start);
    basemap.onChange(() => this.paintBuildings());
  }

  get(): ExtrasState {
    return { ...this.state };
  }

  set(change: Partial<ExtrasState>): void {
    this.state = { ...this.state, ...change };
    write(KEY, this.state);
    this.apply();
  }

  /** Below the basemap's labels and every lens layer, above its fills (and Google's tiles). */
  private beforeId(): string | undefined {
    return this.map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  }

  private addLayers(): void {
    const map = this.map;
    const before = this.beforeId();
    if (map.getSource("omt") && !map.getLayer("x-buildings"))
      map.addLayer(
        {
          id: "x-buildings",
          type: "fill-extrusion",
          source: "omt",
          "source-layer": "building",
          minzoom: 14,
          paint: {
            "fill-extrusion-color": BUILDINGS.own.color,
            "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, ["coalesce", ["get", "render_height"], 6]],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
            "fill-extrusion-opacity": BUILDINGS.own.opacity,
          },
        },
        before,
      );
    if (!map.getSource("x-daynight")) map.addSource("x-daynight", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    // Shading fades out as you zoom in: at street level it would only dim the map.
    const fade = (peak: number): ExpressionSpecification => ["interpolate", ["linear"], ["zoom"], 2, peak, 6, peak * 0.5, 8, 0];
    if (!map.getLayer("x-night"))
      map.addLayer({ id: "x-night", type: "fill", source: "x-daynight", maxzoom: 8, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#0b1d4d", "fill-opacity": fade(0.16), "fill-antialias": false } }, before);
    if (!map.getLayer("x-terminator"))
      map.addLayer(
        { id: "x-terminator", type: "line", source: "x-daynight", maxzoom: 8, filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": "#fbbf24", "line-opacity": fade(0.6), "line-width": 1.2 } },
        before,
      );
    if (!map.getLayer("x-sun-glow"))
      map.addLayer({ id: "x-sun-glow", type: "circle", source: "x-daynight", maxzoom: 7, filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 16, "circle-color": "#fde047", "circle-opacity": 0.22, "circle-blur": 0.8 } });
    if (!map.getLayer("x-sun"))
      map.addLayer({
        id: "x-sun",
        type: "circle",
        source: "x-daynight",
        maxzoom: 7,
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 5, "circle-color": "#fde047", "circle-stroke-color": "#fff7ae", "circle-stroke-width": 1.5 },
      });
  }

  private apply(): void {
    const map = this.map;
    const show = (ids: string[], on: boolean) => {
      for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    };
    show(["x-buildings"], this.state.buildings);
    this.paintBuildings();
    show(["x-night", "x-terminator", "x-sun-glow", "x-sun"], this.state.daynight);
    clearInterval(this.timer);
    if (this.state.daynight) {
      this.drawDaynight();
      this.timer = window.setInterval(() => this.drawDaynight(), 60000);
    }
  }

  private paintBuildings(): void {
    if (!this.map.getLayer("x-buildings")) return;
    const base = this.basemap.effective().base;
    const p = BUILDINGS[base] ?? BUILDINGS.own;
    this.map.setPaintProperty("x-buildings", "fill-extrusion-color", p.color);
    this.map.setPaintProperty("x-buildings", "fill-extrusion-opacity", p.opacity);
  }

  private drawDaynight(): void {
    const src = this.map.getSource("x-daynight") as GeoJSONSource | undefined;
    if (!src) return;
    const sun = subsolarPoint(new Date());
    const line: Array<[number, number]> = [];
    for (let lng = -180; lng <= 180; lng += 2) line.push([lng, terminatorLat(sun, lng)]);
    src.setData({
      type: "FeatureCollection",
      features: [
        ...BANDS.map((h): GeoJSON.Feature => ({ type: "Feature", properties: { band: h }, geometry: { type: "Polygon", coordinates: [nightRing(sun, h)] } })),
        { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } },
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [sun.lng, sun.lat] } },
      ],
    });
  }
}
