// 天空：aircraft, satellites, earthquakes, launches; tap a plane or satellite
// to lock the camera onto it (see ui/track.ts).

import type { MapGeoJSONFeature } from "maplibre-gl";
import { hasCwa } from "../data/keys";
import { quakes as cwaQuakes } from "../data/cwa";
import { countdown, upcomingLaunches, type Launch } from "../data/launches";
import { passIcs, satLabel, upcomingPasses, type Pass } from "../data/passes";
import {
  aircraftNear,
  compass,
  extrapolate,
  groundTrack,
  nextPass,
  satellites,
  satMotion,
  satPosition,
  usgsQuakes,
  type Aircraft,
  type Quake,
  type Satellite,
  type SatPosition,
} from "../data/sky";
import { ago, clock, dateTime } from "../lib/time";
import { distance, escapeHtml as esc, formatCoord, safeUrl } from "../lib/util";
import { EMPTY, addLayers, hideLayers, points, setData } from "../map/globe";
import type { Detectable } from "../ui/detect";
import { Tracker, type Trackable } from "../ui/track";
import { every, type AppContext, type Chip, type Lens } from "./lens";

const LAYERS = [
  "sky-quake-glow",
  "sky-quake",
  "sky-quake-label",
  "sky-track",
  "sky-starlink",
  "sky-sat",
  "sky-sat-label",
  "sky-plane",
  "sky-plane-label",
  "sky-launch",
  "trk-trail",
  "trk-ring",
  "trk-icon",
];
const FAMOUS = ["25544", "48274", "20580"];
const PLANES_EVERY_MS = 15000;
const PLANES_RETRY_MS = 30000;

type Sat = Satellite & { station?: boolean };

export class SkyLens implements Lens {
  id = "sky" as const;
  title = "天空";
  private on = { planes: true, sats: true, starlink: false, quakes: true, launches: true };
  private stops: Array<() => void> = [];
  private planes: Aircraft[] = [];
  private planesAt = 0;
  private planeSource = "";
  /** After every network refuses us, wait before asking again. */
  private planesRetryAt = 0;
  /** The tracked aircraft's latest record, kept even if one update misses it. */
  private trackedPlane: Aircraft | null = null;
  private sats: Sat[] = [];
  private visual: Satellite[] = [];
  private starlink: Satellite[] = [];
  private satNow: SatPosition[] = [];
  /** Satellite whose next orbit is drawn as a dashed ground track. */
  private orbitOf: Satellite | null = null;
  private quakeRows: Quake[] = [];
  private launches: Launch[] = [];
  private pending: { kind: "plane" | "sat"; id: string; until: number } | null = null;
  private notes = { planes: "", sats: "", quakes: "" };
  private active = false;
  private moveTimer = 0;
  private tickCount = 0;
  readonly tracker: Tracker;
  private onMove = () => {
    clearTimeout(this.moveTimer);
    this.moveTimer = window.setTimeout(() => void this.loadPlanes(), 600);
  };

  constructor(private ctx: AppContext) {
    this.tracker = new Tracker(ctx.map, { me: () => ctx.me(), share: () => ctx.shareView() });
    this.tracker.onChange(() => {
      if (!this.active) return;
      this.drawPlanes();
      this.tick(true);
    });
    ctx.onFeatureTap(["sky-plane"], (f) => {
      const a = this.planes.find((p) => p.id === f.properties.id);
      if (a) this.trackPlane(a);
    });
    ctx.onFeatureTap(["sky-sat", "sky-starlink"], (f) => {
      const s = this.findSat(String(f.properties.id));
      if (s) this.trackSat(s);
    });
    ctx.onFeatureTap(["sky-quake"], (f) => this.showQuake(f));
    ctx.onFeatureTap(["sky-launch"], (f) => {
      const l = this.launches.find((x) => x.id === f.properties.id);
      if (l) this.launchSheet(l);
    });
  }

  chips(): Chip[] {
    return [
      { id: "planes", label: "航班", on: this.on.planes },
      { id: "sats", label: "衛星", on: this.on.sats },
      { id: "starlink", label: "Starlink", on: this.on.starlink },
      { id: "quakes", label: "地震", on: this.on.quakes },
      { id: "launches", label: "發射", on: this.on.launches },
    ];
  }

