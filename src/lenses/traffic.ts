// 交通：road cameras, speed-enforcement points, live buses, bike share docks.

import type { MapGeoJSONFeature } from "maplibre-gl";
import { bikeCount, bikeNetworks, networksNear, networkStations, type BikeNetwork, type BikeStation } from "../data/bikes";
import { hasTdx } from "../data/keys";
import { bundledCameras, enforcementPoints, type EnforcementPoint } from "../data/roads";
import { compassName } from "../data/heading";
import { citiesAt } from "../data/taiwan";
import { buses, cameraSrc, cctv, type Bus, type Camera } from "../data/tdx";
import { CAM_SOURCES, hlsNative, windyNear } from "../data/worldcams";
import { FeedError } from "../lib/net";
import { ago } from "../lib/time";
import { boundsOverlap, distance, escapeHtml as esc, inBounds, safeUrl } from "../lib/util";
import { EMPTY, addLayers, hideLayers, points, setData } from "../map/globe";
import { every, viewBounds, type AppContext, type Chip, type Lens } from "./lens";

const LAYERS = ["tr-cam-fan", "tr-cam-cluster", "tr-cam-count", "tr-cam", "tr-speed", "tr-speed-label", "tr-bus", "tr-bus-label", "tr-bike", "tr-bike-count"];
/** Docks from street level up: a city has hundreds to thousands. */
const BIKE_MIN_ZOOM = 14;

