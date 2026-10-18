// 停車：island-wide parking catalog, live counts (TDX, own key), my car.

import { Marker, type MapGeoJSONFeature } from "maplibre-gl";
import { hasTdx } from "../data/keys";
import { catalogLots, catalogSummary, kindLabel, liveStatus, mergeLots, type CatalogLot } from "../data/parking";
import { parkedCar, setParkedCar } from "../data/places";
import { parkingCameraLinks } from "../data/roads";
import { citiesAt } from "../data/taiwan";
import { liveLots, type LiveLot } from "../data/tdx";
import { ago, dateTime } from "../lib/time";
import { escapeHtml as esc, formatCoord, safeUrl } from "../lib/util";
import { EMPTY, addLayers, hideLayers, setData } from "../map/globe";
import { every, viewBounds, type AppContext, type Chip, type Lens } from "./lens";

const LAYERS = ["pk-cluster", "pk-cluster-count", "pk-dot", "pk-sign", "pk-summary", "pk-summary-label"];

export class ParkingLens implements Lens {
  id = "parking" as const;
  title = "停車";
  private on = { lots: true, curb: true, live: true, car: true };
  private catalog: CatalogLot[] = [];
  private live = new Map<string, { at: number; lots: LiveLot[] }>();
  private liveErrors: string[] = [];
  private stops: Array<() => void> = [];
  private active = false;
  private seq = 0;
  private moveTimer = 0;
  private carMarker: Marker | null = null;
  private onMove = () => {
    clearTimeout(this.moveTimer);
    this.moveTimer = window.setTimeout(() => void this.refresh(), 450);
  };

  constructor(private ctx: AppContext) {
    ctx.onFeatureTap(["pk-sign", "pk-dot"], (f) => this.showLot(f));
    ctx.onFeatureTap(["pk-cluster", "pk-summary"], (f) => {
      const c = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      ctx.map.easeTo({ center: c, zoom: Math.max(ctx.map.getZoom() + 2, 12) });
    });
  }

  chips(): Chip[] {
    return [
      { id: "lots", label: "停車場", on: this.on.lots },
      { id: "curb", label: "路邊／車格", on: this.on.curb },
      { id: "live", label: "即時車位", on: this.on.live && hasTdx(), needs: "tdx" },
      { id: "car", label: parkedCar() ? "我的車" : "記住停車位置", on: this.on.car && !!parkedCar() },
    ];
  }

  toggleChip(id: string): void {
    if (id === "live" && !hasTdx()) {
      this.ctx.openSettings("tdx");
      return;
    }
    if (id === "car") {
      this.carAction();
      return;
    }
    const key = id as keyof typeof this.on;
    this.on[key] = !this.on[key];
    if (this.active) void this.refresh();
    this.ctx.refreshStrip("parking");
  }

  renderExtra(el: HTMLElement): void {
    el.innerHTML = `<p class="legend"><span class="lg-lot">P</span>停車場 <span class="lg-curb">路</span>路邊 <b class="lg-ok">12</b>剩餘格數 <b class="lg-low">3</b>快滿 <b class="lg-full">滿</b> <b class="lg-old">?</b>資料超過 5 分鐘</p>`;
  }

  activate(): void {
    this.active = true;
    setData(this.ctx.map, "pk", EMPTY, { radius: 46, maxZoom: 14 });
    setData(this.ctx.map, "pk-summary", EMPTY);
    this.ctx.map.on("moveend", this.onMove);
    void this.refresh();
    this.stops.push(every(60000, () => void this.refresh(true)));
    this.drawCar();
  }

  deactivate(): void {
    this.active = false;
    this.ctx.map.off("moveend", this.onMove);
    for (const stop of this.stops) stop();
    this.stops = [];
    hideLayers(this.ctx.map, LAYERS);
    this.carMarker?.remove();
    this.carMarker = null;
  }