  toggleChip(id: string): void {
    const key = id as keyof typeof this.on;
    this.on[key] = !this.on[key];
    if (!this.active) return;
    if (key === "planes") this.on.planes ? void this.loadPlanes() : setData(this.ctx.map, "sky-planes", EMPTY);
    if (key === "sats" || key === "starlink") void this.loadSats();
    if (key === "quakes") this.on.quakes ? void this.loadQuakes() : setData(this.ctx.map, "sky-quakes", EMPTY);
    if (key === "launches") this.on.launches ? void this.loadLaunches() : setData(this.ctx.map, "sky-launches", EMPTY);
    this.report();
  }

  renderExtra(el: HTMLElement): void {
    el.innerHTML = `<div class="extra-actions"><button class="chip" id="skyPasses">過境預報</button><button class="chip" id="skyLaunches">近期發射</button><span class="micro">點飛機或衛星可鎖定追蹤</span></div>`;
    el.querySelector("#skyPasses")!.addEventListener("click", () => void this.openPasses());
    el.querySelector("#skyLaunches")!.addEventListener("click", () => void this.openLaunches());
  }

  activate(): void {
    this.active = true;
    const map = this.ctx.map;
    for (const id of ["sky-planes", "sky-sats", "sky-starlink", "sky-track", "sky-quakes", "sky-launches"]) setData(map, id, EMPTY);
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
        id: "sky-starlink",
        type: "circle",
        source: "sky-starlink",
        paint: { "circle-radius": 1.6, "circle-color": "#a5f3fc", "circle-opacity": 0.6 },
      },
      {
        id: "sky-sat",
        type: "symbol",
        source: "sky-sats",
        layout: {
          "icon-image": "sat",
          "icon-size": ["case", ["get", "station"], 1, 0.6],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
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
        id: "sky-launch",
        type: "symbol",
        source: "sky-launches",
        layout: {
          "icon-image": "rocket",
          "icon-size": 0.9,
          "icon-allow-overlap": true,
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 10.5,
          "text-offset": [0, 1.5],
          "text-optional": true,
        },
        paint: { "text-color": "#fda4af", "text-halo-color": "#04080d", "text-halo-width": 1.2 },
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
        paint: { "icon-opacity": ["case", ["get", "stale"], 0.35, ["get", "ground"], 0.45, 1] },
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
    for (const id of ["trk-trail", "trk-ring", "trk-icon"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
    map.on("moveend", this.onMove);
    void this.loadPlanes();
    void this.loadSats();
    void this.loadQuakes();
    void this.loadLaunches();
    this.stops.push(every(PLANES_EVERY_MS, () => void this.loadPlanes()));
    this.stops.push(every(1000, () => this.tick()));
    this.stops.push(every(120000, () => void this.loadQuakes()));
  }

  deactivate(): void {
    this.active = false;
    this.tracker.stop();
    this.ctx.map.off("moveend", this.onMove);
    for (const stop of this.stops) stop();
    this.stops = [];
    hideLayers(this.ctx.map, LAYERS);
  }

  /** From a shared link: lock onto this target as soon as it shows up. */
  trackWhenSeen(kind: "plane" | "sat", id: string): void {
    this.pending = { kind, id, until: Date.now() + 60000 };
  }

  trackedRef(): { kind: "plane" | "sat"; id: string } | null {
    const t = this.tracker.target;
    return t ? { kind: t.kind, id: t.id } : null;
  }

  trackedKey(): string | null {
    const t = this.tracker.target;
    return t ? `${t.kind}:${t.id}` : null;
  }

  /** What the detection HUD boxes. */
  objects(): Detectable[] {
    if (!this.active) return [];
    const now = Date.now();
    const out: Detectable[] = [];
    if (this.on.planes)
      for (const a of this.planes) {
        const rec = this.trackedPlane?.id === a.id ? this.trackedPlane : a;
        const e = extrapolate(rec, now, this.planesAt);
        const alt = rec.onGround ? "GND" : rec.altFt === null ? "ALT —" : `${Math.round(rec.altFt).toLocaleString()} ft`;
        out.push({ id: `plane:${a.id}`, kind: "plane", lat: e.lat, lng: e.lng, label: rec.callsign || rec.reg || a.id.toUpperCase(), sub: `${alt}${rec.speedKt === null ? "" : ` · ${Math.round(rec.speedKt)} kt`}` });
      }
    if (this.on.sats) for (const s of this.satNow) out.push({ id: `sat:${s.id}`, kind: "sat", lat: s.lat, lng: s.lng, label: satLabel(s).slice(0, 18), sub: `${Math.round(s.altKm).toLocaleString()} km` });
    return out;
  }

  private report(): void {
    const parts = [this.on.planes && this.notes.planes, this.on.sats && this.notes.sats, this.on.quakes && this.notes.quakes].filter(Boolean);
    this.ctx.status("sky", parts.join(" · ") || "選擇要顯示的項目");
  }

  // ---- Aircraft ----------------------------------------------------------

  private async loadPlanes(): Promise<void> {
    if (!this.active || !this.on.planes) return;
    const map = this.ctx.map;
    if (map.getZoom() < 5 && !this.tracker.target) {
      this.planes = [];
      setData(map, "sky-planes", EMPTY);
      this.notes.planes = "航班：放大到區域才顯示";
      this.report();
      return;
    }
    if (Date.now() < this.planesRetryAt) return;
    const c = map.getCenter();
    const b = map.getBounds();
    const center = { lat: c.lat, lng: c.lng };
    const corner = { lat: b.getNorth(), lng: b.getEast() };
    const nm = distance(center, corner) / 1852;
    try {
      const { aircraft, source } = await aircraftNear(center, Math.max(40, nm * 1.1));
      this.planes = aircraft;
      this.planeSource = source;
      this.planesAt = Date.now();
      this.planesRetryAt = 0;
      if (this.trackedPlane) this.trackedPlane = aircraft.find((a) => a.id === this.trackedPlane!.id) ?? this.trackedPlane;
      const newest = Math.max(0, ...aircraft.map((a) => a.at ?? 0));
      const age = newest ? (Date.now() - newest) / 1000 : 0;
      // The relay may hand back its last good copy when the network refuses it.
      this.notes.planes = `航班 ${aircraft.length} 架（${source}${age > 60 ? `，${ago(newest)}的資料，來源暫時限流` : ""}；社群 ADS-B 接收，非完整）`;
      this.drawPlanes();
      this.resolvePending();
    } catch {
      this.planesRetryAt = Date.now() + PLANES_RETRY_MS;
      this.notes.planes = this.planes.length
        ? `航班更新暫停（來源限流），顯示 ${ago(this.planesAt)}的位置並推算移動，30 秒後重試`
        : "航班：資料來源暫時拒絕本站連線，30 秒後自動重試（衛星、地震不受影響）";
    }
    this.report();
  }

  /** Carry each aircraft along its track from when it was heard, so they glide. */
  private drawPlanes(): void {
    if (!this.active) return;
    const now = Date.now();
    const tracked = this.tracker.target?.kind === "plane" ? this.tracker.target.id : null;
    setData(
      this.ctx.map,
      "sky-planes",
      points(
        this.planes.filter((a) => a.id !== tracked).map((a) => ({ ...a, ...extrapolate(a, now, this.planesAt) })),
        (a) => ({ id: a.id, callsign: a.callsign || a.reg || a.id.toUpperCase(), track: a.track, ground: a.onGround, stale: a.stale }),
      ),
    );
  }

  private trackPlane(a: Aircraft, cockpit = false): void {
    this.trackedPlane = a;
    const target: Trackable = {
      kind: "plane",
      id: a.id,
      label: a.callsign || a.reg || a.id.toUpperCase(),
      sub: [a.type, a.reg].filter(Boolean).join(" · ") || `ICAO ${a.id.toUpperCase()}`,
      now: (t) => {
        const p = this.trackedPlane;
        if (!p) return null;
        const e = extrapolate(p, t, this.planesAt);
        return {
          lat: e.lat,
          lng: e.lng,
          heading: p.track,
          altM: p.onGround ? 0 : p.altFt === null ? null : p.altFt * 0.3048,
          speedKmh: p.speedKt === null ? null : p.speedKt * 1.852,
          stale: e.stale,
        };
      },
      details: () => this.planeSheet(this.trackedPlane ?? a),
    };
    this.tracker.track(target, { cockpit });
  }

  private planeSheet(a: Aircraft): void {
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
      <p class="micro">ICAO ${esc(a.id.toUpperCase())} · ${a.at ? `位置 ${esc(ago(a.at))}收到 · ` : ""}資料：${esc(this.planeSource)} 社群 ADS-B 接收站。不是每架飛機都會被收到，軍機與部分航班可能不顯示。</p>
      <div class="actions"><a class="btn" href="https://globe.adsb.lol/?icao=${encodeURIComponent(a.id)}" target="_blank" rel="noopener">在 adsb.lol 看航跡</a></div>`,
    );
  }

  // ---- Satellites ---------------------------------------------------------

  private findSat(id: string): Satellite | undefined {
    return this.sats.find((x) => x.id === id) ?? this.visual.find((x) => x.id === id) ?? this.starlink.find((x) => x.id === id);
  }

  private async ensureSats(): Promise<void> {
    if (this.sats.length) return;
    const [stations, visual] = await Promise.all([satellites("stations"), satellites("visual")]);
    const seen = new Set<string>();
    this.visual = visual;
    this.sats = [...stations.slice(0, 12).map((s) => Object.assign(s, { station: true })), ...visual].filter((s) => !seen.has(s.id) && seen.add(s.id));
    this.orbitOf ??= this.sats.find((s) => s.id === "25544") ?? null;
  }

  private async loadSats(): Promise<void> {
    if (!this.active) return;
    if (!this.on.sats) setData(this.ctx.map, "sky-sats", EMPTY);
    if (!this.on.starlink) setData(this.ctx.map, "sky-starlink", EMPTY);
    if (!this.on.sats && !this.on.starlink) {
      setData(this.ctx.map, "sky-track", EMPTY);
      this.notes.sats = "";
      return;
    }
    try {
      if (this.on.sats) await this.ensureSats();
      if (this.on.starlink && !this.starlink.length) this.starlink = await satellites("starlink");
      this.notes.sats = `衛星 ${(this.on.sats ? this.sats.length : 0) + (this.on.starlink ? this.starlink.length : 0)} 顆（CelesTrak 軌道推算）`;
      this.resolvePending();
    } catch (e) {
      this.notes.sats = `衛星軌道暫時無法取得：${(e as Error).message}`;
    }
    this.tick(true);
    this.report();
  }

  private tick(force = false): void {
    if (!this.active) return;
    if (this.on.planes && this.planes.length) this.drawPlanes();
    this.tickCount++;
    const now = new Date();
    const tracked = this.tracker.target?.kind === "sat" ? this.tracker.target.id : null;
    if (this.on.sats) {
      this.satNow = this.sats.flatMap((s) => {
        const p = satPosition(s, now);
        return p ? [{ ...p, station: !!(s as Sat).station }] : [];
      });
      setData(
        this.ctx.map,
        "sky-sats",
        points(
          this.satNow.filter((p) => p.id !== tracked),
          (r) => ({ id: r.id, name: satLabel(r), station: (r as SatPosition & { station: boolean }).station }),
        ),
      );
    } else this.satNow = [];
    // Thousands of Starlinks move every 4 s, as plain dots, to spare batteries.
    if (this.on.starlink && (force || this.tickCount % 4 === 0))
      setData(
        this.ctx.map,
        "sky-starlink",
        points(
          this.starlink.flatMap((s) => {
            const p = satPosition(s, now);
            return p ? [p] : [];
          }),
          (r) => ({ id: r.id }),
        ),
      );
    if (this.orbitOf && this.on.sats && (force || this.tickCount % 30 === 1)) {
      const parts = groundTrack(this.orbitOf, now);
      setData(this.ctx.map, "sky-track", {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: parts } }],
      });
    }
    if (this.on.launches && this.launches.length && (force || this.tickCount % 60 === 0)) this.drawLaunches();
    if (this.pending && Date.now() > this.pending.until) {
      this.ctx.toast("連結裡追蹤的目標目前不在範圍內");
      this.pending = null;
    }
  }

  private trackSat(s: Satellite): void {
    this.orbitOf = s;
    this.tick(true);
    let past: { at: number; path: Array<[number, number]> } = { at: 0, path: [] };
    const target: Trackable = {
      kind: "sat",
      id: s.id,
      label: satLabel(s),
      sub: `NORAD ${s.id}`,
      now: (t) => {
        const m = satMotion(s, new Date(t));
        return m ? { lat: m.lat, lng: m.lng, heading: m.heading, altM: m.altKm * 1000, speedKmh: m.speedKmS * 3600, stale: false } : null;
      },
      // The last 12 minutes of its ground track, recomputed every 2 s.
      history: (t) => {
        if (t - past.at > 2000) {
          const path: Array<[number, number]> = [];
          for (let m = -12 * 60; m < 0; m += 30) {
            const p = satPosition(s, new Date(t + m * 1000));
            if (p) path.push([p.lng, p.lat]);
          }
          past = { at: t, path };
        }
        return past.path;
      },
      details: () => this.satSheet(s),
    };
    this.tracker.track(target);
  }

  private satSheet(s: Satellite): void {
    const p = satPosition(s, new Date());
    const here = this.ctx.me();
    const pass = here ? nextPass(s, here) : null;
    const passText = !here
      ? "按右側 ◎ 定位後，可計算何時從你上空經過。"
      : pass
        ? `下次從你上空經過：${dateTime(pass.rise)} 從${compass(pass.riseAzimuth)}方升起，${clock(pass.peak)} 最高 ${Math.round(pass.maxElevation)}°，${clock(pass.set)} 落下。`
        : "24 小時內不會從你所在位置上空（仰角 10° 以上）經過。";
    const body = this.ctx.sheet.open(
      "sat",
      "SATELLITE",
      satLabel(s),
      `<div class="stat-row">
        <div class="stat"><b>${p ? Math.round(p.altKm).toLocaleString() : "—"}</b><small>高度 km</small></div>
        <div class="stat"><b>${esc(s.id)}</b><small>NORAD 編號</small></div>
        <div class="stat"><b>${p ? (p.lat >= 0 ? "N" : "S") + Math.abs(p.lat).toFixed(1) : "—"}</b><small>緯度</small></div>
      </div>
      <p>${esc(passText)}</p>
      <p class="micro">位置由 CelesTrak 公開軌道根數以 SGP4 推算，誤差約數公里；虛線是接下來約一圈的地面軌跡，紅線是剛飛過的路徑。</p>
      <div class="actions"><button class="btn primary" id="satPasses">過境預報</button><a class="btn" href="https://www.n2yo.com/satellite/?s=${encodeURIComponent(s.id)}" target="_blank" rel="noopener">N2YO 詳細資料</a></div>`,
    );
    body.querySelector("#satPasses")!.addEventListener("click", () => void this.openPasses());
  }

  private resolvePending(): void {
    const want = this.pending;
    if (!want) return;
    if (want.kind === "plane") {
      const a = this.planes.find((p) => p.id === want.id);
      if (a) {
        this.pending = null;
        this.trackPlane(a);
      }
    } else {
      const s = this.findSat(want.id);
      if (s) {
        this.pending = null;
        this.trackSat(s);
      }
    }
  }

  // ---- Passes -------------------------------------------------------------

  private async openPasses(): Promise<void> {
    const here = this.ctx.me();
    const c = this.ctx.map.getCenter();
    const observer = here ?? { lat: c.lat, lng: c.lng };
    const body = this.ctx.sheet.open("passes", "SATELLITE PASSES", "衛星過境預報", `<p class="muted">計算中…</p>`);
    let passes: Pass[];
    try {
      await this.ensureSats();
      const famous = FAMOUS.flatMap((id) => this.sats.filter((s) => s.id === id));
      passes = (await upcomingPasses(famous, this.visual, observer)).slice(0, 24);
    } catch (e) {
      body.innerHTML = `<p class="bad">衛星軌道暫時無法取得：${esc((e as Error).message)}</p>`;
      return;
    }
    if (this.ctx.sheet.kind !== "passes") return;
    const basis = here ? "以你的位置計算" : "以地圖中心計算（按右側 ◎ 定位會更準）";
    body.innerHTML = `<p class="muted">${basis}。48 小時內國際太空站、天宮、哈伯的每次過境，加上其他亮衛星的高仰角肉眼可見過境。</p>
      ${
        passes.length
          ? `<ul class="list passes">${passes
              .map(
                (p, i) => `<li><div><b>${esc(p.name)}</b> ${p.visible ? '<span class="badge live">肉眼可見</span>' : '<span class="badge">看不到</span>'}
                <small>${esc(dayLabel(p.rise))} ${esc(clock(p.rise))}–${esc(clock(p.set))} · ${compass(p.riseAzimuth)}→${compass(p.setAzimuth)} · 最高 ${Math.round(p.maxElevation)}°</small></div>
                <button class="btn" data-cal="${i}">行事曆</button><button class="btn" data-trk="${i}">追蹤</button></li>`,
              )
              .join("")}</ul>`
          : `<p>這段時間沒有高於地平線 10° 的過境。</p>`
      }
      <p class="micro">「肉眼可見」＝天色夠暗而且衛星還照得到太陽，仰角越高越亮。「看不到」是白天或衛星在地球陰影裡。時間誤差約一分鐘內。</p>`;
    body.querySelectorAll<HTMLElement>("[data-cal]").forEach((b) =>
      b.addEventListener("click", () => {
        const p = passes[Number(b.dataset.cal)];
        const text = `${dayLabel(p.rise)} ${clock(p.rise)} 從${compass(p.riseAzimuth)}方升起，${clock(p.peak)} 最高 ${Math.round(p.maxElevation)}°，${clock(p.set)} 從${compass(p.setAzimuth)}方落下。${p.visible ? "天色夠暗，可用肉眼看到。" : ""}（百眼）`;
        const blob = new Blob([passIcs(p, text)], { type: "text/calendar" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${p.name}-${new Date(p.rise).toISOString().slice(0, 16).replace(/[-:T]/g, "")}.ics`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }),
    );
    body.querySelectorAll<HTMLElement>("[data-trk]").forEach((b) =>
      b.addEventListener("click", () => {
        const s = this.findSat(passes[Number(b.dataset.trk)].id);
        if (!s) return;
        this.ctx.sheet.close();
        if (!this.on.sats) this.toggleChip("sats");
        this.trackSat(s);
      }),
    );
  }

