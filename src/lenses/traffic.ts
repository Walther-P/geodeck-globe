// 交通：road cameras, speed-enforcement points, live buses.

import type { MapGeoJSONFeature } from "maplibre-gl";
import { hasTdx } from "../data/keys";
import { bundledCameras, enforcementPoints, type EnforcementPoint } from "../data/roads";
import { citiesAt } from "../data/taiwan";
import { buses, cameraSrc, cctv, type Bus, type Camera } from "../data/tdx";
import { ago } from "../lib/time";
import { distance, escapeHtml as esc, safeUrl } from "../lib/util";
import { EMPTY, addLayers, hideLayers, points, setData } from "../map/globe";
import { every, type AppContext, type Chip, type Lens } from "./lens";

const LAYERS = ["tr-cam-cluster", "tr-cam-count", "tr-cam", "tr-speed", "tr-speed-label", "tr-bus", "tr-bus-label"];

export class TrafficLens implements Lens {
  id = "traffic" as const;
  title = "交通";
  private on = { cameras: true, speed: true, buses: false };
  private cams = new Map<string, Camera>();
  private camNote = "";
  private tdxCamScopes = new Set<string>();
  private speed: EnforcementPoint[] = [];
  private busRows: Bus[] = [];
  private busCity = "";
  private notes = { cameras: "", speed: "", buses: "" };
  private stops: Array<() => void> = [];
  private active = false;
  private moveTimer = 0;
  private onMove = () => {
    clearTimeout(this.moveTimer);
    this.moveTimer = window.setTimeout(() => {
      void this.loadTdxCameras();
      void this.loadBuses();
    }, 700);
  };

  constructor(private ctx: AppContext) {
    ctx.onFeatureTap(["tr-cam"], (f) => this.showCamera(String(f.properties.id)));
    ctx.onFeatureTap(["tr-cam-cluster"], (f) => {
      const c = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      ctx.map.easeTo({ center: c, zoom: ctx.map.getZoom() + 2 });
    });
    ctx.onFeatureTap(["tr-speed"], (f) => this.showSpeed(f));
    ctx.onFeatureTap(["tr-bus"], (f) => this.showBus(f));
  }

  chips(): Chip[] {
    return [
      { id: "cameras", label: "即時影像", on: this.on.cameras },
      { id: "speed", label: "測速點", on: this.on.speed },
      { id: "buses", label: "公車動態", on: this.on.buses, needs: "tdx" },
    ];
  }

  toggleChip(id: string): void {
    if (id === "buses" && !hasTdx()) {
      this.ctx.openSettings("tdx");
      return;
    }
    const key = id as keyof typeof this.on;
    this.on[key] = !this.on[key];
    if (!this.active) return;
    if (key === "cameras") this.on.cameras ? void this.loadCameras() : hideLayers(this.ctx.map, ["tr-cam-cluster", "tr-cam-count", "tr-cam"]);
    if (key === "speed") this.on.speed ? void this.loadSpeed() : hideLayers(this.ctx.map, ["tr-speed", "tr-speed-label"]);
    if (key === "buses") this.on.buses ? void this.loadBuses() : (setData(this.ctx.map, "tr-buses", EMPTY), (this.notes.buses = ""));
    this.report();
  }

  activate(): void {
    this.active = true;
    setData(this.ctx.map, "tr-buses", EMPTY);
    this.ctx.map.on("moveend", this.onMove);
    if (this.on.cameras) void this.loadCameras();
    if (this.on.speed) void this.loadSpeed();
    if (this.on.buses) void this.loadBuses();
    // Once a minute: a free TDX key only has about five calls a minute for everything.
    this.stops.push(every(60000, () => void this.loadBuses()));
    this.report();
  }

  deactivate(): void {
    this.active = false;
    this.ctx.map.off("moveend", this.onMove);
    for (const stop of this.stops) stop();
    this.stops = [];
    hideLayers(this.ctx.map, LAYERS);
  }

  private report(): void {
    const parts = [this.on.cameras && this.notes.cameras, this.on.speed && this.notes.speed, this.on.buses && this.notes.buses].filter(Boolean);
    this.ctx.status("traffic", parts.join(" · ") || "選擇要顯示的項目");
  }

  // ---- Cameras -----------------------------------------------------------

  private async loadCameras(): Promise<void> {
    if (!this.active) return;
    try {
      if (!this.cams.size) {
        const { cameras, updatedAt } = await bundledCameras();
        for (const c of cameras) this.cams.set(c.id, c);
        this.camNote = `目錄 ${updatedAt.slice(0, 10)}`;
      }
      this.drawCameras();
      this.notes.cameras = `影像 ${this.cams.size.toLocaleString()} 支（${this.camNote}${hasTdx() ? "＋TDX" : ""}）`;
      void this.loadTdxCameras();
    } catch (e) {
      this.notes.cameras = `影像目錄暫時無法取得：${(e as Error).message}`;
    }
    this.report();
  }

