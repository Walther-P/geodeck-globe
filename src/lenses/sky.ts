// 天空：aircraft, satellites, earthquakes.

import type { MapGeoJSONFeature } from "maplibre-gl";
import { hasCwa } from "../data/keys";
import { quakes as cwaQuakes } from "../data/cwa";
import {
  aircraftNear,
  compass,
  groundTrack,
  nextPass,
  satellites,
  satPosition,
  usgsQuakes,
  type Aircraft,
  type Quake,
  type Satellite,
} from "../data/sky";
import { ago, clock, dateTime } from "../lib/time";
import { distance, escapeHtml as esc, formatCoord, safeUrl } from "../lib/util";
import { EMPTY, addLayers, hideLayers, points, setData } from "../map/globe";
import { every, type AppContext, type Chip, type Lens } from "./lens";

const LAYERS = ["sky-quake-glow", "sky-quake", "sky-quake-label", "sky-track", "sky-sat", "sky-sat-label", "sky-plane", "sky-plane-label"];

export class SkyLens implements Lens {
  id = "sky" as const;
  title = "天空";
  private on = { planes: true, sats: true, starlink: false, quakes: true };
  private stops: Array<() => void> = [];
  private planes: Aircraft[] = [];
  private planesAt = 0;
  private sats: Satellite[] = [];
  private starlink: Satellite[] = [];
  private tracked: Satellite | null = null;
  private quakeRows: Quake[] = [];
  private notes = { planes: "", sats: "", quakes: "" };
  private active = false;
  private moveTimer = 0;
  private onMove = () => {
    clearTimeout(this.moveTimer);
    this.moveTimer = window.setTimeout(() => void this.loadPlanes(), 600);
  };

  constructor(private ctx: AppContext) {
    ctx.onFeatureTap(["sky-plane"], (f) => this.showPlane(f));
    ctx.onFeatureTap(["sky-sat"], (f) => this.showSat(f));
    ctx.onFeatureTap(["sky-quake"], (f) => this.showQuake(f));
  }

  chips(): Chip[] {
    return [
      { id: "planes", label: "航班", on: this.on.planes },
      { id: "sats", label: "衛星", on: this.on.sats },
      { id: "starlink", label: "Starlink", on: this.on.starlink },
      { id: "quakes", label: "地震", on: this.on.quakes },
    ];
  }

  toggleChip(id: string): void {
    const key = id as keyof typeof this.on;
    this.on[key] = !this.on[key];
    if (!this.active) return;
    if (key === "planes") this.on.planes ? void this.loadPlanes() : setData(this.ctx.map, "sky-planes", EMPTY);
    if (key === "sats" || key === "starlink") void this.loadSats();
    if (key === "quakes") this.on.quakes ? void this.loadQuakes() : setData(this.ctx.map, "sky-quakes", EMPTY);
    this.report();
  }

