// "My location": a blue dot that follows GPS, an accuracy halo, and a beam
// showing which way the phone is facing (compass), like Google Maps.

import { Marker } from "maplibre-gl";
import { circlePolygon, type Point } from "../lib/util";
import { EMPTY, addLayers, setData, type GlobeMap } from "../map/globe";

interface CompassEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

export class Locator {
  me: Point | null = null;
  private marker: Marker | null = null;
  private el: HTMLElement;
  private watchId: number | null = null;
  private heading: number | null = null;
  private compassAt = 0;
  private listening = false;
  private frame = 0;
  private centered = false;

  constructor(
    private map: GlobeMap,
    private onFix: (p: Point) => void,
    private toast: (t: string, ms?: number) => void,
  ) {
    this.el = document.createElement("div");
    this.el.className = "me";
    this.el.dataset.heading = "none";
    this.el.innerHTML = `<svg class="me-beam" viewBox="0 0 80 80" aria-hidden="true"><defs><radialGradient id="meBeam" cx="40" cy="40" r="40" gradientUnits="userSpaceOnUse"><stop offset="0.12" stop-color="#60a5fa" stop-opacity="0.75"/><stop offset="1" stop-color="#60a5fa" stop-opacity="0"/></radialGradient></defs><path d="M40 40 L19 2 A40 40 0 0 1 61 2 Z" fill="url(#meBeam)"/></svg><span class="me-dot"></span>`;
  }

  /**
   * Call from the tap handler itself: iOS only lets a page read the compass
   * after asking inside a user gesture.
   */
  start(): void {
    this.listenCompass();
    if (!navigator.geolocation) return this.toast("這個瀏覽器不支援定位");
    if (this.me) this.recenter();
    else this.toast("取得目前位置…", 2000);
    this.centered = !!this.me;
    if (this.watchId !== null) return;
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.fix(pos),
      (err) => {
        if (this.me) return;
        this.toast(err.code === err.PERMISSION_DENIED ? "沒有定位權限：請在設定允許這個網站使用位置" : "暫時無法取得位置，請到空曠處再試", 5000);
        this.stop();
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
  }

  stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  recenter(): void {
    if (this.me) this.map.flyTo({ center: [this.me.lng, this.me.lat], zoom: Math.max(this.map.getZoom(), 16), duration: 1200 });
  }

  private fix(pos: GeolocationPosition): void {
    const { latitude: lat, longitude: lng, accuracy, heading, speed } = pos.coords;
    this.me = { lat, lng };
    if (!this.marker) this.marker = new Marker({ element: this.el, rotationAlignment: "map", pitchAlignment: "map" });
    this.marker.setLngLat([lng, lat]).addTo(this.map);
    // Moving fast with no compass: the direction of travel is the best guess.
    if (Date.now() - this.compassAt > 3000 && heading !== null && Number.isFinite(heading) && (speed ?? 0) > 1.5) this.setHeading(heading);
    setData(this.map, "me-accuracy", accuracy && accuracy < 2000 ? { type: "FeatureCollection", features: [circlePolygon(lng, lat, accuracy / 1000)] } : EMPTY);
    addLayers(
      this.map,
      [
        { id: "me-accuracy-fill", type: "fill", source: "me-accuracy", paint: { "fill-color": "#3b82f6", "fill-opacity": 0.12 } },
        { id: "me-accuracy-line", type: "line", source: "me-accuracy", paint: { "line-color": "#60a5fa", "line-opacity": 0.5, "line-width": 1 } },
      ],
      "road-label",
    );
    if (!this.centered) {
      this.centered = true;
      this.recenter();
    }
    this.onFix(this.me);
  }

  private listenCompass(): void {
    if (this.listening || typeof DeviceOrientationEvent === "undefined") return;
    const listen = () => {
      this.listening = true;
      addEventListener("deviceorientationabsolute", this.onOrientation as EventListener, true);
      addEventListener("deviceorientation", this.onOrientation as EventListener, true);
    };
    const ask = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission;
    if (typeof ask === "function")
      ask()
        .then((state) => (state === "granted" ? listen() : this.toast("沒有開啟方向權限，定位點不會顯示面向", 3000)))
        .catch(() => {});
    else listen();
  }

  private onOrientation = (e: CompassEvent) => {
    let h: number | null = null;
    if (typeof e.webkitCompassHeading === "number" && Number.isFinite(e.webkitCompassHeading)) h = e.webkitCompassHeading;
    else if (e.absolute && e.alpha !== null) h = 360 - e.alpha;
    // Plain relative alpha isn't tied to north, so it can't point anywhere useful.
    if (h === null) return;
    const screenAngle = screen.orientation?.angle ?? Number((window as unknown as { orientation?: number }).orientation ?? 0);
    this.compassAt = Date.now();
    this.setHeading(h + screenAngle);
  };

  private setHeading(raw: number): void {
    const h = ((raw % 360) + 360) % 360;
    if (this.heading === null) this.heading = h;
    else {
      // Smooth the jittery compass, taking the short way round 0°/360°.
      const diff = ((h - this.heading + 540) % 360) - 180;
      this.heading = (this.heading + diff * 0.3 + 360) % 360;
    }
    this.el.dataset.heading = "on";
    // Compass events arrive faster than frames; rotate once per frame.
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      if (this.heading !== null) this.marker?.setRotation(this.heading);
    });
  }
}