  private drawCameras(): void {
    const map = this.ctx.map;
    setData(
      map,
      "tr-cams",
      points([...this.cams.values()], (c) => ({ id: c.id, live: !!(c.image || c.mirror) })),
      { radius: 44, maxZoom: 11 },
    );
    addLayers(map, [
      {
        id: "tr-cam-cluster",
        type: "circle",
        source: "tr-cams",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "rgba(125, 211, 252, 0.16)",
          "circle-stroke-color": "#7dd3fc",
          "circle-stroke-width": 1,
          "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 12, 100, 20, 1000, 28],
        },
      },
      {
        id: "tr-cam-count",
        type: "symbol",
        source: "tr-cams",
        filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-allow-overlap": true },
        paint: { "text-color": "#bae6fd" },
      },
      {
        id: "tr-cam",
        type: "symbol",
        source: "tr-cams",
        filter: ["!", ["has", "point_count"]],
        layout: { "icon-image": "camera", "icon-size": 0.8, "icon-allow-overlap": true },
        paint: { "icon-opacity": ["case", ["get", "live"], 1, 0.5] },
      },
    ]);
  }

  /** Adds TDX freeway/highway/city cameras the bundled catalog lacks. */
  private async loadTdxCameras(): Promise<void> {
    if (!this.active || !this.on.cameras || !hasTdx() || this.ctx.map.getZoom() < 9) return;
    const c = this.ctx.map.getCenter();
    const city = citiesAt({ lat: c.lat, lng: c.lng })[0]?.code;
    const scopes = ["Freeway", "Highway", ...(city ? [city] : [])].filter((s) => !this.tdxCamScopes.has(s));
    if (!scopes.length) return;
    for (const s of scopes) this.tdxCamScopes.add(s);
    const results = await Promise.allSettled(scopes.map((s) => cctv(s)));
    let added = 0;
    const existing = [...this.cams.values()];
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        this.tdxCamScopes.delete(scopes[i]);
        return;
      }
      for (const cam of r.value) {
        const same = existing.find((e) => Math.abs(e.lat - cam.lat) < 0.0005 && Math.abs(e.lng - cam.lng) < 0.0005 && distance(e, cam) < 40);
        // The operator's live feed beats a third-party snapshot of the same camera.
        if (same?.image || (same && !cam.image)) continue;
        if (same) this.cams.delete(same.id);
        this.cams.set(cam.id, cam);
        added++;
      }
    });
    if (added) {
      this.drawCameras();
      this.notes.cameras = `影像 ${this.cams.size.toLocaleString()} 支（${this.camNote}＋TDX）`;
      this.report();
    }
  }

  showCamera(id: string): void {
    const c = this.cams.get(id);
    if (!c) return;
    const page = safeUrl(c.page);
    const live = cameraSrc(c.image);
    const snapshot = live ? null : cameraSrc(c.mirror);
    const src = live ?? snapshot;
    let refresh = 0;
    const body = this.ctx.sheet.open(
      "camera",
      live ? "LIVE CAMERA" : "CAMERA SNAPSHOT",
      c.name,
      `${
        src
          ? `<div class="cam"><p>影像載入中…</p><img id="camImg" alt="${esc(c.name)} 影像"><span class="live-tag">${live ? "● LIVE" : "◷ 快照"}</span></div>`
          : `<p class="muted">這支鏡頭目前沒有可顯示的影像網址。</p>`
      }
      <p class="micro">來源：${esc(c.source)}${snapshot ? "（每 30 秒自動更新）" : ""}。畫面時間以影像本身為準；載入失敗不代表道路有狀況。${page ? ` <a href="${esc(page)}" target="_blank" rel="noopener">原站</a>` : ""}</p>
      <div class="actions">
        ${src ? `<button class="btn" id="camReload">重新整理</button>` : ""}
        <button class="btn" id="camPlace">這裡的天氣與停車</button>
      </div>`,
      () => {
        clearInterval(refresh);
        // Stop the MJPEG stream; otherwise it keeps downloading in the background.
        const img = document.getElementById("camImg") as HTMLImageElement | null;
        if (img) img.src = "";
      },
    );
    const img = body.querySelector<HTMLImageElement>("#camImg");
    const load = () => {
      if (!img || !src) return;
      const p = img.previousElementSibling as HTMLElement;
      p.textContent = "影像載入中…";
      p.classList.remove("hidden");
      img.onload = () => p.classList.add("hidden");
      img.onerror = () => (p.textContent = "目前無法載入影像（可能維修中或來源暫停）");
      img.src = `${src}${src.includes("?") ? "&" : "?"}_=${Date.now()}`;
    };
    load();
    // Stills go stale; the MJPEG streams update themselves.
    if (snapshot) refresh = window.setInterval(load, 30000);
    body.querySelector("#camReload")?.addEventListener("click", load);
    body.querySelector("#camPlace")?.addEventListener("click", () => this.ctx.openPlace({ lat: c.lat, lng: c.lng, title: c.name }));
  }

  // ---- Speed enforcement --------------------------------------------------

  private async loadSpeed(): Promise<void> {
    if (!this.active) return;
    try {
      if (!this.speed.length) {
        const d = await enforcementPoints();
        this.speed = d.points;
        this.notes.speed = `測速點 ${this.speed.length.toLocaleString()}（警政署 ${d.fetchedAt.slice(0, 10)} 快照）`;
      }
      setData(this.ctx.map, "tr-speed-points", points(this.speed, (p) => ({ id: p.id, limit: p.limit ?? "" })));
      addLayers(this.ctx.map, [
        {
          id: "tr-speed",
          type: "circle",
          source: "tr-speed-points",
          minzoom: 9,
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2.5, 14, 9],
            "circle-color": "#1a0606",
            "circle-stroke-color": "#f87171",
            "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 14, 2.2],
          },
        },
        {
          id: "tr-speed-label",
          type: "symbol",
          source: "tr-speed-points",
          minzoom: 13,
          layout: { "text-field": ["to-string", ["get", "limit"]], "text-font": ["Noto Sans Bold"], "text-size": 10, "text-allow-overlap": true },
          paint: { "text-color": "#fecaca" },
        },
      ]);
    } catch (e) {
      this.notes.speed = `測速點資料無法載入：${(e as Error).message}`;
    }
    this.report();
  }

  private showSpeed(f: MapGeoJSONFeature): void {
    const p = this.speed.find((x) => x.id === f.properties.id);
    if (!p) return;
    this.ctx.sheet.open(
      "speed",
      "SPEED ENFORCEMENT",
      p.limit ? `測速 ${p.limit} km/h` : "測速執法點",
      `<p>${esc(p.name)}</p>
      <p class="muted">拍攝方向：${esc(p.direction || "未提供")}</p>
      <p class="micro">資料：內政部警政署「測速執法設置點」開放資料快照。標示的是這個執法點的速限，不代表你目前行駛道路的速限；設備可能增設或停用，以現場標誌為準。</p>`,
    );
  }

  // ---- Buses (TDX) ----------------------------------------------------------

  private async loadBuses(): Promise<void> {
    if (!this.active || !this.on.buses || !hasTdx()) return;
    const map = this.ctx.map;
    if (map.getZoom() < 12) {
      setData(map, "tr-buses", EMPTY);
      this.notes.buses = "公車：放大到街道才顯示";
      this.report();
      return;
    }
    const c = map.getCenter();
    const city = citiesAt({ lat: c.lat, lng: c.lng })[0];
    if (!city) {
      setData(map, "tr-buses", EMPTY);
      this.notes.buses = "公車動態目前只有台灣";
      this.report();
      return;
    }
    try {
      this.busRows = await buses(city.code);
      this.busCity = city.name;
      setData(map, "tr-buses", points(this.busRows, (b) => ({ id: b.id, route: b.route, heading: b.heading ?? 0 })));
      addLayers(map, [
        {
          id: "tr-bus",
          type: "symbol",
          source: "tr-buses",
          layout: {
            "icon-image": "arrow",
            "icon-size": 0.75,
            "icon-rotate": ["get", "heading"],
            "icon-rotation-alignment": "map",
            "icon-allow-overlap": true,
          },
        },
        {
          id: "tr-bus-label",
          type: "symbol",
          source: "tr-buses",
          minzoom: 14,
          layout: { "text-field": ["get", "route"], "text-font": ["Noto Sans Bold"], "text-size": 10.5, "text-offset": [0, 1.3], "text-optional": true },
          paint: { "text-color": "#6ee7b7", "text-halo-color": "#04080d", "text-halo-width": 1.2 },
        },
      ]);
      this.notes.buses = `${city.name}公車 ${this.busRows.length} 輛`;
    } catch (e) {
      this.notes.buses = `公車動態：${(e as Error).message}`;
    }
    this.report();
  }

  private showBus(f: MapGeoJSONFeature): void {
    const b = this.busRows.find((x) => x.id === f.properties.id);
    if (!b) return;
    this.ctx.sheet.open(
      "bus",
      "BUS",
      `${b.route || "公車"}`,
      `<div class="stat-row">
        <div class="stat"><b>${esc(b.id)}</b><small>車牌</small></div>
        <div class="stat"><b>${b.speed ?? "—"}</b><small>km/h</small></div>
        <div class="stat"><b>${esc(ago(b.at))}</b><small>GPS 時間</small></div>
      </div>
      <p class="micro">資料：TDX ${esc(this.busCity)}公車動態（用你自己的金鑰取得）。每 20 秒更新。</p>`,
    );
  }
}