  activate(): void {
    this.active = true;
    const map = this.ctx.map;
    for (const id of ["sky-planes", "sky-sats", "sky-track", "sky-quakes"]) setData(map, id, EMPTY);
    addLayers(map, [
      {
        id: "sky-quake-glow",
        type: "circle",
        source: "sky-quakes",
        filter: ["<", ["get", "ageH"], 3],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["coalesce", ["get", "mag"], 3], 2.5, 10, 7, 46],
          "circle-color": "#f87171",
          "circle-opacity": 0.18,
          "circle-blur": 0.6,
        },
      },
      {
        id: "sky-quake",
        type: "circle",
        source: "sky-quakes",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["coalesce", ["get", "mag"], 3], 2.5, 3, 5, 7, 7, 15],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 1.6,
          "circle-stroke-color": ["interpolate", ["linear"], ["get", "ageH"], 0, "#f87171", 12, "#fbbf24", 48, "#6b7280"],
        },
      },
      {
        id: "sky-quake-label",
        type: "symbol",
        source: "sky-quakes",
        minzoom: 4,
        filter: [">=", ["coalesce", ["get", "mag"], 0], 4],
        layout: { "text-field": ["concat", "M", ["to-string", ["get", "mag"]]], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-offset": [0, 1.4] },
        paint: { "text-color": "#fca5a5", "text-halo-color": "#04080d", "text-halo-width": 1.2 },
      },
      {
        id: "sky-track",
        type: "line",
        source: "sky-track",
        paint: { "line-color": "#5eead4", "line-width": 1.2, "line-opacity": 0.55, "line-dasharray": [2, 3] },
      },
      {
        id: "sky-sat",
        type: "symbol",
        source: "sky-sats",
        layout: {
          "icon-image": "sat",
          "icon-size": ["case", ["get", "station"], 1, ["get", "starlink"], 0.32, 0.6],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": ["case", ["get", "starlink"], 0.55, 0.95] },
      },
      {
        id: "sky-sat-label",
        type: "symbol",
        source: "sky-sats",
        filter: ["get", "station"],
        layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 10.5, "text-offset": [0, 1.3], "text-optional": true },
        paint: { "text-color": "#5eead4", "text-halo-color": "#04080d", "text-halo-width": 1.2 },
      },
      {
        id: "sky-plane",
        type: "symbol",
        source: "sky-planes",
        layout: {
          "icon-image": "plane",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.55, 10, 0.85],
          "icon-rotate": ["coalesce", ["get", "track"], 0],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": ["case", ["get", "ground"], 0.45, 1] },
      },
      {
        id: "sky-plane-label",
        type: "symbol",
        source: "sky-planes",
        minzoom: 8,
        layout: { "text-field": ["get", "callsign"], "text-font": ["Noto Sans Regular"], "text-size": 10.5, "text-offset": [0, 1.5], "text-optional": true },
        paint: { "text-color": "#fde68a", "text-halo-color": "#04080d", "text-halo-width": 1.2 },
      },
    ]);
    map.on("moveend", this.onMove);
    void this.loadPlanes();
    void this.loadSats();
    void this.loadQuakes();
    this.stops.push(every(10000, () => void this.loadPlanes()));
    this.stops.push(every(1000, () => this.tick()));
    this.stops.push(every(120000, () => void this.loadQuakes()));
  }

  deactivate(): void {
    this.active = false;
    this.ctx.map.off("moveend", this.onMove);
    for (const stop of this.stops) stop();
    this.stops = [];
    hideLayers(this.ctx.map, LAYERS);
  }

  private report(): void {
    const parts = [this.on.planes && this.notes.planes, this.on.sats && this.notes.sats, this.on.quakes && this.notes.quakes].filter(Boolean);
    this.ctx.status("sky", parts.join(" · ") || "選擇要顯示的項目");
  }

  // ---- Aircraft ----------------------------------------------------------

  private async loadPlanes(): Promise<void> {
    if (!this.active || !this.on.planes) return;
    const map = this.ctx.map;
    if (map.getZoom() < 5) {
      this.planes = [];
      setData(map, "sky-planes", EMPTY);
      this.notes.planes = "航班：放大到區域才顯示";
      this.report();
      return;
    }
    const c = map.getCenter();
    const b = map.getBounds();
    const center = { lat: c.lat, lng: c.lng };
    const corner = { lat: b.getNorth(), lng: b.getEast() };
    const nm = distance(center, corner) / 1852;
    try {
      this.planes = await aircraftNear(center, nm * 1.1);
      this.planesAt = Date.now();
      this.notes.planes = `航班 ${this.planes.length} 架（ADS-B 社群接收，非完整）`;
      this.drawPlanes();
    } catch (e) {
      this.notes.planes = `航班暫時無法取得：${(e as Error).message}`;
    }
    this.report();
  }

  /** Move each aircraft along its track between updates so they glide. */
  private drawPlanes(): void {
    const dt = (Date.now() - this.planesAt) / 1000;
    const moved = this.planes.map((a) => {
      if (a.onGround || a.speedKt === null || a.track === null || dt > 30) return a;
      const d = (a.speedKt * 0.514444 * dt) / 111320;
      const rad = (a.track * Math.PI) / 180;
      return { ...a, lat: a.lat + d * Math.cos(rad), lng: a.lng + (d * Math.sin(rad)) / Math.cos((a.lat * Math.PI) / 180) };
    });
    setData(
      this.ctx.map,
      "sky-planes",
      points(moved, (a) => ({ id: a.id, callsign: a.callsign || a.reg || a.id.toUpperCase(), track: a.track, ground: a.onGround })),
    );
  }

  private showPlane(f: MapGeoJSONFeature): void {
    const a = this.planes.find((p) => p.id === f.properties.id);
    if (!a) return;
    const alt = a.onGround ? "地面" : a.altFt === null ? "未知" : `${Math.round(a.altFt).toLocaleString()} ft（約 ${Math.round(a.altFt * 0.3048).toLocaleString()} m）`;
    const speed = a.speedKt === null ? "未知" : `${Math.round(a.speedKt)} kt（約 ${Math.round(a.speedKt * 1.852)} km/h）`;
    this.ctx.sheet.open(
      "plane",
      "AIRCRAFT",
      a.callsign || a.reg || a.id.toUpperCase(),
      `<div class="stat-row">
        <div class="stat"><b>${esc(a.type || "—")}</b><small>機型</small></div>
        <div class="stat"><b>${a.track === null ? "—" : Math.round(a.track) + "°"}</b><small>航向</small></div>
        <div class="stat"><b>${esc(a.reg || "—")}</b><small>註冊號</small></div>
      </div>
      <p>高度：${alt}<br>地速：${speed}<br>位置：<span class="mono">${formatCoord(a)}</span></p>
      <p class="micro">ICAO ${esc(a.id.toUpperCase())} · ${a.seen === null ? "" : `位置 ${Math.round(a.seen)} 秒前收到 · `}資料：adsb.lol 社群接收站（ODbL）。不是每架飛機都會被收到，軍機與部分航班可能不顯示。</p>
      <div class="actions"><a class="btn" href="https://globe.adsb.lol/?icao=${encodeURIComponent(a.id)}" target="_blank" rel="noopener">在 adsb.lol 追蹤</a></div>`,
    );
  }

  // ---- Satellites ---------------------------------------------------------

  private async loadSats(): Promise<void> {
    if (!this.active) return;
    if (!this.on.sats && !this.on.starlink) {
      setData(this.ctx.map, "sky-sats", EMPTY);
      setData(this.ctx.map, "sky-track", EMPTY);
      this.notes.sats = "";
      return;
    }
    try {
      if (this.on.sats && !this.sats.length) {
        const [stations, visual] = await Promise.all([satellites("stations"), satellites("visual")]);
        const seen = new Set<string>();
        this.sats = [...stations.slice(0, 12).map((s) => Object.assign(s, { station: true })), ...visual].filter((s) => !seen.has(s.id) && seen.add(s.id));
        this.tracked ??= this.sats.find((s) => s.id === "25544") ?? null;
      }
      if (this.on.starlink && !this.starlink.length) this.starlink = await satellites("starlink");
      this.notes.sats = `衛星 ${(this.on.sats ? this.sats.length : 0) + (this.on.starlink ? this.starlink.length : 0)} 顆（CelesTrak 軌道推算）`;
    } catch (e) {
      this.notes.sats = `衛星軌道暫時無法取得：${(e as Error).message}`;
    }
    this.tick(true);
    this.report();
  }

  private tickCount = 0;
  private starlinkRows: Array<{ id: string; name: string; lat: number; lng: number; station: boolean; starlink: boolean }> = [];

  private tick(force = false): void {
    if (!this.active) return;
    if (this.on.planes && this.planes.length) this.drawPlanes();
    this.tickCount++;
    // Thousands of Starlinks move every 4 s to spare phone batteries.
    const starlinkDue = force || this.tickCount % 4 === 0;
    if (!this.on.sats && !(this.on.starlink && starlinkDue)) return;
    const now = new Date();
    const rows: typeof this.starlinkRows = [];
    if (this.on.sats)
      for (const s of this.sats) {
        const p = satPosition(s, now);
        if (p) rows.push({ ...p, station: !!(s as Satellite & { station?: boolean }).station, starlink: false });
      }
    if (this.on.starlink) {
      if (starlinkDue)
        this.starlinkRows = this.starlink.flatMap((s) => {
          const p = satPosition(s, now);
          return p ? [{ ...p, station: false, starlink: true }] : [];
        });
      rows.push(...this.starlinkRows);
    }
    setData(this.ctx.map, "sky-sats", points(rows, (r) => ({ id: r.id, name: r.name, station: r.station, starlink: r.starlink })));
    if (this.tracked && (force || this.tickCount % 30 === 1)) {
      const parts = groundTrack(this.tracked, now);
      setData(this.ctx.map, "sky-track", {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: parts } }],
      });
    }
  }

  private showSat(f: MapGeoJSONFeature): void {
    const id = String(f.properties.id);
    const s = this.sats.find((x) => x.id === id) ?? this.starlink.find((x) => x.id === id);
    if (!s) return;
    this.tracked = s;
    this.tickCount = 0;
    this.tick(true);
    const p = satPosition(s, new Date());
    const here = this.ctx.me();
    const pass = here ? nextPass(s, here) : null;
    const passText = !here
      ? "按右側 ◎ 定位後，可計算何時從你上空經過。"
      : pass
        ? `下次從你上空經過：${dateTime(pass.rise)} 從${compass(pass.riseAzimuth)}方升起，${clock(pass.peak)} 最高 ${Math.round(pass.maxElevation)}°，${clock(pass.set)} 落下。白天或衛星在地球陰影中時肉眼看不到。`
        : "24 小時內不會從你所在位置上空（仰角 10° 以上）經過。";
    this.ctx.sheet.open(
      "sat",
      "SATELLITE",
      s.name,
      `<div class="stat-row">
        <div class="stat"><b>${p ? Math.round(p.altKm).toLocaleString() : "—"}</b><small>高度 km</small></div>
        <div class="stat"><b>${esc(s.id)}</b><small>NORAD 編號</small></div>
        <div class="stat"><b>${p ? (p.lat >= 0 ? "N" : "S") + Math.abs(p.lat).toFixed(1) : "—"}</b><small>緯度</small></div>
      </div>
      <p>${esc(passText)}</p>
      <p class="micro">位置由 CelesTrak 公開軌道根數以 SGP4 推算，誤差約數公里；虛線是接下來約一圈的地面軌跡。</p>
      <div class="actions"><a class="btn" href="https://www.n2yo.com/satellite/?s=${encodeURIComponent(s.id)}" target="_blank" rel="noopener">N2YO 詳細資料</a></div>`,
    );
  }

  // ---- Earthquakes --------------------------------------------------------

  private async loadQuakes(): Promise<void> {
    if (!this.active || !this.on.quakes) return;
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
    this.quakeRows = rows;
    const now = Date.now();
    setData(
      this.ctx.map,
      "sky-quakes",
      points(rows, (q) => ({ id: q.id, mag: q.magnitude === null ? null : Math.round(q.magnitude * 10) / 10, ageH: q.time === null ? 99 : (now - q.time) / 3600000 })),
    );
    const failed = [usgs.status === "rejected" && "USGS", hasCwa() && cwa.status === "rejected" && "氣象署"].filter(Boolean);
    this.notes.quakes = `地震 ${rows.length} 筆（24 小時 M2.5+${hasCwa() ? "＋氣象署報告" : ""}）${failed.length ? `；${failed.join("、")}暫時無法取得` : ""}`;
    this.report();
  }

  private showQuake(f: MapGeoJSONFeature): void {
    const q = this.quakeRows.find((x) => x.id === f.properties.id);
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

  /** Latest quakes for the "now" bar. */
  recentQuakes(): Quake[] {
    return this.quakeRows;
  }
}