  // ---- Launches -----------------------------------------------------------

  private async loadLaunches(): Promise<void> {
    if (!this.active || !this.on.launches) return;
    try {
      this.launches = await upcomingLaunches();
      this.drawLaunches();
    } catch {
      /* launches are a nice-to-have; the list says when it cannot load */
    }
  }

  private drawLaunches(): void {
    const now = Date.now();
    setData(
      this.ctx.map,
      "sky-launches",
      points(
        this.launches.filter((l) => l.lat !== null && l.lng !== null).map((l) => ({ ...l, lat: l.lat!, lng: l.lng! })),
        (l) => ({ id: l.id, label: countdown(l.net, now) }),
      ),
    );
  }

  private async openLaunches(): Promise<void> {
    const body = this.ctx.sheet.open("launches", "LAUNCHES", "近期火箭發射", `<p class="muted">載入中…</p>`);
    try {
      this.launches = await upcomingLaunches();
    } catch (e) {
      body.innerHTML = `<p class="bad">發射時程暫時無法取得：${esc((e as Error).message)}</p>`;
      return;
    }
    if (this.ctx.sheet.kind !== "launches") return;
    const now = Date.now();
    body.innerHTML = `<ul class="list">${this.launches
      .map(
        (l, i) => `<li><div><b>${esc(l.name)}</b> <span class="badge${l.status === "Go" ? " live" : ""}">${esc(l.status || "?")}</span>
        <small>${esc(countdown(l.net, now))}${l.net ? ` · ${esc(dateTime(l.net))}` : ""}<br>${esc([l.provider, l.location].filter(Boolean).join(" · "))}</small></div>
        ${l.lat !== null ? `<button class="btn" data-go="${i}">地圖</button>` : ""}</li>`,
      )
      .join("")}</ul>
      <p class="micro">資料：The Space Devs Launch Library 2。Go＝準備發射，TBC／TBD＝時間未確定。時間為當地時間，常會延期。</p>`;
    body.querySelectorAll<HTMLElement>("[data-go]").forEach((b) =>
      b.addEventListener("click", () => {
        const l = this.launches[Number(b.dataset.go)];
        this.ctx.sheet.close();
        if (!this.on.launches) this.toggleChip("launches");
        this.ctx.map.flyTo({ center: [l.lng!, l.lat!], zoom: 7, duration: 2500 });
      }),
    );
  }