  private async refresh(refreshLive = false): Promise<void> {
    if (!this.active) return;
    const map = this.ctx.map;
    const seq = ++this.seq;
    const view = viewBounds(map);
    const zoom = map.getZoom();
    try {
      if (zoom < 11) {
        const summary = await catalogSummary(view);
        if (seq !== this.seq) return;
        setData(map, "pk", EMPTY);
        setData(map, "pk-summary", {
          type: "FeatureCollection",
          features: summary.map((s) => ({ type: "Feature", properties: { count: s.count }, geometry: { type: "Point", coordinates: [s.lng, s.lat] } })),
        });
        this.drawLayers();
        const total = summary.reduce((n, s) => n + s.count, 0);
        this.ctx.status("parking", total ? `此範圍 ${total.toLocaleString()} 處停車位置 · 放大看個別停車場` : "此範圍沒有收錄的停車資料（目前只有台灣）");
        return;
      }
      setData(map, "pk-summary", EMPTY);
      this.catalog = await catalogLots(view);
      const live = this.on.live && hasTdx() ? await this.liveFor(view, refreshLive) : [];
      if (seq !== this.seq) return;
      const merged = mergeLots(this.catalog, live);
      const now = Date.now();
      const features: GeoJSON.Feature[] = [];
      for (const p of merged.catalog) {
        if (p.kind === "lot" ? !this.on.lots : !this.on.curb) continue;
        features.push(feature(p.id, p.lng, p.lat, { kind: p.kind, count: "", state: "none", available: -1 }));
      }
      for (const l of merged.live) {
        if (!this.on.lots) continue;
        const s = liveStatus(l, now);
        // "?" means this lot reports counts but the latest one is too old to trust.
        features.push(feature(l.id, l.lng, l.lat, { kind: "lot", count: s.label, state: s.state, available: l.available ?? -1 }));
      }
      setData(map, "pk", { type: "FeatureCollection", features });
      this.drawLayers();
      const fresh = merged.live.filter((l) => liveStatus(l, now).state === "fresh" || liveStatus(l, now).state === "full").length;
      const parts = [`${features.length.toLocaleString()} 處`];
      if (hasTdx() && this.on.live) parts.push(merged.live.length ? `即時 ${fresh}/${merged.live.length} 場有 5 分鐘內資料` : "此區沒有 TDX 即時車位");
      else parts.push("即時車位需 TDX 金鑰");
      if (this.liveErrors.length) parts.push(this.liveErrors.join("；"));
      this.ctx.status("parking", parts.join(" · "), this.liveErrors.length ? "warn" : undefined);
    } catch (e) {
      this.ctx.status("parking", `停車資料暫時無法讀取：${(e as Error).message}`, "bad");
    }
  }

  private async liveFor(view: ReturnType<typeof viewBounds>, force: boolean): Promise<LiveLot[]> {
    const center = { lat: (view.north + view.south) / 2, lng: (view.east + view.west) / 2 };
    const cities = citiesAt(center).slice(0, 2);
    this.liveErrors = [];
    const out: LiveLot[] = [];
    await Promise.all(
      cities.map(async (c) => {
        const cached = this.live.get(c.code);
        if (cached && !force && Date.now() - cached.at < 60000) {
          out.push(...cached.lots);
          return;
        }
        try {
          const lots = await liveLots(c.code);
          this.live.set(c.code, { at: Date.now(), lots });
          out.push(...lots);
        } catch (e) {
          if (cached) out.push(...cached.lots);
          this.liveErrors.push(`${c.name}即時車位：${(e as Error).message}`);
        }
      }),
    );
    return out;
  }

