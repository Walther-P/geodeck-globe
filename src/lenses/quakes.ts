// Earthquakes (USGS worldwide M2.5+, plus CWA reports with the visitor's
// key), drawn as rings that fade from red to grey with age. Part of 天氣.

import type { MapGeoJSONFeature } from "maplibre-gl";
import { quakes as cwaQuakes } from "../data/cwa";
import { hasCwa } from "../data/keys";
import { usgsQuakes, type Quake } from "../data/sky";
import { ago, dateTime } from "../lib/time";
import { distance, escapeHtml as esc, safeUrl } from "../lib/util";
import { EMPTY, addLayers, hideLayers, points, setData } from "../map/globe";
import type { AppContext } from "./lens";

export const QUAKE_LAYERS = ["eq-glow", "eq-ring", "eq-label"];

export class QuakeOverlay {
  rows: Quake[] = [];
  note = "";

  constructor(private ctx: AppContext) {
    ctx.onFeatureTap(["eq-ring"], (f) => this.show(f));
  }

  show(f: MapGeoJSONFeature): void {
    const q = this.rows.find((x) => x.id === f.properties.id);
    if (!q) return;
    const link = safeUrl(q.url);
    this.ctx.sheet.open(
      "quake",
      q.source === "氣象署" ? "CWA EARTHQUAKE" : "USGS EARTHQUAKE",
      `規模 ${q.magnitude ?? "?"} 地震`,
      `<div class="stat-row">
        <div class="stat"><b>${q.magnitude ?? "—"}</b><small>規模</small></div>
        <div class="stat"><b>${q.depthKm === null ? "—" : Math.round(q.depthKm)}</b><small>深度 km</small></div>
        <div class="stat"><b>${esc(ago(q.time))}</b><small>${q.time ? esc(dateTime(q.time)) : "時間未知"}</small></div>
      </div>
      <p>${esc(q.place)}</p>
      <p class="micro">資料：${q.source}${q.source === "USGS" ? "（全球自動定位，規模可能與氣象署不同）" : ""}</p>
      ${link ? `<div class="actions"><a class="btn" href="${esc(link)}" target="_blank" rel="noopener">完整報告</a></div>` : ""}`,
    );
  }

  draw(): void {
    const map = this.ctx.map;
    setData(map, "eq", EMPTY);
    addLayers(map, [
      {
        id: "eq-glow",
        type: "circle",
        source: "eq",
        filter: ["<", ["get", "ageH"], 3],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["coalesce", ["get", "mag"], 3], 2.5, 10, 7, 46],
          "circle-color": "#f87171",
          "circle-opacity": 0.18,
          "circle-blur": 0.6,
        },
      },
      {
        id: "eq-ring",
        type: "circle",
        source: "eq",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["coalesce", ["get", "mag"], 3], 2.5, 3, 5, 7, 7, 15],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 1.6,
          "circle-stroke-color": ["interpolate", ["linear"], ["get", "ageH"], 0, "#f87171", 12, "#fbbf24", 48, "#6b7280"],
        },
      },
      {
        id: "eq-label",
        type: "symbol",
        source: "eq",
        minzoom: 4,
        filter: [">=", ["coalesce", ["get", "mag"], 0], 4],
        layout: { "text-field": ["concat", "M", ["to-string", ["get", "mag"]]], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-offset": [0, 1.4] },
        paint: { "text-color": "#fca5a5", "text-halo-color": "#04080d", "text-halo-width": 1.2 },
      },
    ]);
    this.paint();
  }

  hide(): void {
    hideLayers(this.ctx.map, QUAKE_LAYERS);
  }

  async load(): Promise<void> {
    const [usgs, cwa] = await Promise.allSettled([usgsQuakes(), hasCwa() ? cwaQuakes() : Promise.resolve([])]);
    const rows: Quake[] = [];
    if (cwa.status === "fulfilled")
      for (const q of cwa.value)
        rows.push({ id: `cwa-${q.id}`, lat: q.lat, lng: q.lng, magnitude: q.magnitude, depthKm: q.depthKm, time: q.time, place: q.location, url: q.web, source: "氣象署" });
    if (usgs.status === "fulfilled")
      for (const q of usgs.value) {
        // CWA reports win for Taiwan; drop the USGS copy of the same event.
        const dup = rows.some((c) => c.source === "氣象署" && Math.abs((c.time ?? 0) - (q.time ?? 0)) < 120000 && distance(c, q) < 80000);
        if (!dup) rows.push(q);
      }
    this.rows = rows;
    this.paint();
    const failed = [usgs.status === "rejected" && "USGS", hasCwa() && cwa.status === "rejected" && "氣象署"].filter(Boolean);
    this.note = `地震 ${rows.length} 筆（24 小時 M2.5+${hasCwa() ? "＋氣象署報告" : ""}）${failed.length ? `；${failed.join("、")}暫時無法取得` : ""}`;
  }

  private paint(): void {
    const now = Date.now();
    setData(
      this.ctx.map,
      "eq",
      points(this.rows, (q) => ({ id: q.id, mag: q.magnitude === null ? null : Math.round(q.magnitude * 10) / 10, ageH: q.time === null ? 99 : (now - q.time) / 3600000 })),
    );
  }
}
