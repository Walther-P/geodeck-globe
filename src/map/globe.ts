import { AttributionControl, Map as MapLibre, setWorkerUrl, type GeoJSONSource, type LayerSpecification, type StyleImageMetadata } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import { read, write } from "../lib/store";
import { PALETTE, tacticalStyle } from "./style";

setWorkerUrl(workerUrl);

export type GlobeMap = MapLibre;

interface SavedView {
  lng: number;
  lat: number;
  zoom: number;
  bearing?: number;
  pitch?: number;
}

const VIEW = "gdg.view.v1";
// Taiwan, seen from far enough out to read as a planet.
const SPACE = { center: [121, 23.6] as [number, number], zoom: 1.35 };
const HOME: SavedView = { lng: 120.9, lat: 23.6, zoom: 6.6 };

export function createGlobe(container: HTMLElement, onTilesFailed: () => void): GlobeMap {
  const saved = read<SavedView | null>(VIEW, null);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const map = new MapLibre({
    container,
    style: tacticalStyle(),
    center: reduced && saved ? [saved.lng, saved.lat] : SPACE.center,
    zoom: reduced && saved ? saved.zoom : SPACE.zoom,
    bearing: reduced && saved ? (saved.bearing ?? 0) : 0,
    pitch: reduced && saved ? (saved.pitch ?? 0) : 0,
    maxPitch: 70,
    attributionControl: false,
    localIdeographFontFamily: '"PingFang TC", "Noto Sans TC", "Microsoft JhengHei", "Heiti TC", sans-serif',
    fadeDuration: 150,
    // Stops iOS from treating a two-finger pan as page zoom.
    cooperativeGestures: false,
    canvasContextAttributes: { antialias: true },
  });
  map.addControl(new AttributionControl({ compact: true }), "top-right");
  map.touchZoomRotate.enableRotation();
  map.keyboard.enable();

  let failures = 0;
  let tilesSeen = false;
  let warned = false;
  map.on("sourcedata", (e) => {
    if (e.sourceId === "omt" && e.tile) tilesSeen = true;
  });
  map.on("error", (e) => {
    const err = e as unknown as { sourceId?: string; error?: { url?: string } };
    const fromBasemap = err.sourceId === "omt" || /openfreemap/.test(err.error?.url ?? "");
    if (!fromBasemap || warned) return;
    // TileJSON failing (no tile ever loaded) means the service is down for us;
    // once tiles have loaded, only repeated failures count.
    if (!tilesSeen || ++failures >= 3) {
      warned = true;
      // Vector tiles carry water, not land: without them draw the bundled
      // coastline at every zoom on an ocean background.
      map.setPaintProperty("background", "background-color", PALETTE.ocean);
      map.setLayerZoomRange("land-fallback", 0, 24);
      onTilesFailed();
    }
  });

  map.once("load", () => {
    if (reduced) return;
    const to = saved ?? HOME;
    // Arrive from orbit: a slow spin-in to where the user last looked.
    setTimeout(() => map.flyTo({ center: [to.lng, to.lat], zoom: to.zoom, bearing: to.bearing ?? 0, pitch: to.pitch ?? 0, duration: 3200, curve: 1.6, essential: true }), 350);
  });
  let saveTimer = 0;
  map.on("moveend", () => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const c = map.getCenter();
      if (map.getZoom() > 2) write(VIEW, { lng: c.lng, lat: c.lat, zoom: map.getZoom() });
    }, 800);
  });
  return map;
}

// ---- Overlay helpers -----------------------------------------------------

export function setData(map: GlobeMap, id: string, data: GeoJSON.FeatureCollection, cluster?: { radius: number; maxZoom: number }): void {
  const source = map.getSource(id) as GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    return;
  }
  map.addSource(id, cluster ? { type: "geojson", data, cluster: true, clusterRadius: cluster.radius, clusterMaxZoom: cluster.maxZoom } : { type: "geojson", data });
}

export function addLayers(map: GlobeMap, layers: LayerSpecification[], before?: string): void {
  for (const layer of layers) {
    if (map.getLayer(layer.id)) {
      map.setLayoutProperty(layer.id, "visibility", "visible");
      continue;
    }
    map.addLayer(layer, before && map.getLayer(before) ? before : undefined);
  }
}

export function hideLayers(map: GlobeMap, ids: string[]): void {
  for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
}

export const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export function points<T extends { lat: number; lng: number }>(rows: T[], props: (r: T) => Record<string, unknown>): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: rows.map((r) => ({ type: "Feature", properties: props(r), geometry: { type: "Point", coordinates: [r.lng, r.lat] } })),
  };
}

// ---- Icons drawn at runtime (no sprite sheet to host) ----------------------

type Draw = (g: CanvasRenderingContext2D, s: number) => void;

