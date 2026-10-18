// 天氣：radar loop, satellite clouds, wind particles, typhoon tracks, CWA
// warnings and earthquakes.

import type { MapGeoJSONFeature, RasterLayerSpecification } from "maplibre-gl";
import { cyclones, warnings, type Cyclone, type Warning } from "../data/cwa";
import { hasCwa } from "../data/keys";
import { cloudLayer, cloudTiles, cloudTime, radarFrames, type RadarFrame } from "../data/sky";
import { windGrid, type GridBox, type WindGrid } from "../data/wind";
import { ago, clock, dateTime } from "../lib/time";
import { circlePolygon, escapeHtml as esc } from "../lib/util";
import { EMPTY, addLayers, hideLayers, setData } from "../map/globe";
import { WindLayer } from "../ui/wind";
import { every, type AppContext, type Chip, type Lens } from "./lens";
import { QuakeOverlay } from "./quakes";

const FIRST_LABEL = "place-minor";

export class WeatherLens implements Lens {
  id = "weather" as const;
  title = "天氣";
  private on = { radar: true, clouds: false, wind: false, typhoon: true, warnings: true, quakes: true };
  private frames: RadarFrame[] = [];
  private frame = -1;
  private playing = 0;
  private stops: Array<() => void> = [];
  private active = false;
  private cloudId = "";
  private storms: Cyclone[] = [];
  private alerts: Warning[] = [];
  private notes = { radar: "", clouds: "", wind: "", typhoon: "", warnings: "" };
  private quakes: QuakeOverlay;
  private wind: WindLayer;
  private windData: WindGrid | null = null;
  private windTimer = 0;
  private onMove = () => {
    if (this.on.clouds && cloudLayer(this.ctx.map.getCenter().lng) !== this.cloudId) void this.loadClouds();
    if (this.on.wind) {
      clearTimeout(this.windTimer);
      this.windTimer = window.setTimeout(() => void this.loadWind(), 700);
    }
  };

  constructor(private ctx: AppContext) {
    ctx.onFeatureTap(["wx-storm-point", "wx-storm-line"], (f) => this.showStorm(f));
    this.quakes = new QuakeOverlay(ctx);
    this.wind = new WindLayer(ctx.map);
  }

  chips(): Chip[] {
    return [
      { id: "radar", label: "雷達", on: this.on.radar },
      { id: "clouds", label: "雲圖", on: this.on.clouds },
      { id: "wind", label: "風場", on: this.on.wind },
      { id: "typhoon", label: "颱風", on: this.on.typhoon, needs: "cwa" },
      { id: "warnings", label: `特報${this.alerts.length ? ` ${this.alerts.length}` : ""}`, on: this.on.warnings, needs: "cwa" },
      { id: "quakes", label: "地震", on: this.on.quakes },
    ];
  }

  toggleChip(id: string): void {
    if ((id === "typhoon" || id === "warnings") && !hasCwa()) {
      this.ctx.openSettings("cwa");
      return;
    }
    if (id === "warnings" && this.on.warnings && this.alerts.length) {
      this.showWarnings();
      return;
    }
    const key = id as keyof typeof this.on;
    this.on[key] = !this.on[key];
    if (!this.active) return;
    if (key === "radar") this.on.radar ? void this.loadRadar() : this.hideRadar();
    if (key === "clouds") this.on.clouds ? void this.loadClouds() : hideLayers(this.ctx.map, ["wx-clouds"]);
    if (key === "typhoon") this.on.typhoon ? void this.loadStorms() : hideLayers(this.ctx.map, ["wx-storm-radius", "wx-storm-line", "wx-storm-point"]);
    if (key === "warnings" && this.on.warnings) void this.loadWarnings();
    if (key === "wind") this.on.wind ? void this.loadWind(true) : (this.wind.hide(), (this.windData = null));
    if (key === "quakes") this.on.quakes ? (this.quakes.draw(), void this.loadQuakes()) : this.quakes.hide();
    this.report();
  }