  private drawLayers(): void {
    addLayers(this.ctx.map, [
      {
        id: "pk-summary",
        type: "circle",
        source: "pk-summary",
        paint: {
          "circle-color": "rgba(52, 211, 153, 0.14)",
          "circle-stroke-color": "#34d399",
          "circle-stroke-width": 1,
          "circle-radius": ["interpolate", ["linear"], ["get", "count"], 1, 10, 500, 18, 5000, 30],
        },
      },
      {
        id: "pk-summary-label",
        type: "symbol",
        source: "pk-summary",
        layout: { "text-field": ["to-string", ["get", "count"]], "text-font": ["Noto Sans Bold"], "text-size": 10.5, "text-allow-overlap": true },
        paint: { "text-color": "#a7f3d0" },
      },
      {
        id: "pk-cluster",
        type: "circle",
        source: "pk",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "rgba(52, 211, 153, 0.14)",
          "circle-stroke-color": "#34d399",
          "circle-stroke-width": 1,
          "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 12, 100, 20, 1000, 28],
        },
      },
      {
        id: "pk-cluster-count",
        type: "symbol",
        source: "pk",
        filter: ["has", "point_count"],
        layout: { "text-field": ["concat", ["get", "point_count_abbreviated"], "處"], "text-font": ["Noto Sans Bold"], "text-size": 10.5, "text-allow-overlap": true },
        paint: { "text-color": "#a7f3d0" },
      },
      {
        // Individual marked bays: just dots, only when zoomed right in.
        id: "pk-dot",
        type: "circle",
        source: "pk",
        minzoom: 16,
        filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "kind"], "space"]],
        paint: { "circle-radius": 3.5, "circle-color": "#1f2b36", "circle-stroke-color": "#94a3b8", "circle-stroke-width": 1 },
      },
      {
        // Square blue "P" = parking lot; round teal "路" = kerbside parking.
        // The number beside it is free spaces right now.
        id: "pk-sign",
        type: "symbol",
        source: "pk",
        filter: ["all", ["!", ["has", "point_count"]], ["in", ["get", "kind"], ["literal", ["lot", "curb"]]]],
        layout: {
          "icon-image": ["match", ["get", "kind"], "curb", "p-curb", "p-lot"],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.7, 16, 1],
          "icon-allow-overlap": true,
          "symbol-sort-key": ["case", ["==", ["get", "state"], "fresh"], 0, ["==", ["get", "state"], "full"], 1, 2],
          "text-field": ["get", "count"],
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 12, 12, 16, 14],
          "text-anchor": "left",
          "text-offset": [0.95, 0],
          "text-optional": true,
        },
        paint: {
          "text-color": [
            "case",
            ["==", ["get", "state"], "full"],
            "#f87171",
            ["==", ["get", "state"], "fresh"],
            ["case", ["<=", ["get", "available"], 10], "#fbbf24", "#4ade80"],
            "#94a3b8",
          ],
          "text-halo-color": "#04080d",
          "text-halo-width": 2,
        },
      },
    ]);
  }

  private async showLot(f: MapGeoJSONFeature): Promise<void> {
    const id = String(f.properties.id);
    const live = [...this.live.values()].flatMap((x) => x.lots).find((l) => l.id === id);
    const lot = this.catalog.find((p) => p.id === id);
    if (!live && !lot) return;
    const name = live?.name ?? lot!.name;
    const pos = live ?? lot!;
    const status = live ? liveStatus(live) : null;
    const rows: string[] = [];
    if (status) rows.push(`<p><span class="badge ${status.state === "fresh" ? "live" : status.state === "full" ? "full" : ""}">${esc(status.label)}</span> ${esc(status.text)}${live?.updatedAt ? `（${esc(ago(live.updatedAt))}）` : ""}</p>`);
    else rows.push(`<p class="muted">${esc(kindLabel(lot!.kind))} · 這筆來源沒有即時車位</p>`);
    const total = live?.total ?? lot?.total;
    if (total) rows.push(`<p>總車位：${total}</p>`);
    const fare = live?.fare || lot?.rate;
    if (fare) rows.push(`<p>費率：${esc(fare)}</p>`);
    if (lot?.hours) rows.push(`<p>開放時間：${esc(lot.hours)}</p>`);
    const address = live?.address || lot?.address;
    if (address) rows.push(`<p>地址：${esc(address)}</p>`);
    if (lot?.access) rows.push(`<p class="muted">${esc(lot.access)}</p>`);
    const source = live ? `TDX 即時車位（${live.city}，用你自己的金鑰）` : sourceName(lot!.source);
    const link = safeUrl(lot?.url);
    const body = this.ctx.sheet.open(
      "lot",
      "PARKING",
      name,
      `${rows.join("")}
      <div id="lotCam"></div>
      <p class="micro">資料：${esc(source)}${link ? ` · <a href="${esc(link)}" target="_blank" rel="noopener">原始資料</a>` : ""}。費率與開放時間以現場公告為準。</p>
      <div class="actions">
        <button class="btn primary" id="lotGo">導航到這裡</button>
        <button class="btn" id="lotPlace">這裡的天氣</button>
        <button class="btn" id="lotPark">我停在這裡</button>
      </div>`,
    );
    const place = { lat: pos.lat, lng: pos.lng, title: name };
    body.querySelector("#lotGo")!.addEventListener("click", () => this.ctx.openPlace(place, "navigate"));
    body.querySelector("#lotPlace")!.addEventListener("click", () => this.ctx.openPlace(place));
    body.querySelector("#lotPark")!.addEventListener("click", () => {
      setParkedCar({ lat: pos.lat, lng: pos.lng, savedAt: Date.now(), note: name });
      this.drawCar();
      this.ctx.refreshStrip("parking");
      this.ctx.toast("已記住停車位置");
    });
    try {
      const links = await parkingCameraLinks();
      const hit = links.find((l) => l.parkingIds.includes(id));
      const el = body.querySelector("#lotCam");
      if (!el) return;
      const image = hit && safeUrl(hit.image, { httpsOnly: true });
      el.innerHTML = hit && image
        ? `<h2>停車場影像（${hit.coverage === "entrance" ? "入口" : "場內"}）</h2><div class="cam"><img src="${esc(image)}" alt="${esc(hit.parkingName)}"></div><p class="micro">${esc(hit.note)} 核對於 ${esc(hit.verifiedAt.slice(0, 10))}。<a href="${esc(hit.evidenceUrl)}" target="_blank" rel="noopener">官方直播頁</a></p>`
        : `<p class="micro">附近沒有已核對能拍到這個停車場的鏡頭（只列出人工確認過拍攝範圍的影像）。</p>`;
    } catch {
      /* camera links are optional */
    }
  }

  // ---- My car -----------------------------------------------------------

  private carAction(): void {
    const car = parkedCar();
    if (!car) {
      const me = this.ctx.me();
      const c = me ?? { lat: this.ctx.map.getCenter().lat, lng: this.ctx.map.getCenter().lng };
      setParkedCar({ lat: c.lat, lng: c.lng, savedAt: Date.now(), note: me ? "目前位置" : "地圖中心" });
      this.ctx.toast(me ? "已記住目前位置為停車位置" : "已記住地圖中心為停車位置（先按 ◎ 定位會更準）");
      this.drawCar();
      this.ctx.refreshStrip("parking");
      return;
    }
    const body = this.ctx.sheet.open(
      "car",
      "MY CAR",
      "我的停車位置",
      `<p>${esc(car.note || "停車位置")}<br><span class="mono">${formatCoord(car)}</span></p>
      <p class="muted">記錄於 ${esc(dateTime(car.savedAt))}（${esc(ago(car.savedAt))}）</p>
      <div class="actions">
        <button class="btn primary" id="carWalk">走回車位</button>
        <button class="btn" id="carShow">在地圖上看</button>
        <button class="btn danger" id="carClear">清除</button>
      </div>
      <p class="micro">只存在這台裝置。</p>`,
    );
    body.querySelector("#carWalk")!.addEventListener("click", () => this.ctx.openPlace({ lat: car.lat, lng: car.lng, title: "我的車" }, "walk"));
    body.querySelector("#carShow")!.addEventListener("click", () => {
      this.ctx.sheet.close();
      this.ctx.map.flyTo({ center: [car.lng, car.lat], zoom: 17 });
    });
    body.querySelector("#carClear")!.addEventListener("click", () => {
      setParkedCar(null);
      this.drawCar();
      this.ctx.sheet.close();
      this.ctx.refreshStrip("parking");
    });
  }

  private drawCar(): void {
    this.carMarker?.remove();
    this.carMarker = null;
    const car = parkedCar();
    if (!car || !this.active || !this.on.car) return;
    const el = document.createElement("button");
    el.className = "car-pin";
    el.setAttribute("aria-label", "我的停車位置");
    el.textContent = "車";
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      this.carAction();
    });
    this.carMarker = new Marker({ element: el }).setLngLat([car.lng, car.lat]).addTo(this.ctx.map);
  }
}

function feature(id: string, lng: number, lat: number, props: Record<string, unknown>): GeoJSON.Feature {
  return { type: "Feature", properties: { id, ...props }, geometry: { type: "Point", coordinates: [lng, lat] } };
}

const SOURCES: Record<string, string> = {
  osm: "© OpenStreetMap 貢獻者（ODbL）",
  taipei: "臺北市停車管理工程處",
  tainan: "臺南市政府交通局",
  ntpc: "新北市政府交通局",
  "ntpc-curb": "新北市政府交通局（路邊格位）",
  taoyuan: "桃園市政府交通局",
  taichung: "臺中市政府交通局",
};

function sourceName(id: string): string {
  return SOURCES[id] ?? id;
}
