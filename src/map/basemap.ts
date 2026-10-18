// Which map is drawn under the lenses: 百眼's own dark vector map (free,
// OpenFreeMap), or Google's own map tiles (Map Tiles API) on the same globe,
// with Google's traffic and Street View coverage layers. Google needs a key:
// the site's (GOOGLE_MAPS_KEY at build, so visitors set up nothing) or the
// visitor's own. Overlays are baked into the one tile session, so each map
// square is billed once however many Google layers are on.

import type { RasterTileSource } from "maplibre-gl";
import { googleKey } from "../data/google";
import { read, write } from "../lib/store";
import type { GlobeMap } from "./globe";
import { tacticalStyle } from "./style";

export type BaseId = "baiyan" | "g-road" | "g-dark" | "g-sat" | "g-terrain";
export type OverlayId = "traffic" | "streetview";

export interface BasemapChoice {
  base: BaseId;
  overlays: OverlayId[];
}

export const BASES: Record<BaseId, { label: string; note: string; google: boolean }> = {
  baiyan: { label: "百眼深色", note: "免費 · 3D 建築", google: false },
  "g-road": { label: "Google 標準", note: "和 Google 地圖一樣", google: true },
  "g-dark": { label: "Google 深色", note: "夜間", google: true },
  "g-sat": { label: "Google 衛星", note: "含路名", google: true },
  "g-terrain": { label: "Google 地形", note: "山區", google: true },
};

export const OVERLAYS: Record<OverlayId, { label: string; layer: string }> = {
  traffic: { label: "路況", layer: "layerTraffic" },
  streetview: { label: "街景範圍", layer: "layerStreetview" },
};

const CHOICE = "gdg.basemap.v1";
const SESSIONS = "gdg.gsession.v1";
const TILES = "https://tile.googleapis.com";
/** Google's own logo files, tried in order (all three loaded in the live probe, 2026-10-18). */
export const GOOGLE_LOGOS = [
  "https://maps.gstatic.com/mapfiles/api-3/images/google_white5_hdpi.png",
  "https://maps.gstatic.com/mapfiles/api-3/images/google_white5.png",
  "https://www.gstatic.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png",
];
/** Every layer of 百眼's own map except the background. */
const OWN_LAYERS = tacticalStyle().layers.flatMap((l) => (l.id === "background" ? [] : [l.id]));