  activate(): void {
    this.active = true;
    this.ctx.map.on("moveend", this.onMove);
    void this.loadRadar();
    if (this.on.clouds) void this.loadClouds();
    if (hasCwa()) {
      void this.loadStorms();
      void this.loadWarnings();
    } else {
      this.notes.typhoon = "";
      this.notes.warnings = "颱風與特報需要氣象署授權碼";
    }
    if (this.on.wind) void this.loadWind(true);
    if (this.on.quakes) {
      this.quakes.draw();
      void this.loadQuakes();
    }
    this.stops.push(every(5 * 60000, () => void this.loadRadar()));
    this.stops.push(every(120000, () => void this.loadQuakes()));
    this.stops.push(every(30 * 60000, () => void this.loadWind(true)));
    this.stops.push(every(15 * 60000, () => (hasCwa() ? (void this.loadStorms(), void this.loadWarnings()) : undefined)));
    this.report();
  }

  deactivate(): void {
    this.active = false;
    this.pause();
    this.ctx.map.off("moveend", this.onMove);
    for (const stop of this.stops) stop();
    this.stops = [];
    this.hideRadar();
    hideLayers(this.ctx.map, ["wx-clouds", "wx-storm-radius", "wx-storm-line", "wx-storm-point"]);
    this.quakes.hide();
    this.wind.hide();
    this.windData = null;
  }

  private report(): void {
    const parts = [
      this.on.radar && this.notes.radar,
      this.on.clouds && this.notes.clouds,
      this.on.wind && this.notes.wind,
      this.on.typhoon && this.notes.typhoon,
      this.on.warnings && this.notes.warnings,
      this.on.quakes && this.quakes.note,
    ].filter(Boolean);
    this.ctx.status("weather", parts.join(" · ") || "選擇要顯示的項目", this.alerts.length ? "warn" : undefined);
    this.ctx.refreshStrip("weather");
  }

  // ---- Radar --------------------------------------------------------------

  private async loadRadar(): Promise<void> {
    if (!this.active || !this.on.radar) return;
    try {
      const frames = await radarFrames();
      if (!frames.length) throw new Error("沒有雷達畫面");
      const latestChanged = frames.at(-1)!.time !== this.frames.at(-1)?.time;
      this.frames = frames;
      if (latestChanged || this.frame < 0) this.show(frames.length - 1);
      const age = Date.now() - frames.at(-1)!.time;
      this.notes.radar = `雷達 ${clock(frames.at(-1)!.time)}${age > 30 * 60000 ? "（資料較舊）" : ""}`;
    } catch (e) {
      this.notes.radar = `雷達暫時無法取得：${(e as Error).message}`;
    }
    this.report();
  }

  private layerFor(i: number): string {
    return `wx-radar-${this.frames[i].time}`;
  }

  /** Each frame is its own layer so stepping through them doesn't flash. */
  private show(i: number): void {
    const map = this.ctx.map;
    if (!this.frames[i]) return;
    const want = new Set([i, (i + 1) % this.frames.length].map((k) => this.layerFor(k)));
    for (const layer of map.getStyle().layers ?? []) {
      if (layer.id.startsWith("wx-radar-") && !want.has(layer.id)) {
        map.removeLayer(layer.id);
        map.removeSource(layer.id);
      }
    }
    for (const k of [i, (i + 1) % this.frames.length]) {
      const id = this.layerFor(k);
      if (!map.getSource(id)) map.addSource(id, { type: "raster", tiles: [this.frames[k].tiles], tileSize: 256, maxzoom: 7, attribution: "雷達 © RainViewer" });
      if (!map.getLayer(id)) {
        const layer: RasterLayerSpecification = { id, type: "raster", source: id, paint: { "raster-opacity": 0, "raster-fade-duration": 0 } };
        map.addLayer(layer, map.getLayer(FIRST_LABEL) ? FIRST_LABEL : undefined);
      }
      map.setPaintProperty(id, "raster-opacity", k === i ? 0.72 : 0);
    }
    this.frame = i;
    const timeEl = document.getElementById("radarTime");
    if (timeEl) timeEl.textContent = clock(this.frames[i].time);
    const range = document.getElementById("radarRange") as HTMLInputElement | null;
    if (range) range.value = String(i);
  }