export class TrafficLens implements Lens {
  id = "traffic" as const;
  title = "交通";
  private on = { cameras: true, speed: true, buses: false, bikes: true };
  private cams = new Map<string, Camera>();
  private camNote = "";
  private tdxCamScopes = new Set<string>();
  /** Camera lists abroad: when each was fetched and whether it worked. */
  private worldLists = new Map<string, { at: number; ok: boolean }>();
  private worldLoading = new Set<string>();
  /** Sources this site has no key for (the relay said 501): left out quietly. */
  private notSetUp = new Set<string>();
  private windyCells = new Set<string>();
  private speed: EnforcementPoint[] = [];
  private busRows: Bus[] = [];
  private busCity = "";
  private bikeRows: BikeStation[] = [];
  private bikeNets = new Map<string, BikeNetwork>();
  private bikeSeq = 0;
  private notes = { cameras: "", speed: "", buses: "", bikes: "" };
  private stops: Array<() => void> = [];
  private active = false;
  private moveTimer = 0;
  private onMove = () => {
    clearTimeout(this.moveTimer);
    this.moveTimer = window.setTimeout(() => {
      void this.loadTdxCameras();
      void this.loadWorldCameras();
      void this.loadBuses();
      void this.loadBikes();
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
    ctx.onFeatureTap(["tr-bike"], (f) => this.showBike(String(f.properties.id)));
  }

  renderExtra(el: HTMLElement): void {
    const wedge = (dashed: boolean) =>
      `<svg class="lg-fan" viewBox="0 0 20 16" aria-hidden="true"><path d="M10 15 L3.6 3.4 A13 13 0 0 1 16.4 3.4 Z" fill="rgba(125,211,252,${dashed ? 0.18 : 0.38})" stroke="#7dd3fc" stroke-width="1.2"${dashed ? ' stroke-dasharray="2.5 2"' : ""}/></svg>`;
    el.innerHTML = this.on.cameras ? `<p class="legend">${wedge(false)}鏡頭朝向 ${wedge(true)}國道監看的車道方向 · 放大到街道顯示</p>` : "";
  }

  chips(): Chip[] {
    return [
      { id: "cameras", label: "即時影像", on: this.on.cameras },
      { id: "speed", label: "測速點", on: this.on.speed },
      { id: "buses", label: "公車動態", on: this.on.buses, needs: "tdx" },
      { id: "bikes", label: "YouBike／單車", on: this.on.bikes },
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
    if (key === "cameras") this.on.cameras ? void this.loadCameras() : hideLayers(this.ctx.map, ["tr-cam-fan", "tr-cam-cluster", "tr-cam-count", "tr-cam"]);
    if (key === "speed") this.on.speed ? void this.loadSpeed() : hideLayers(this.ctx.map, ["tr-speed", "tr-speed-label"]);
    if (key === "buses") this.on.buses ? void this.loadBuses() : (setData(this.ctx.map, "tr-buses", EMPTY), (this.notes.buses = ""));
    if (key === "bikes") this.on.bikes ? void this.loadBikes() : (setData(this.ctx.map, "tr-bikes", EMPTY), (this.notes.bikes = ""));
    this.report();
  }

  activate(): void {
    this.active = true;
    setData(this.ctx.map, "tr-buses", EMPTY);
    setData(this.ctx.map, "tr-bikes", EMPTY);
    this.ctx.map.on("moveend", this.onMove);
    if (this.on.cameras) void this.loadCameras();
    if (this.on.speed) void this.loadSpeed();
    if (this.on.buses) void this.loadBuses();
    if (this.on.bikes) void this.loadBikes();
    // Once a minute: a free TDX key only has about five calls a minute for everything.
    this.stops.push(every(60000, () => void this.loadBuses()));
    this.stops.push(every(60000, () => void this.loadBikes(true)));
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
    const parts = [this.on.cameras && this.notes.cameras, this.on.speed && this.notes.speed, this.on.buses && this.notes.buses, this.on.bikes && this.notes.bikes].filter(Boolean);
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
      this.reportCameras();
      void this.loadTdxCameras();
      void this.loadWorldCameras();
    } catch (e) {
      this.notes.cameras = `影像目錄暫時無法取得：${(e as Error).message}`;
    }
    this.report();
  }

  private drawCameras(): void {
    const map = this.ctx.map;
    const cams = [...this.cams.values()];
    setData(
      map,
      "tr-cams",
      points(cams, (c) => ({ id: c.id, live: !!(c.image || c.mirror || c.video) })),
      { radius: 44, maxZoom: 11 },
    );
    // Which way each camera looks, as a fan under its icon (cameras stop clustering at 12).
    setData(
      map,
      "tr-cam-fans",
      points(
        cams.filter((c) => typeof c.heading === "number"),
        (c) => ({ id: c.id, heading: c.heading, icon: c.headingKind === "lanes" ? "fan-lanes" : "fan-view" }),
      ),
    );
    addLayers(map, [
      {
        id: "tr-cam-fan",
        type: "symbol",
        source: "tr-cam-fans",
        minzoom: 12,
        layout: {
          "icon-image": ["get", "icon"],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.55, 15, 0.85, 18, 1.2],
          "icon-rotate": ["get", "heading"],
          "icon-rotation-alignment": "map",
          "icon-pitch-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      },
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
      this.reportCameras();
    }
  }

  /** Official cameras abroad: each list is fetched once the map looks at its area. */
  private async loadWorldCameras(): Promise<void> {
    if (!this.active || !this.on.cameras) return;
    const map = this.ctx.map;
    const view = viewBounds(map);
    const zoom = map.getZoom();
    const now = Date.now();
    const due = CAM_SOURCES.filter((s) => {
      const last = this.worldLists.get(s.id);
      const stale = !last || now - last.at > (last.ok ? 6 * 3600000 : 5 * 60000);
      return zoom >= s.minZoom && boundsOverlap(s.bbox, view) && stale && !this.worldLoading.has(s.id) && !this.notSetUp.has(s.id);
    }).slice(0, 4);
    if (due.length) for (const s of due) this.worldLoading.add(s.id);
    void this.loadWindy();
    this.reportCameras();
    if (!due.length) return;
    await Promise.all(
      due.map(async (s) => {
        try {
          const cams = await s.load();
          for (const id of this.cams.keys()) if (id.startsWith(`${s.id}:`)) this.cams.delete(id);
          for (const c of cams) this.cams.set(c.id, c);
          this.worldLists.set(s.id, { at: Date.now(), ok: true });
        } catch (e) {
          if (e instanceof FeedError && e.status === 501) this.notSetUp.add(s.id);
          else this.worldLists.set(s.id, { at: Date.now(), ok: false });
        } finally {
          this.worldLoading.delete(s.id);
        }
      }),
    );
    if (!this.active) return;
    this.drawCameras();
    this.reportCameras();
  }

  /** Windy's worldwide webcam directory, around the map centre once zoomed in to a city. */
  private async loadWindy(): Promise<void> {
    const map = this.ctx.map;
    if (this.notSetUp.has("windy") || map.getZoom() < 9) return;
    const c = map.getCenter();
    const { cell, data } = windyNear(c.lat, c.lng);
    if (this.windyCells.has(cell)) return;
    this.windyCells.add(cell);
    try {
      for (const cam of await data) this.cams.set(cam.id, cam);
    } catch (e) {
      if (e instanceof FeedError && e.status === 501) this.notSetUp.add("windy");
      this.windyCells.delete(cell);
      return;
    }
    if (!this.active) return;
    this.drawCameras();
    this.reportCameras();
  }

  private reportCameras(): void {
    const map = this.ctx.map;
    const view = viewBounds(map);
    const here = CAM_SOURCES.filter((s) => boundsOverlap(s.bbox, view));
    const places = (list: typeof here) => [...new Set(list.map((s) => s.place))].join("、");
    const loaded = here.filter((s) => this.worldLists.get(s.id)?.ok);
    const failed = here.filter((s) => this.worldLists.get(s.id)?.ok === false && !this.worldLoading.has(s.id));
    const later = here.filter((s) => map.getZoom() < s.minZoom && !this.worldLists.has(s.id) && !s.needsKey);
    const windy = this.windyCells.size ? "；Windy 網路攝影機" : "";
    const parts = [`影像 ${this.cams.size.toLocaleString()} 支（台灣${this.camNote}${hasTdx() ? "＋TDX" : ""}${loaded.length ? `；${places(loaded)}官方鏡頭` : ""}${windy}）`];
    if (here.some((s) => this.worldLoading.has(s.id))) parts.push("正在載入當地官方鏡頭…");
    if (failed.length) parts.push(`${places(failed)}鏡頭暫時無法連線，稍後自動重試`);
    if (later.length) parts.push(`放大會載入${places(later)}的官方鏡頭`);
    this.notes.cameras = parts.join(" · ");
    this.report();
  }

  showCamera(id: string): void {
    const c = this.cams.get(id);
    if (!c) return;
    const page = safeUrl(c.page);
    // A Taiwan MJPEG stream updates itself; stills (abroad, or a mirror) are reloaded.
    const stream = c.refreshS ? null : cameraSrc(c.image);
    const still = c.refreshS ? cameraSrc(c.image) : stream ? null : cameraSrc(c.mirror);
    const every = c.refreshS ?? 30;
    const hls = c.video && hlsNative() ? c.video : null;
    const pace = every >= 60 ? `${Math.round(every / 60)} 分鐘` : `${every} 秒`;
    let current = stream ?? still;
    let refresh = 0;
    const media = hls
      ? `<div class="cam"><video id="camVideo" src="${esc(hls)}" autoplay muted playsinline controls></video><span class="live-tag">● LIVE</span></div>`
      : current
        ? `<div class="cam"><p>影像載入中…</p><img id="camImg" alt="${esc(c.name)} 影像"><span class="live-tag">${stream ? "● LIVE" : "◷ 快照"}</span></div>`
        : c.video
          ? `<p class="muted">這支鏡頭只提供串流影片，iPhone 或 Safari 可以直接播放${page ? "；這個瀏覽器請開原站觀看" : ""}。</p>`
          : `<p class="muted">這支鏡頭目前沒有可顯示的影像網址。</p>`;
    const views =
      !hls && c.views && c.views.length > 1
        ? `<div class="chips cam-views">${c.views.map((v, i) => `<button class="chip" data-view="${i}" aria-pressed="${i === 0}">${esc(v.label)}</button>`).join("")}</div>`
        : "";
    const facing =
      typeof c.heading !== "number"
        ? ""
        : c.headingKind === "lanes"
          ? `<p class="muted">監看往${compassName(c.heading)}的車道（地圖上虛線扇形）；國道資料只標示車道方向，鏡頭可能朝來車或去車</p>`
          : `<p class="muted">鏡頭朝${compassName(c.heading)}（地圖上的扇形，依來源標示）</p>`;
    const body = this.ctx.sheet.open(
      "camera",
      hls || stream ? "LIVE CAMERA" : "CAMERA SNAPSHOT",
      c.name,
      `${media}${views}${facing}
      <p class="micro">來源：${esc(c.source)}${still && !hls ? `（每 ${pace}自動更新）` : ""}。畫面時間以影像本身為準；載入失敗不代表道路有狀況。${page ? ` <a href="${esc(page)}" target="_blank" rel="noopener">原站</a>` : ""}</p>
      <div class="actions">
        ${current && !hls ? `<button class="btn" id="camReload">重新整理</button>` : ""}
        ${c.clip && !hls ? `<button class="btn" id="camClip">▶ 播放動態片段</button>` : ""}
        <button class="btn" id="camPlace">這裡的天氣與停車</button>
      </div>`,
      () => {
        clearInterval(refresh);
        // Stop streams; otherwise they keep downloading in the background.
        const img = document.getElementById("camImg") as HTMLImageElement | null;
        if (img) img.src = "";
        const video = document.querySelector<HTMLVideoElement>(".cam video");
        if (video) {
          video.pause();
          video.removeAttribute("src");
          video.load();
        }
      },
    );
    const img = body.querySelector<HTMLImageElement>("#camImg");
    const load = async () => {
      if (!img || !current) return;
      // Some feeds give every frame its own URL; ask for the newest one.
      if (c.latest) current = cameraSrc(await c.latest().catch(() => null)) ?? current;
      const p = img.previousElementSibling as HTMLElement;
      p.textContent = "影像載入中…";
      p.classList.remove("hidden");
      img.onload = () => p.classList.add("hidden");
      img.onerror = () => (p.textContent = "目前無法載入影像（可能維修中或來源暫停）");
      img.src = `${current}${current.includes("?") ? "&" : "?"}_=${Date.now()}`;
    };
    void load();
    if (still && !hls) refresh = window.setInterval(() => void load(), every * 1000);
    body.querySelector("#camReload")?.addEventListener("click", () => void load());
    body.querySelectorAll<HTMLElement>("[data-view]").forEach((b) =>
      b.addEventListener("click", () => {
        const v = c.views?.[Number(b.dataset.view)];
        if (!v) return;
        current = cameraSrc(v.image) ?? current;
        body.querySelectorAll("[data-view]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        void load();
      }),
    );
    body.querySelector("#camClip")?.addEventListener("click", (e) => {
      const box = body.querySelector(".cam");
      if (!box || !c.clip) return;
      clearInterval(refresh);
      box.innerHTML = `<video src="${esc(c.clip)}" autoplay muted playsinline loop controls></video><span class="live-tag">▶ 片段</span>`;
      (e.currentTarget as HTMLElement).remove();
      body.querySelector("#camReload")?.remove();
    });
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

  // ---- Bike share (CityBikes) ---------------------------------------------

  private async loadBikes(force = false): Promise<void> {
    if (!this.active || !this.on.bikes) return;
    const map = this.ctx.map;
    const seq = ++this.bikeSeq;
    if (map.getZoom() < BIKE_MIN_ZOOM) {
      setData(map, "tr-bikes", EMPTY);
      this.notes.bikes = "YouBike／共享單車：放大到街道才顯示";
      this.report();
      return;
    }
    const view = viewBounds(map);
    try {
      const near = networksNear(await bikeNetworks(), view);
      if (seq !== this.bikeSeq) return;
      if (!near.length) {
        setData(map, "tr-bikes", EMPTY);
        this.notes.bikes = "這附近沒有 CityBikes 收錄的共享單車";
        this.report();
        return;
      }
      for (const n of near) this.bikeNets.set(n.id, n);
      const lists = await Promise.allSettled(near.map((n) => networkStations(n.id, force)));
      if (seq !== this.bikeSeq) return;
      this.bikeRows = lists.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).filter((s) => inBounds(s, view));
      const now = Date.now();
      setData(
        map,
        "tr-bikes",
        points(this.bikeRows, (s) => {
          const c = bikeCount(s, now);
          return { id: s.id, count: c.label, state: c.state };
        }),
      );
      addLayers(map, [
        {
          id: "tr-bike",
          type: "symbol",
          source: "tr-bikes",
          layout: { "icon-image": "bike", "icon-size": 0.8, "icon-allow-overlap": true },
        },
        {
          id: "tr-bike-count",
          type: "symbol",
          source: "tr-bikes",
          layout: {
            "text-field": ["get", "count"],
            "text-font": ["Noto Sans Bold"],
            "text-size": 11,
            "text-offset": [0, 1.25],
            "text-allow-overlap": true,
          },
          paint: {
            "text-color": ["match", ["get", "state"], "ok", "#fde68a", "low", "#fbbf24", "empty", "#f87171", "#94a3b8"],
            "text-halo-color": "#04080d",
            "text-halo-width": 1.6,
          },
        },
      ]);
      const failed = lists.filter((r) => r.status === "rejected").length;
      const names = [...new Set(near.map((n) => n.name))].join("、");
      this.notes.bikes = `${names}：畫面中 ${this.bikeRows.length} 站${failed ? `（${failed} 個系統暫時讀不到）` : ""}`;
    } catch (e) {
      this.notes.bikes = `共享單車：${(e as Error).message}`;
    }
    this.report();
  }

  private showBike(id: string): void {
    const s = this.bikeRows.find((x) => x.id === id);
    if (!s) return;
    const net = this.bikeNets.get(s.network);
    const c = bikeCount(s);
    const fresh = c.state !== "old" && c.state !== "none";
    const val = (v: number | null) => (fresh && v !== null ? String(v) : "?");
    const body = this.ctx.sheet.open(
      "bike",
      "BIKE SHARE",
      s.name || "單車站",
      `<div class="stat-row">
        <div class="stat"><b>${val(s.bikes)}</b><small>可借${s.ebikes !== null && fresh ? `（電輔 ${s.ebikes}）` : ""}</small></div>
        <div class="stat"><b>${val(s.docks)}</b><small>可還空位</small></div>
        <div class="stat"><b>${esc(ago(s.updatedAt))}</b><small>更新</small></div>
      </div>
      ${!s.online ? `<p class="muted">此站目前暫停服務</p>` : ""}
      ${!fresh ? `<p class="muted">${c.state === "none" ? "這個系統沒有提供車輛數" : "資料超過 15 分鐘，數字暫不採用"}</p>` : ""}
      ${s.slots ? `<p>總車位：${s.slots}</p>` : ""}
      ${s.address ? `<p>地址：${esc(s.address)}</p>` : ""}
      <p class="micro">資料：<a href="https://citybik.es/" target="_blank" rel="noopener">CityBikes</a>（${esc(net?.name ?? s.network)}${net?.city ? `，${esc(net.city)}` : ""}），每分鐘更新。實際車況以現場為準。</p>
      <div class="actions"><button class="btn primary" id="bikeGo">導航到這裡</button></div>`,
    );
    body.querySelector("#bikeGo")?.addEventListener("click", () => this.ctx.openPlace({ lat: s.lat, lng: s.lng, title: s.name || "單車站" }, "walk"));
  }
}