const ICONS: Record<string, { size: number; draw: Draw }> = {
  plane: {
    size: 32,
    draw: (g, s) => {
      g.fillStyle = "#fbbf24";
      g.strokeStyle = "#140d00";
      g.lineWidth = 1.5;
      g.beginPath();
      const c = s / 2;
      g.moveTo(c, 2);
      g.lineTo(c + 2.6, c - 3);
      g.lineTo(s - 3, c + 3);
      g.lineTo(s - 3, c + 6);
      g.lineTo(c + 2.6, c + 3);
      g.lineTo(c + 2, s - 7);
      g.lineTo(c + 6, s - 3.5);
      g.lineTo(c + 6, s - 1.5);
      g.lineTo(c, s - 3.5);
      g.lineTo(c - 6, s - 1.5);
      g.lineTo(c - 6, s - 3.5);
      g.lineTo(c - 2, s - 7);
      g.lineTo(c - 2.6, c + 3);
      g.lineTo(3, c + 6);
      g.lineTo(3, c + 3);
      g.lineTo(c - 2.6, c - 3);
      g.closePath();
      g.fill();
      g.stroke();
    },
  },
  arrow: {
    size: 24,
    draw: (g, s) => {
      g.fillStyle = "#34d399";
      g.strokeStyle = "#03140d";
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(s / 2, 2);
      g.lineTo(s - 4, s - 3);
      g.lineTo(s / 2, s - 8);
      g.lineTo(4, s - 3);
      g.closePath();
      g.fill();
      g.stroke();
    },
  },
  sat: {
    size: 26,
    draw: (g, s) => {
      const c = s / 2;
      g.strokeStyle = "#5eead4";
      g.fillStyle = "#5eead4";
      g.lineWidth = 1.6;
      g.fillRect(c - 3, c - 3, 6, 6);
      g.strokeRect(2, c - 4, 7, 8);
      g.strokeRect(s - 9, c - 4, 7, 8);
      g.beginPath();
      g.moveTo(9, c);
      g.lineTo(c - 3, c);
      g.moveTo(c + 3, c);
      g.lineTo(s - 9, c);
      g.stroke();
    },
  },
  camera: {
    size: 26,
    draw: (g, s) => {
      g.fillStyle = "#0b1a26";
      g.strokeStyle = "#7dd3fc";
      g.lineWidth = 1.8;
      g.beginPath();
      g.roundRect(3, 7, s - 10, s - 14, 3);
      g.fill();
      g.stroke();
      g.beginPath();
      g.moveTo(s - 7, s / 2 - 3);
      g.lineTo(s - 2, s / 2 - 6);
      g.lineTo(s - 2, s / 2 + 6);
      g.lineTo(s - 7, s / 2 + 3);
      g.closePath();
      g.stroke();
    },
  },
  "p-lot": {
    size: 24,
    draw: (g, s) => {
      g.fillStyle = "#1d4ed8";
      g.strokeStyle = "#e2e8f0";
      g.lineWidth = 1.5;
      g.beginPath();
      g.roundRect(1.5, 1.5, s - 3, s - 3, 5);
      g.fill();
      g.stroke();
      g.fillStyle = "#ffffff";
      g.font = `bold ${s * 0.62}px system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("P", s / 2, s / 2 + 1);
    },
  },
  rocket: {
    size: 24,
    draw: (g, s) => {
      g.fillStyle = "#fda4af";
      g.strokeStyle = "#1a0510";
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(s / 2, 2);
      g.quadraticCurveTo(s / 2 + 6, 7, s / 2 + 4, s - 8);
      g.lineTo(s / 2 + 8, s - 3);
      g.lineTo(s / 2 + 3, s - 5);
      g.lineTo(s / 2 - 3, s - 5);
      g.lineTo(s / 2 - 8, s - 3);
      g.lineTo(s / 2 - 4, s - 8);
      g.quadraticCurveTo(s / 2 - 6, 7, s / 2, 2);
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = "#1a0510";
      g.beginPath();
      g.arc(s / 2, 9, 2, 0, Math.PI * 2);
      g.fill();
    },
  },
  "p-curb": {
    size: 24,
    draw: (g, s) => {
      g.fillStyle = "#0f766e";
      g.strokeStyle = "#ccfbf1";
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(s / 2, s / 2, s / 2 - 1.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = "#ffffff";
      g.font = `bold ${s * 0.5}px "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("路", s / 2, s / 2 + 1);
    },
  },
};

export function addIcons(map: GlobeMap): void {
  const ratio = 2;
  for (const [id, icon] of Object.entries(ICONS)) {
    if (map.hasImage(id)) continue;
    const size = icon.size * ratio;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const g = canvas.getContext("2d");
    if (!g) continue;
    g.scale(ratio, ratio);
    icon.draw(g, icon.size);
    const data = g.getImageData(0, 0, size, size);
    map.addImage(id, { width: size, height: size, data: new Uint8Array(data.data.buffer) }, { pixelRatio: ratio } as Partial<StyleImageMetadata>);
  }
}