  private hideRadar(): void {
    const map = this.ctx.map;
    for (const layer of map.getStyle().layers ?? []) {
      if (layer.id.startsWith("wx-radar-")) {
        map.removeLayer(layer.id);
        map.removeSource(layer.id);
      }
    }
    this.frame = -1;
  }

  private play(): void {
    if (this.playing || this.frames.length < 2) return;
    this.playing = window.setInterval(() => this.show((this.frame + 1) % this.frames.length), 700);
    this.ctx.refreshStrip("weather");
  }

  private pause(): void {
    clearInterval(this.playing);
    this.playing = 0;
  }

  renderExtra(el: HTMLElement): void {
    if (this.on.wind)
      el.insertAdjacentHTML(
        "beforeend",
        `<p class="legend wind-legend">風速 m/s <b style="color:#7dd3fc">&lt;3</b><b style="color:#5eead4">3–7</b><b style="color:#fbbf24">7–12</b><b style="color:#f97316">12–18</b><b style="color:#f87171">18+</b></p>`,
      );
    if (!this.on.radar || !this.frames.length) return;
    const last = this.frames.length - 1;
    el.insertAdjacentHTML("afterbegin", `<div class="timeline">
      <button class="play" id="radarPlay" aria-label="${this.playing ? "暫停" : "播放雷達回波"}">${this.playing ? "❚❚" : "▶"}</button>
      <input id="radarRange" type="range" min="0" max="${last}" value="${Math.max(0, this.frame)}" aria-label="雷達時間">
      <time id="radarTime">${this.frame >= 0 ? clock(this.frames[this.frame].time) : ""}</time>
    </div>`);
    el.querySelector("#radarPlay")!.addEventListener("click", () => {
      if (this.playing) this.pause();
      else this.play();
      this.ctx.refreshStrip("weather");
    });
    el.querySelector<HTMLInputElement>("#radarRange")!.addEventListener("input", (e) => {
      this.pause();
      this.show(Number((e.target as HTMLInputElement).value));
    });
  }

  // ---- Wind ---------------------------------------------------------------

  /** The view (plus a margin), or the whole globe when zoomed out. */
  private windBox(): { box: GridBox; nx: number; ny: number } {
    const map = this.ctx.map;
    if (map.getZoom() < 3.5) return { box: { west: -180, east: 180, south: -66, north: 72 }, nx: 20, ny: 10 };
    const b = map.getBounds();
    const padX = (b.getEast() - b.getWest()) * 0.2;
    const padY = (b.getNorth() - b.getSouth()) * 0.2;
    const portrait = map.getContainer().clientHeight > map.getContainer().clientWidth;
    return {
      box: { west: b.getWest() - padX, east: b.getEast() + padX, south: Math.max(-80, b.getSouth() - padY), north: Math.min(80, b.getNorth() + padY) },
      nx: portrait ? 9 : 13,
      ny: portrait ? 13 : 9,
    };
  }

  /** Re-asks only when the view has left the grid we have (or on a forced refresh). */
  private async loadWind(force = false): Promise<void> {
    if (!this.active || !this.on.wind) return;
    const map = this.ctx.map;
    const { box, nx, ny } = this.windBox();
    const have = this.windData;
    if (!force && have) {
      const b = map.getBounds();
      const inside = b.getWest() >= have.west && b.getEast() <= have.east && b.getSouth() >= have.south && b.getNorth() <= have.north;
      const span = (have.east - have.west) / (box.east - box.west);
      if (inside && span < 3) return;
    }
    try {
      const grid = await windGrid(box, nx, ny);
      if (!this.active || !this.on.wind) return;
      this.windData = grid;
      this.wind.show(grid);
      this.notes.wind = `風場 ${grid.time ? clock(grid.time) : "現在"}，最大 ${Math.round(grid.maxSpeed)} m/s（Open-Meteo 模式）`;
    } catch (e) {
      this.notes.wind = `風場暫時無法取得：${(e as Error).message}`;
    }
    this.report();
  }