// Google's night palette, tuned to 百眼's colours (styles apply to roadmap only).
const DARK_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#0c1319" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#a7b6c3" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#04080d" }] },
  { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#3c5262" }] },
  { featureType: "poi", elementType: "geometry", stylers: [{ color: "#0f171d" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#73828f" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#0d1814" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#25313c" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#11181f" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8a9aa8" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#4a4331" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#1b252e" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#061019" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#3f6a86" }] },
];

/** The createSession request for a choice (exported for tests). */
export function sessionSpec(choice: BasemapChoice, hiDpi: boolean): Record<string, unknown> {
  const layers = choice.overlays.map((o) => OVERLAYS[o].layer);
  const spec: Record<string, unknown> = { language: "zh-TW", region: "TW", scale: hiDpi ? "scaleFactor2x" : "scaleFactor1x", highDpi: hiDpi };
  if (choice.base === "g-sat" || choice.base === "g-terrain") {
    // Satellite with road names is Google's "hybrid"; terrain requires the road layer.
    spec.mapType = choice.base === "g-sat" ? "satellite" : "terrain";
    spec.layerTypes = ["layerRoadmap", ...layers];
  } else {
    spec.mapType = "roadmap";
    if (layers.length) spec.layerTypes = layers;
    if (choice.base === "g-dark") spec.styles = DARK_STYLE;
  }
  return spec;
}

interface Session {
  session: string;
  /** ms since epoch */
  expiry: number;
}

async function tileSession(key: string, spec: Record<string, unknown>): Promise<Session> {
  const id = `${key.slice(-6)}|${JSON.stringify(spec)}`;
  const now = Date.now();
  const stored = Object.fromEntries(Object.entries(read<Record<string, Session>>(SESSIONS, {})).filter(([, s]) => s.expiry > now + 86400000));
  if (stored[id]) return stored[id];
  let r: Response;
  try {
    r = await fetch(`${TILES}/v1/createSession?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("連不上 Google 地圖");
  }
  const data = (await r.json().catch(() => ({}))) as { session?: string; expiry?: string; error?: { message?: string; status?: string } };
  if (!r.ok || !data.session) throw new Error(googleTileError(r.status, data.error?.message ?? ""));
  const session = { session: data.session, expiry: Number(data.expiry) * 1000 || now + 7 * 86400000 };
  write(SESSIONS, { ...stored, [id]: session });
  return session;
}

export function googleTileError(status: number, message: string): string {
  if (/not been used|disabled|not enabled/i.test(message)) return "這把 Google 金鑰還沒啟用 Map Tiles API";
  if (status === 403) return "Google 金鑰沒有允許這個網站或 Map Tiles API";
  if (status === 429) return "Google 地圖今日用量已達上限";
  if (status === 400) return "Google 金鑰無效";
  return `Google 地圖暫時無法使用（${status}）`;
}

let googleOn = false;
/** Google search results may only be shown on a Google map. */
export const googleMapActive = () => googleOn;

export class Basemap {
  private listeners: Array<() => void> = [];
  private session: { key: string; session: string } | null = null;
  private brand: HTMLElement;
  private copyrightKey = "";
  private copyrightTimer = 0;
  private tileErrors = 0;
  private tilesSeen = false;
  private seq = 0;
  private ready = false;

  constructor(
    private map: GlobeMap,
    private toast: (text: string, ms?: number) => void,
  ) {
    this.brand = document.createElement("div");
    this.brand.className = "gbrand hidden";
    this.brand.innerHTML = `<img src="${GOOGLE_LOGOS[0]}" alt="Google" height="18"><span class="gcopy"></span>`;
    const logo = this.brand.querySelector("img")!;
    let tried = 0;
    logo.addEventListener("error", () => {
      if (++tried < GOOGLE_LOGOS.length) logo.src = GOOGLE_LOGOS[tried];
      else logo.outerHTML = "<b>Google</b>";
    });
    map.getContainer().parentElement!.append(this.brand);
    map.once("load", () => {
      this.ready = true;
      void this.apply();
    });
    map.on("moveend", () => {
      clearTimeout(this.copyrightTimer);
      this.copyrightTimer = window.setTimeout(() => void this.updateCopyright(), 1200);
    });
    map.on("sourcedata", (e) => {
      if (e.sourceId === "gmap" && e.tile) this.tilesSeen = true;
    });
    map.on("error", (e) => {
      const err = e as unknown as { sourceId?: string; error?: { status?: number } };
      if (err.sourceId !== "gmap" || !googleOn) return;
      // A quota or key problem fails every tile; a few misses while panning do not.
      if (++this.tileErrors >= (this.tilesSeen ? 12 : 4)) {
        this.fallBack(err.error?.status === 429 ? "Google 地圖今日用量已達上限" : "Google 地圖圖磚載入失敗");
      }
    });
  }

  choice(): BasemapChoice {
    const saved = read<Partial<BasemapChoice> | null>(CHOICE, null);
    const base: BaseId = saved?.base && saved.base in BASES ? saved.base : googleKey() ? "g-road" : "baiyan";
    const overlays = (saved?.overlays ?? []).filter((o): o is OverlayId => o in OVERLAYS);
    return { base, overlays };
  }

  /** What is actually drawn: a Google choice without any key shows 百眼深色. */
  effective(): BasemapChoice {
    const c = this.choice();
    return BASES[c.base].google && !googleKey() ? { base: "baiyan", overlays: [] } : c;
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  async set(choice: BasemapChoice): Promise<void> {
    write(CHOICE, choice);
    await this.apply();
  }

  async apply(): Promise<void> {
    if (!this.ready) return;
    const seq = ++this.seq;
    const choice = this.effective();
    const key = googleKey();
    if (!BASES[choice.base].google || !key) {
      this.useOwn();
      return;
    }
    let s: Session;
    try {
      s = await tileSession(key, sessionSpec(choice, devicePixelRatio >= 1.5));
    } catch (e) {
      if (seq === this.seq) this.fallBack((e as Error).message);
      return;
    }
    if (seq !== this.seq) return;
    const map = this.map;
    const tiles = [`${TILES}/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(s.session)}&key=${encodeURIComponent(key)}`];
    // Terrain and imagery stop at lower zooms than roads; past that MapLibre stretches the last tiles.
    const maxzoom = choice.base === "g-terrain" ? 15 : choice.base === "g-sat" ? 19 : 20;
    const source = map.getSource("gmap") as RasterTileSource | undefined;
    if (source && source.maxzoom !== maxzoom) {
      map.removeLayer("gmap");
      map.removeSource("gmap");
    }
    if (map.getSource("gmap")) (map.getSource("gmap") as RasterTileSource).setTiles(tiles);
    else {
      map.addSource("gmap", { type: "raster", tiles, tileSize: 256, maxzoom });
      // Right above the background, under every lens.
      map.addLayer({ id: "gmap", type: "raster", source: "gmap", paint: { "raster-fade-duration": 150 } }, OWN_LAYERS[0]);
    }
    map.setLayoutProperty("gmap", "visibility", "visible");
    this.setOwnVisible(false);
    this.session = { key, session: s.session };
    this.tileErrors = 0;
    this.tilesSeen = false;
    this.copyrightKey = "";
    this.setGoogle(true);
    void this.updateCopyright();
  }

  private useOwn(): void {
    this.seq++;
    if (this.map.getLayer("gmap")) this.map.setLayoutProperty("gmap", "visibility", "none");
    this.setOwnVisible(true);
    this.session = null;
    this.setGoogle(false);
  }

  /** Keeps the saved choice, so the next visit tries Google again (with a fresh session). */
  private fallBack(reason: string): void {
    write(SESSIONS, {});
    this.toast(`${reason}，先用百眼深色地圖`, 6000);
    this.useOwn();
  }

  private setOwnVisible(on: boolean): void {
    for (const id of OWN_LAYERS) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  }

  private setGoogle(on: boolean): void {
    const changed = googleOn !== on;
    googleOn = on;
    document.body.dataset.basemap = on ? "google" : "own";
    this.brand.classList.toggle("hidden", !on);
    if (changed) for (const fn of this.listeners) fn();
  }

  /** Google's copyright line for what is on screen (required with the logo). */
  private async updateCopyright(): Promise<void> {
    const s = this.session;
    if (!s || !googleOn) return;
    const b = this.map.getBounds();
    const zoom = Math.max(0, Math.min(22, Math.round(this.map.getZoom())));
    const wrap = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
    const whole = b.getEast() - b.getWest() >= 360;
    const clampLat = (y: number) => Math.max(-85, Math.min(85, y)).toFixed(3);
    const q = new URLSearchParams({
      session: s.session,
      key: s.key,
      zoom: String(zoom),
      north: clampLat(b.getNorth()),
      south: clampLat(b.getSouth()),
      east: (whole ? 180 : wrap(b.getEast())).toFixed(3),
      west: (whole ? -180 : wrap(b.getWest())).toFixed(3),
    });
    const id = q.toString();
    if (id === this.copyrightKey) return;
    this.copyrightKey = id;
    const text = this.brand.querySelector<HTMLElement>(".gcopy")!;
    try {
      const r = await fetch(`${TILES}/tile/v1/viewport?${q}`, { signal: AbortSignal.timeout(10000) });
      const data = (await r.json()) as { copyright?: string };
      if (s === this.session) text.textContent = data.copyright || `地圖資料 ©${new Date().getFullYear()} Google`;
    } catch {
      if (!text.textContent) text.textContent = `地圖資料 ©${new Date().getFullYear()} Google`;
    }
  }
}
