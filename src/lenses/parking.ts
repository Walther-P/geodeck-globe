// 停車：island-wide parking catalog, live counts (TDX, own key), my car.

import { Marker, type MapGeoJSONFeature } from "maplibre-gl";
import { hasTdx } from "../data/keys";
import { osmName, osmRef, osmUrl, parkingDetails } from "../data/osmparking";
import { catalogLots, catalogSummary, kindLabel, liveStatus, mergeLots, type CatalogLot } from "../data/parking";
import { parkedCar, setParkedCar } from "../data/places";
import { parkingCameraLinks } from "../data/roads";
import { citiesAt } from "../data/taiwan";
import { liveCurbs, liveLots, type LiveLot } from "../data/tdx";
import { FeedError } from "../lib/net";
import { ago, dateTime } from "../lib/time";
import { escapeHtml as esc, formatCoord, safeUrl } from "../lib/util";
import { EMPTY, addLayers, hideLayers, setData } from "../map/globe";
import { every, viewBounds, type AppContext, type Chip, type Lens } from "./lens";

const LAYERS = ["pk-cluster", "pk-cluster-count", "pk-dot", "pk-sign", "pk-summary", "pk-summary-label", "pk-osm", "pk-osm-name"];

export class ParkingLens implements Lens {
  id = "parking" as const;
  title = "停車";
  private on = { lots: true, curb: true, live: true, car: true };
  private catalog: CatalogLot[] = [];
  /** Keyed "lot:Tainan" / "curb:Tainan". */
  private live = new Map<string, { at: number; lots: LiveLot[] }>();
  /** Cities that publish no kerbside counts at all. */
  private noCurbFeed = new Set<string>();
  private liveErrors: string[] = [];
  private stops: Array<() => void> = [];
  private active = false;
  private seq = 0;
  private moveTimer = 0;
  private carMarker: Marker | null = null;
  /** Outside the Taiwan catalog: parking comes from the basemap's OpenStreetMap tiles. */
  private world = false;
  private onMove = () => {
    clearTimeout(this.moveTimer);
    this.moveTimer = window.setTimeout(() => void this.refresh(), 450);
  };

  constructor(private ctx: AppContext) {
    ctx.onFeatureTap(["pk-sign", "pk-dot"], (f) => this.showLot(f));
    ctx.onFeatureTap(["pk-osm"], (f) => void this.showOsmLot(f));
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
    if (this.world) {
      el.innerHTML = `<p class="legend"><span class="lg-lot">P</span>停車場（OpenStreetMap 全球資料）<b class="lg-old">?</b>沒有即時格數 · 點開看收費、營業時間與總車位</p>`;
      return;
    }
    el.innerHTML = `<p class="legend"><span class="lg-lot">P</span>停車場 <span class="lg-curb">路</span>路邊 <b class="lg-ok">12</b>剩餘格數 <b class="lg-low">3</b>快滿 <b class="lg-full">滿</b> <b class="lg-old">?</b>沒有即時資料或超過 5 分鐘</p>`;
  }