  private launchSheet(l: Launch): void {
    const link = safeUrl(l.url, { httpsOnly: true });
    this.ctx.sheet.open(
      "launch",
      "LAUNCH",
      l.name,
      `<div class="stat-row">
        <div class="stat"><b>${esc(countdown(l.net))}</b><small>${l.net ? esc(dateTime(l.net)) : "時間未定"}</small></div>
        <div class="stat"><b>${esc(l.status || "?")}</b><small>${esc(l.statusName || "狀態")}</small></div>
      </div>
      <p>${esc(l.provider)}<br>${esc(l.pad)}${l.location ? `，${esc(l.location)}` : ""}</p>
      ${l.mission ? `<p class="muted">${esc(l.mission)}</p>` : ""}
      <p class="micro">資料：The Space Devs Launch Library 2。發射時間常會延後。</p>
      ${link ? `<div class="actions"><a class="btn" href="${esc(link)}" target="_blank" rel="noopener">直播／影片</a></div>` : ""}`,
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

/** 今天／今晚／明天／後天 or the date. */
function dayLabel(t: number, now = Date.now()): string {
  const d = new Date(t);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((d.getTime() - today.getTime()) / 86400000);
  if (days === 0) return d.getHours() >= 18 ? "今晚" : "今天";
  if (days === 1) return d.getHours() >= 18 ? "明晚" : "明天";
  if (days === 2) return "後天";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
