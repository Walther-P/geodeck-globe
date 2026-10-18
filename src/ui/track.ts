// Click-to-track: the camera locks onto an aircraft or satellite and glides
// with it, a fading trail follows behind, and a telemetry panel shows its
// live numbers. "駕駛艙" tilts the camera to ride along its heading.

import type { GeoJSONSource, MapLibreEvent } from "maplibre-gl";
import { distance, escapeHtml as esc, formatDistance, type Point } from "../lib/util";
import type { GlobeMap } from "../map/globe";
import { $ } from "./dom";

export interface Telemetry {
  lat: number;
  lng: number;
  heading: number | null;
  altM: number | null;
  speedKmh: number | null;
  /** The last real position is too old to trust. */
  stale: boolean;
}

export interface Trackable {
  kind: "plane" | "sat";
  id: string;
  label: string;
  sub: string;
  now(t: number): Telemetry | null;
  /** A known past path (oldest first); otherwise the tracker records one. */
  history?(t: number): Array<[number, number]>;
  details(): void;
}

const FRAME_MS = 33;
const TRAIL_MS = 6 * 60000;
const COLORS = { plane: "#f87171", sat: "#5eead4" };

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const angleLerp = (a: number, b: number, k: number) => a + ((((b - a) % 360) + 540) % 360 - 180) * k;

export class Tracker {
  target: Trackable | null = null;
  private follow = true;
  private cockpit = false;
  private easingUntil = 0;
  private raf = 0;
  private lastFrame = 0;
  private lastHud = 0;
  private shown: Telemetry | null = null;
  private bearing = 0;
  private recorded: Array<[number, number, number]> = [];
  private listeners: Array<() => void> = [];
  private hud = $("targetHud");

  constructor(
    private map: GlobeMap,
    private opts: { me(): Point | null; share(): void },
  ) {
    const userMoved = (e: MapLibreEvent<MouseEvent | TouchEvent | WheelEvent | undefined>) => {
      const ev = e.originalEvent as TouchEvent | undefined;
      // A pinch zooms around the target; only a one-finger drag lets go of it.
      if (!this.target || !ev || (ev.touches && ev.touches.length > 1)) return;
      this.follow = false;
      this.renderHud(true);
    };
    map.on("dragstart", userMoved);
    const userTurned = (e: MapLibreEvent<MouseEvent | TouchEvent | undefined>) => {
      if (this.target && this.cockpit && e.originalEvent) this.setCockpit(false, false);
    };
    map.on("rotatestart", userTurned);
    map.on("pitchstart", userTurned);
    this.hud.addEventListener("click", (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>("[data-th]")?.dataset.th;
      if (action === "close") this.stop();
      else if (action === "cockpit") this.setCockpit(!this.cockpit, true);
      else if (action === "info") this.target?.details();
      else if (action === "share") this.opts.share();
      else if (action === "relock") this.relock();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.target && !document.body.dataset.sheet) this.stop();
    });
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  isTracking(kind: Trackable["kind"], id: string): boolean {
    return this.target?.kind === kind && this.target.id === id;
  }