  activate(): void {
    this.active = true;
    // Individual signs (with their counts) from street level, zoom 13 up.
    setData(this.ctx.map, "pk", EMPTY, { radius: 40, maxZoom: 12 });
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
      const summary = await catalogSummary(view);
      if (seq !== this.seq) return;
      const world = !summary.length;
      if (world !== this.world) {
        this.world = world;
        this.ctx.refreshStrip("parking");
      }
      if (this.world) {
        setData(map, "pk", EMPTY);
        setData(map, "pk-summary", EMPTY);
        this.drawLayers();
        this.reportWorld(seq);
        return;
      }
      if (zoom < 11) {
        setData(map, "pk", EMPTY);
        setData(map, "pk-summary", {
          type: "FeatureCollection",
          features: summary.map((s) => ({ type: "Feature", properties: { count: s.count }, geometry: { type: "Point", coordinates: [s.lng, s.lat] } })),
        });
        this.drawLayers();
        const total = summary.reduce((n, s) => n + s.count, 0);
        this.ctx.status("parking", `此範圍 ${total.toLocaleString()} 處停車位置 · 放大看個別停車場`);
        return;
      }
      setData(map, "pk-summary", EMPTY);
      this.catalog = await catalogLots(view);
      if (seq !== this.seq) return;
      const wantLive = this.on.live && hasTdx();
      const feeds = wantLive ? this.feedsFor(view, zoom) : [];
      // Draw the catalog and the last counts we have right away; TDX may take
      // a while when the key's per-minute budget is used up.
      this.draw(feeds.flatMap((f) => this.live.get(f.key)?.lots ?? []), wantLive ? "pending" : "off");
      if (!wantLive) return;
      const live = await this.fetchLive(feeds, refreshLive);
      if (seq !== this.seq) return;
      this.draw(live, "done");
    } catch (e) {
      this.ctx.status("parking", `停車資料暫時無法讀取：${(e as Error).message}`, "bad");
    }
  }

  private draw(live: LiveLot[], phase: "off" | "pending" | "done"): void {
    const merged = mergeLots(this.catalog, live);
    const now = Date.now();
    const features: GeoJSON.Feature[] = [];
    for (const p of merged.catalog) {
      if (p.kind === "lot" ? !this.on.lots : !this.on.curb) continue;
      // Every sign carries a count; "?" when nothing live says how many are free.
      features.push(feature(p.id, p.lng, p.lat, { kind: p.kind, count: "?", state: "none", available: -1 }));
    }
    for (const l of merged.live) {
      if (l.kind === "lot" ? !this.on.lots : !this.on.curb) continue;
      const s = liveStatus(l, now);
      // "?" means this place reports counts but the latest one is too old to trust.
      features.push(feature(l.id, l.lng, l.lat, { kind: l.kind, count: s.label, state: s.state, available: l.available ?? -1 }));
    }
    setData(this.ctx.map, "pk", { type: "FeatureCollection", features });
    this.drawLayers();
    const parts = [`${features.length.toLocaleString()} 處`];
    if (phase === "off") parts.push(hasTdx() ? "即時車位已關閉" : "即時車位需 TDX 金鑰");
    else {
      const counted = (["lot", "curb"] as const).flatMap((kind) => {
        const rows = merged.live.filter((l) => l.kind === kind);
        const fresh = rows.filter((l) => ["fresh", "full"].includes(liveStatus(l, now).state)).length;
        return rows.length ? [`${kind === "lot" ? "停車場" : "路段"} ${fresh}/${rows.length}`] : [];
      });
      if (counted.length) parts.push(`即時：${counted.join("、")} 有 5 分鐘內資料`);
      parts.push(phase === "pending" ? "正在更新即時車位…" : counted.length ? "" : "此區沒有 TDX 即時車位");
    }
    const errors = phase === "done" ? this.liveErrors : [];
    if (errors.length) parts.push(errors.join("；"));
    this.ctx.status("parking", parts.filter(Boolean).join(" · "), errors.length ? "warn" : undefined);
  }

  private feedsFor(view: ReturnType<typeof viewBounds>, zoom: number): Array<{ key: string; code: string; name: string; kind: LiveLot["kind"] }> {
    const center = { lat: (view.north + view.south) / 2, lng: (view.east + view.west) / 2 };
    const feeds: Array<{ key: string; code: string; name: string; kind: LiveLot["kind"] }> = [];
    // Only the city under the map centre: each city is two calls a minute.
    for (const c of citiesAt(center).slice(0, 1)) {
      if (this.on.lots) feeds.push({ key: `lot:${c.code}`, code: c.code, name: c.name, kind: "lot" });
      // Kerbside counts only help street by street, and each city is one more TDX call.
      if (this.on.curb && zoom >= 13 && !this.noCurbFeed.has(c.code)) feeds.push({ key: `curb:${c.code}`, code: c.code, name: c.name, kind: "curb" });
    }
    return feeds;
  }

  private async fetchLive(feeds: ReturnType<ParkingLens["feedsFor"]>, force: boolean): Promise<LiveLot[]> {
    this.liveErrors = [];
    const out: LiveLot[] = [];
    await Promise.all(
      feeds.map(async (f) => {
        const cached = this.live.get(f.key);
        if (cached && !force && Date.now() - cached.at < 60000) {
          out.push(...cached.lots);
          return;
        }
        try {
          const lots = await (f.kind === "lot" ? liveLots : liveCurbs)(f.code);
          // No segment with counts: don't spend a call on this city every minute.
          if (f.kind === "curb" && !lots.length) this.noCurbFeed.add(f.code);
          this.live.set(f.key, { at: Date.now(), lots });
          out.push(...lots);
        } catch (e) {
          // Not every city publishes kerbside counts: leave those quietly to the catalog.
          if (f.kind === "curb" && e instanceof FeedError && (e.status === 404 || e.status === 400)) {
            this.noCurbFeed.add(f.code);
            return;
          }
          if (cached) out.push(...cached.lots);
          this.liveErrors.push(`${f.name}${f.kind === "lot" ? "停車場" : "路邊"}即時：${(e as Error).message}`);
        }
      }),
    );
    return out;
  }

  /** Status for the OpenStreetMap layer: how many lots are on screen once the tiles are in. */
  private reportWorld(seq: number): void {
    const map = this.ctx.map;
    if (!this.on.lots) return this.ctx.status("parking", "停車場已關閉");
    if (map.getZoom() < 14) return this.ctx.status("parking", "放大到街道會顯示這裡的停車場（OpenStreetMap 全球資料，沒有即時格數）");
    this.ctx.status("parking", "讀取這附近的停車場…");
    map.once("idle", () => {
      if (seq !== this.seq || !this.active || !this.world) return;
      const n = new Set(map.queryRenderedFeatures({ layers: ["pk-osm"] }).map((f) => f.id)).size;
      this.ctx.status(
        "parking",
        n ? `畫面中 ${n} 處停車場（OpenStreetMap，沒有即時格數）· 點 P 看收費與營業時間` : "這附近 OpenStreetMap 沒有標記停車場（或地圖資料暫時載入失敗）",
      );
    });
    map.triggerRepaint();
  }

  private drawLayers(): void {
    const map = this.ctx.map;
    // Parking anywhere else in the world, straight from the basemap's vector tiles.
    if (map.getSource("omt") && !map.getLayer("pk-osm"))
      map.addLayer({
        id: "pk-osm",
        type: "symbol",
        source: "omt",
        "source-layer": "poi",
        minzoom: 14,
        filter: ["==", ["get", "class"], "parking"],
        layout: {
          "icon-image": "p-lot",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 14, 0.6, 17, 0.9],
          "icon-padding": 1,
          // No live counts abroad: the sign says so, like a stale one at home.
          "text-field": "?",
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 14, 12, 17, 14],
          "text-anchor": "left",
          "text-offset": [0.95, 0],
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#94a3b8", "text-halo-color": "#04080d", "text-halo-width": 2 },
      });
    if (map.getSource("omt") && !map.getLayer("pk-osm-name"))
      map.addLayer({
        id: "pk-osm-name",
        type: "symbol",
        source: "omt",
        "source-layer": "poi",
        minzoom: 16,
        filter: ["==", ["get", "class"], "parking"],
        layout: {
          "text-field": ["coalesce", ["get", "name:zh-Hant"], ["get", "name"], ""],
          "text-font": ["Noto Sans Regular"],
          "text-size": 10.5,
          "text-anchor": "top",
          "text-offset": [0, 1.1],
          "text-max-width": 8,
          "text-optional": true,
        },
        paint: { "text-color": "#93c5fd", "text-halo-color": "#04080d", "text-halo-width": 1.2 },
      });
    for (const id of ["pk-osm", "pk-osm-name"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", this.world && this.on.lots ? "visible" : "none");
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
          // The count belongs to its sign: never dropped to make room.
          "text-allow-overlap": true,
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
    if (live?.kind === "curb") rows.push(`<p class="muted">路邊停車路段，格數是整段合計</p>`);
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
    const source = live ? `TDX 即時${live.kind === "curb" ? "路邊格位" : "車位"}（${live.city}，用你自己的金鑰）` : sourceName(lot!.source);
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
    this.wireLotActions(body, { lat: pos.lat, lng: pos.lng, title: name });
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

  /** A lot from the OpenStreetMap layer: the tile gives name and place; the OSM API the rest. */
  private async showOsmLot(f: MapGeoJSONFeature): Promise<void> {
    const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
    const ref = osmRef(f.id);
    const title = osmName(f.properties) || "停車場";
    const body = this.ctx.sheet.open(
      "lot",
      "PARKING",
      title,
      `<div id="osmLot"><p class="muted">讀取停車場資料…</p></div>
      <p class="micro">資料：© OpenStreetMap 貢獻者（ODbL）${ref ? ` · <a href="${esc(osmUrl(ref))}" target="_blank" rel="noopener">原始資料</a>` : ""}。這裡沒有即時車位；收費與開放時間以現場公告為準。</p>
      <div class="actions">
        <button class="btn primary" id="lotGo">導航到這裡</button>
        <button class="btn" id="lotPlace">這裡的天氣</button>
        <button class="btn" id="lotPark">我停在這裡</button>
      </div>`,
    );
    this.wireLotActions(body, { lat, lng, title });
    const el = body.querySelector("#osmLot")!;
    if (!ref) {
      el.innerHTML = `<p class="muted">停車場 · 沒有更多資料</p>`;
      return;
    }
    try {
      const d = await parkingDetails(ref);
      if (!d) {
        el.innerHTML = `<p class="muted">停車場 · 這筆資料已更新或移除</p>`;
        return;
      }
      const rows: string[] = [];
      if (d.closed) rows.push(`<p><span class="badge full">不對外開放</span> 標記為私人停車場</p>`);
      rows.push(`<p class="muted">${esc(kindLabel(d.kind))} · 沒有即時車位</p>`);
      if (d.total) rows.push(`<p>總車位：${d.total}</p>`);
      if (d.rate) rows.push(`<p>費率：${esc(d.rate)}</p>`);
      if (d.hours) rows.push(`<p>開放時間：<span class="mono">${esc(d.hours)}</span></p>`);
      if (d.address) rows.push(`<p>地址：${esc(d.address)}</p>`);
      if (d.notes.length) rows.push(`<p class="muted">${esc(d.notes.join("；"))}</p>`);
      el.innerHTML = rows.join("");
    } catch {
      el.innerHTML = `<p class="muted">停車場 · 暫時讀不到收費與營業時間</p>`;
    }
  }

  private wireLotActions(body: HTMLElement, place: { lat: number; lng: number; title: string }): void {
    body.querySelector("#lotGo")!.addEventListener("click", () => this.ctx.openPlace(place, "navigate"));
    body.querySelector("#lotPlace")!.addEventListener("click", () => this.ctx.openPlace(place));
    body.querySelector("#lotPark")!.addEventListener("click", () => {
      setParkedCar({ lat: place.lat, lng: place.lng, savedAt: Date.now(), note: place.title });
      this.drawCar();
      this.ctx.refreshStrip("parking");
      this.ctx.toast("已記住停車位置");
    });
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