  // ---- Earthquakes --------------------------------------------------------

  private async loadQuakes(): Promise<void> {
    if (!this.active || !this.on.quakes) return;
    await this.quakes.load();
    this.report();
  }

  // ---- Clouds -------------------------------------------------------------

  private async loadClouds(): Promise<void> {
    const map = this.ctx.map;
    const layer = cloudLayer(map.getCenter().lng);
    this.cloudId = layer;
    const time = await cloudTime(layer);
    if (!this.active || !this.on.clouds || this.cloudId !== layer) return;
    if (map.getLayer("wx-clouds")) map.removeLayer("wx-clouds");
    if (map.getSource("wx-clouds")) map.removeSource("wx-clouds");
    map.addSource("wx-clouds", { type: "raster", tiles: [cloudTiles(layer, time)], tileSize: 256, maxzoom: 6, attribution: "雲圖 NASA GIBS" });
    map.addLayer({ id: "wx-clouds", type: "raster", source: "wx-clouds", paint: { "raster-opacity": 0.6 } }, map.getLayer(FIRST_LABEL) ? FIRST_LABEL : undefined);
    const name = layer.startsWith("Himawari") ? "向日葵衛星" : layer.startsWith("GOES") ? "GOES 衛星" : "MODIS 日資料";
    const t = time && time.includes("T") ? Date.parse(time) : null;
    this.notes.clouds = `雲圖 ${name} ${t ? clock(t) : time ? time + "（日資料）" : "最新"}`;
    this.report();
  }

  // ---- Typhoons (CWA) -----------------------------------------------------

  private async loadStorms(): Promise<void> {
    if (!this.active || !this.on.typhoon || !hasCwa()) return;
    try {
      this.storms = await cyclones();
      this.notes.typhoon = this.storms.length ? `颱風 ${this.storms.map((s) => s.name).join("、")}` : "目前沒有颱風";
      this.drawStorms();
    } catch (e) {
      this.notes.typhoon = `颱風資料暫時無法取得：${(e as Error).message}`;
    }
    this.report();
  }

  private drawStorms(): void {
    const map = this.ctx.map;
    const lines: GeoJSON.Feature[] = [];
    const dots: GeoJSON.Feature[] = [];
    const radii: GeoJSON.Feature[] = [];
    for (const s of this.storms) {
      const past = s.fixes.filter((f) => !f.forecast);
      const future = s.fixes.filter((f) => f.forecast);
      const now = past.at(-1);
      if (past.length > 1) lines.push(line(s.id, past.map((f) => [f.lng, f.lat]), false));
      if (now && future.length) lines.push(line(s.id, [[now.lng, now.lat], ...future.map((f) => [f.lng, f.lat] as [number, number])], true));
      for (const f of s.fixes)
        dots.push({ type: "Feature", properties: { id: s.id, name: s.name, forecast: f.forecast, current: f === now }, geometry: { type: "Point", coordinates: [f.lng, f.lat] } });
      if (now?.radius15Km) radii.push(circlePolygon(now.lng, now.lat, now.radius15Km, { id: s.id }));
    }
    setData(map, "wx-storm-lines", lines.length ? { type: "FeatureCollection", features: lines } : EMPTY);
    setData(map, "wx-storm-points", { type: "FeatureCollection", features: dots });
    setData(map, "wx-storm-radii", { type: "FeatureCollection", features: radii });
    addLayers(map, [
      { id: "wx-storm-radius", type: "fill", source: "wx-storm-radii", paint: { "fill-color": "#f87171", "fill-opacity": 0.12, "fill-outline-color": "#f87171" } },
      {
        id: "wx-storm-line",
        type: "line",
        source: "wx-storm-lines",
        paint: { "line-color": ["case", ["get", "forecast"], "#fbbf24", "#f87171"], "line-width": 2, "line-dasharray": [2, 1.5] },
      },
      {
        id: "wx-storm-point",
        type: "circle",
        source: "wx-storm-points",
        paint: {
          "circle-radius": ["case", ["get", "current"], 7, 3.5],
          "circle-color": ["case", ["get", "forecast"], "#fbbf24", "#f87171"],
          "circle-stroke-color": "#04080d",
          "circle-stroke-width": 1,
        },
      },
    ]);
  }