  track(t: Trackable, opts: { cockpit?: boolean } = {}): void {
    const same = this.target?.kind === t.kind && this.target.id === t.id;
    this.target = t;
    if (!same) {
      this.recorded = [];
      this.shown = null;
    }
    this.follow = true;
    this.ensureLayers();
    document.body.dataset.tracking = t.kind;
    const now = t.now(Date.now());
    if (now) {
      this.easingUntil = Date.now() + 900;
      this.map.easeTo({ center: [now.lng, now.lat], zoom: Math.max(this.map.getZoom(), t.kind === "plane" ? 8 : 3), duration: 900 });
    }
    if (opts.cockpit) this.setCockpit(true, true);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.frame);
    this.renderHud(true);
    for (const fn of this.listeners) fn();
  }

  stop(): void {
    if (!this.target) return;
    cancelAnimationFrame(this.raf);
    if (this.cockpit) this.map.easeTo({ pitch: 0, duration: 800 });
    this.target = null;
    this.cockpit = false;
    this.shown = null;
    this.recorded = [];
    delete document.body.dataset.tracking;
    this.hud.classList.add("hidden");
    for (const id of ["trk-trail", "trk-target"]) (this.map.getSource(id) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
    for (const fn of this.listeners) fn();
  }

  private relock(): void {
    this.follow = true;
    if (this.shown) {
      this.easingUntil = Date.now() + 700;
      this.map.easeTo({ center: [this.shown.lng, this.shown.lat], duration: 700 });
    }
    this.renderHud(true);
  }

  private setCockpit(on: boolean, animate: boolean): void {
    this.cockpit = on;
    const tel = this.shown ?? this.target?.now(Date.now()) ?? null;
    if (on && tel) {
      this.follow = true;
      this.bearing = tel.heading ?? this.map.getBearing();
      const zoom =
        this.target?.kind === "sat" ? 3.2 : tel.altM === null ? 12 : Math.min(14.5, Math.max(8.5, 14.5 - Math.log2(Math.max(tel.altM, 150) / 150)));
      this.easingUntil = Date.now() + 1300;
      this.map.easeTo({ center: [tel.lng, tel.lat], zoom, pitch: this.target?.kind === "sat" ? 55 : 70, bearing: this.bearing, duration: 1300 });
    } else if (!on && animate) {
      this.easingUntil = Date.now() + 800;
      this.map.easeTo({ pitch: 0, duration: 800 });
    }
    this.renderHud(true);
  }

  private frame = (time: number): void => {
    if (!this.target) return;
    this.raf = requestAnimationFrame(this.frame);
    if (time - this.lastFrame < FRAME_MS) return;
    this.lastFrame = time;
    const now = Date.now();
    const tel = this.target.now(now);
    if (!tel) return;
    // Glide toward the newest estimate rather than jumping when fresh data lands.
    const jump = !this.shown || distance(this.shown, tel) > 20000;
    const shown: Telemetry = jump
      ? tel
      : { ...tel, lat: lerp(this.shown!.lat, tel.lat, 0.25), lng: lerp(this.shown!.lng, tel.lng, 0.25), heading: tel.heading === null ? this.shown!.heading : angleLerp(this.shown!.heading ?? tel.heading, tel.heading, 0.25) };
    this.shown = shown;
    this.drawTarget(shown, now);
    if (this.follow && now > this.easingUntil) {
      if (this.cockpit && shown.heading !== null) {
        this.bearing = angleLerp(this.bearing, shown.heading, 0.08);
        this.map.jumpTo({ center: [shown.lng, shown.lat], bearing: this.bearing });
      } else this.map.jumpTo({ center: [shown.lng, shown.lat] });
    }
    if (now - this.lastHud > 500) this.renderHud(false);
  };

  private drawTarget(t: Telemetry, now: number): void {
    const target = this.target!;
    let path: Array<[number, number]>;
    if (target.history) path = target.history(now);
    else {
      const last = this.recorded.at(-1);
      if (!last || now - last[2] > 1000) this.recorded.push([t.lng, t.lat, now]);
      this.recorded = this.recorded.filter((p) => now - p[2] < TRAIL_MS);
      path = this.recorded.map(([lng, lat]) => [lng, lat]);
    }
    path = unwrap([...path, [t.lng, t.lat]]);
    (this.map.getSource("trk-trail") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: path.length > 1 ? [{ type: "Feature", properties: { kind: target.kind }, geometry: { type: "LineString", coordinates: path } }] : [],
    });
    (this.map.getSource("trk-target") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          // Screen-space rotation: heading relative to the camera, so the icon points the right way even tilted.
          properties: { kind: target.kind, icon: target.kind === "plane" ? "plane" : "sat", heading: target.kind === "plane" ? (t.heading ?? 0) - this.map.getBearing() : 0, stale: t.stale },
          geometry: { type: "Point", coordinates: [t.lng, t.lat] },
        },
      ],
    });
  }

  private ensureLayers(): void {
    const map = this.map;
    if (!map.getSource("trk-trail")) map.addSource("trk-trail", { type: "geojson", lineMetrics: true, data: { type: "FeatureCollection", features: [] } });
    if (!map.getSource("trk-target")) map.addSource("trk-target", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    const color = ["match", ["get", "kind"], "sat", COLORS.sat, COLORS.plane] as unknown as string;
    if (!map.getLayer("trk-trail"))
      map.addLayer({
        id: "trk-trail",
        type: "line",
        source: "trk-trail",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-width": 2.6,
          "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, "rgba(248,113,113,0)", 0.6, "rgba(251,191,36,0.45)", 1, "rgba(248,113,113,0.95)"],
        },
      });
    if (!map.getLayer("trk-ring"))
      map.addLayer({
        id: "trk-ring",
        type: "circle",
        source: "trk-target",
        paint: { "circle-radius": 19, "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 1.6, "circle-stroke-color": color, "circle-stroke-opacity": ["case", ["get", "stale"], 0.4, 0.95] },
      });
    if (!map.getLayer("trk-icon"))
      map.addLayer({
        id: "trk-icon",
        type: "symbol",
        source: "trk-target",
        layout: {
          "icon-image": ["get", "icon"],
          "icon-size": 1.1,
          "icon-rotate": ["get", "heading"],
          // Upright toward the camera, so it stays a silhouette in cockpit view.
          "icon-rotation-alignment": "viewport",
          "icon-pitch-alignment": "viewport",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": ["case", ["get", "stale"], 0.5, 1] },
      });
    for (const id of ["trk-trail", "trk-ring", "trk-icon"]) map.setLayoutProperty(id, "visibility", "visible");
  }

  private renderHud(full: boolean): void {
    const t = this.target;
    if (!t) return;
    this.lastHud = Date.now();
    const tel = this.shown;
    const me = this.opts.me();
    const lines: string[] = [];
    if (tel) {
      if (t.kind === "plane") {
        lines.push(tel.altM === null ? "ALT —" : tel.altM <= 0 ? "地面" : `ALT ${Math.round(tel.altM / 0.3048).toLocaleString()} ft`);
        lines.push(tel.speedKmh === null ? "GS —" : `GS ${Math.round(tel.speedKmh / 1.852)} kt`);
      } else {
        lines.push(tel.altM === null ? "ALT —" : `ALT ${Math.round(tel.altM / 1000).toLocaleString()} km`);
        lines.push(tel.speedKmh === null ? "" : `${(tel.speedKmh / 3600).toFixed(2)} km/s`);
      }
      lines.push(tel.heading === null ? "HDG —" : `HDG ${String(Math.round(tel.heading)).padStart(3, "0")}°`);
      if (me) lines.push(`距你 ${formatDistance(distance(me, tel))}`);
    }
    const tele = lines.filter(Boolean).join("　");
    if (!full) {
      const el = this.hud.querySelector(".th-tele");
      if (el) el.textContent = tel?.stale ? `${tele}　訊號中斷，位置為推算` : tele;
      return;
    }
    this.hud.classList.remove("hidden");
    this.hud.innerHTML = `<div class="th-head"><span class="th-lock">${this.follow ? "◎ LOCK" : "◌ FREE"}</span><b>${esc(t.label)}</b><small>${esc(t.sub)}</small><button class="icon-btn" data-th="close" aria-label="停止追蹤">✕</button></div>
      <div class="th-tele mono">${esc(tele)}</div>
      <div class="th-actions">
        ${this.follow ? "" : '<button class="chip" data-th="relock" aria-pressed="true">重新鎖定</button>'}
        <button class="chip" data-th="cockpit" aria-pressed="${this.cockpit}">${this.cockpit ? "一般視角" : "駕駛艙視角"}</button>
        <button class="chip" data-th="info">詳情</button>
        <button class="chip" data-th="share">分享</button>
      </div>`;
  }
}

/** Keep longitudes continuous so a path crossing 180° is not drawn the long way round. */
function unwrap(path: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [lng, lat] of path) {
    const prev = out.at(-1);
    let x = lng;
    if (prev) while (x - prev[0] > 180) x -= 360;
    if (prev) while (prev[0] - x > 180) x += 360;
    out.push([x, lat]);
  }
  return out;
}