  private showStorm(f: MapGeoJSONFeature): void {
    const s = this.storms.find((x) => x.id === f.properties.id);
    if (!s) return;
    const now = s.fixes.filter((x) => !x.forecast).at(-1);
    const rows = s.fixes
      .filter((x) => x.forecast)
      .map((x) => `<li><div>${x.time ? esc(dateTime(x.time)) : "時間未知"}<small>${x.lat.toFixed(1)}°N ${x.lng.toFixed(1)}°E</small></div><span class="badge warn">${x.windMs ?? "—"} m/s</span></li>`)
      .join("");
    this.ctx.sheet.open(
      "storm",
      "TROPICAL CYCLONE",
      s.name,
      `<div class="stat-row">
        <div class="stat"><b>${now?.windMs ?? "—"}</b><small>最大風速 m/s</small></div>
        <div class="stat"><b>${now?.radius15Km ?? "—"}</b><small>七級風半徑 km</small></div>
        <div class="stat"><b>${now?.time ? esc(ago(now.time)) : "—"}</b><small>最新定位</small></div>
      </div>
      <h2>預報路徑</h2><ul class="list">${rows || "<li>沒有預報點</li>"}</ul>
      <p class="micro">資料：中央氣象署 W-C0034-005。紅色為已發生的路徑，黃色虛線為預報；預報有不確定性，以氣象署發布為準。</p>
      <div class="actions"><a class="btn" href="https://www.cwa.gov.tw/V8/C/P/Typhoon/TY_NEWS.html" target="_blank" rel="noopener">氣象署颱風消息</a></div>`,
    );
  }

  // ---- Warnings (CWA) -----------------------------------------------------

  private async loadWarnings(): Promise<void> {
    if (!this.active || !this.on.warnings || !hasCwa()) return;
    try {
      this.alerts = await warnings();
      this.notes.warnings = this.alerts.length ? `${new Set(this.alerts.map((a) => a.phenomena)).size} 種特報生效中（點「特報」看）` : "目前沒有天氣特報";
    } catch (e) {
      this.notes.warnings = `特報暫時無法取得：${(e as Error).message}`;
    }
    this.report();
  }

  private showWarnings(): void {
    const byKind = new Map<string, Warning[]>();
    for (const a of this.alerts) byKind.set(`${a.phenomena}${a.significance}`, [...(byKind.get(`${a.phenomena}${a.significance}`) ?? []), a]);
    const html = [...byKind.entries()]
      .map(([kind, rows]) => {
        const end = rows.map((r) => r.end).filter((x): x is number => x !== null).sort((a, b) => b - a)[0];
        return `<li><div><strong>${esc(kind)}</strong><small>${esc(rows.map((r) => r.area).join("、"))}</small></div>${end ? `<span class="badge warn">至 ${esc(dateTime(end))}</span>` : ""}</li>`;
      })
      .join("");
    this.ctx.sheet.open(
      "warnings",
      "CWA WARNINGS",
      "天氣特報",
      `<ul class="list">${html}</ul><p class="micro">資料：中央氣象署 W-C0033-001（各縣市目前生效的天氣特報）。</p>
      <div class="actions"><a class="btn" href="https://www.cwa.gov.tw/V8/C/P/Warning/FIFOWS.html" target="_blank" rel="noopener">氣象署特報頁</a></div>`,
    );
  }

  activeWarnings(): Warning[] {
    return this.alerts;
  }
}

function line(id: string, coords: Array<[number, number]>, forecast: boolean): GeoJSON.Feature {
  return { type: "Feature", properties: { id, forecast }, geometry: { type: "LineString", coordinates: coords } };
}
