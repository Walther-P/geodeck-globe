import "./styles.css";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { hasCwa, hasTdx, onKeysChange } from "./data/keys";
import type { Place } from "./data/places";
import { ParkingLens } from "./lenses/parking";
import { RadioLens } from "./lenses/radio";
import { SkyLens } from "./lenses/sky";
import { TrafficLens } from "./lenses/traffic";
import { WeatherLens } from "./lenses/weather";
import type { AppContext, Lens, LensId, Tone } from "./lenses/lens";
import { read, write } from "./lib/store";
import { escapeHtml as esc, formatCoord } from "./lib/util";
import { Basemap } from "./map/basemap";
import { addIcons, createGlobe } from "./map/globe";
import { DetectOverlay } from "./ui/detect";
import { $, Sheet, toast } from "./ui/dom";
import { NowBar } from "./ui/now";
import { openLayers } from "./ui/layers";
import { DropPin } from "./ui/pin";
import { openPlace } from "./ui/place";
import { openSaved } from "./ui/saved";
import { Locator } from "./ui/locate";
import { setupSearch } from "./ui/search";
import { openSettings } from "./ui/settings";
import { readViewLink, shareLink, viewLink } from "./ui/share";

const ACTIVE = "gdg.lenses.v1";

// A shared view link (?c=…) restores camera, lenses, mode and map type
// before the globe starts, so the fly-in lands on the shared view.
const sharedView = readViewLink(location.search);
if (sharedView) {
  write("gdg.view.v1", { lng: sharedView.lng, lat: sharedView.lat, zoom: sharedView.zoom, bearing: sharedView.bearing, pitch: sharedView.pitch });
  const lensList = sharedView.track && !sharedView.lenses.includes("sky") ? [...sharedView.lenses, "sky"] : sharedView.lenses;
  if (lensList.length) write(ACTIVE, lensList);
  write("gdg.fx.v1", sharedView.fx);
  if (sharedView.map) write("gdg.basemap.v1", { base: sharedView.map, overlays: [] });
  history.replaceState(null, "", location.pathname);
}

const sheet = new Sheet();
const map = createGlobe($("map"), () => toast("地圖底圖連線失敗，暫時只顯示陸地輪廓；其他資訊仍可使用", 6000));
const basemap = new Basemap(map, toast);
const pin = new DropPin(map, (p) => showPlace(p));

// ---- Lenses -----------------------------------------------------------------

const taps: Array<{ layers: string[]; handler: (f: MapGeoJSONFeature) => void }> = [];
const statuses = new Map<LensId, { text: string; tone?: Tone }>();
let focused: LensId | null = null;

const ctx: AppContext = {
  map,
  sheet,
  toast,
  status(lens, text, tone) {
    statuses.set(lens, { text, tone });
    if (lens === focused) {
      const el = document.querySelector<HTMLElement>("#strip .strip-status");
      if (el) {
        el.textContent = text;
        if (tone && tone !== "ok") el.dataset.tone = tone;
        else delete el.dataset.tone;
      }
    }
  },
  refreshStrip(lens) {
    if (lens === focused) renderStrip();
  },
  openPlace: (p, intent) => showPlace(p, intent),
  onFeatureTap(layers, handler) {
    taps.push({ layers, handler });
  },
  openSettings: (section) => openSettings(sheet, toast, section, checkUpdate),
  me: () => locator.me,
  shareView: () => shareView(),
};

const traffic = new TrafficLens(ctx);
const sky = new SkyLens(ctx);
const lenses: Record<LensId, Lens> = {
  weather: new WeatherLens(ctx),
  traffic,
  parking: new ParkingLens(ctx),
  sky,
  radio: new RadioLens(ctx),
};
if (sharedView?.track) sky.trackWhenSeen(sharedView.track.kind, sharedView.track.id);
const active = new Set<LensId>();

function setActive(id: LensId, on: boolean): void {
  if (on === active.has(id)) return;
  if (on) {
    active.add(id);
    lenses[id].activate();
  } else {
    active.delete(id);
    lenses[id].deactivate();
  }
  write(ACTIVE, [...active]);
}

function focusLens(id: LensId | null): void {
  focused = id;
  renderStrip();
}

function renderDock(): void {
  document.querySelectorAll<HTMLButtonElement>(".dock [data-lens]").forEach((b) => {
    const id = b.dataset.lens as LensId;
    b.setAttribute("aria-pressed", String(active.has(id)));
    b.dataset.focus = String(id === focused);
  });
}

function renderStrip(): void {
  renderDock();
  const strip = $("strip");
  if (!focused || !active.has(focused)) {
    strip.classList.add("hidden");
    return;
  }
  const lens = lenses[focused];
  const status = statuses.get(focused);
  strip.classList.remove("hidden");
  strip.innerHTML = `<div class="strip-head"><strong>${esc(lens.title)}</strong><span class="strip-status"${status?.tone && status.tone !== "ok" ? ` data-tone="${status.tone}"` : ""}>${esc(status?.text ?? "載入中…")}</span><button class="icon-btn" id="stripHide" aria-label="收起">⌄</button></div>
    <div class="chips" role="group" aria-label="${esc(lens.title)}圖層">${lens
      .chips()
      .map((c) => {
        const locked = (c.needs === "tdx" && !hasTdx()) || (c.needs === "cwa" && !hasCwa());
        return `<button class="chip" data-chip="${esc(c.id)}" aria-pressed="${c.on && !locked}"${locked ? ' data-locked="true" title="需要你自己的金鑰"' : ""}>${esc(c.label)}</button>`;
      })
      .join("")}</div><div id="stripExtra"></div>`;
  lens.renderExtra?.($("stripExtra"));
  strip.querySelectorAll<HTMLButtonElement>("[data-chip]").forEach((b) =>
    b.addEventListener("click", () => {
      lens.toggleChip(b.dataset.chip!);
      renderStrip();
    }),
  );
  $("stripHide").addEventListener("click", () => focusLens(null));
}

document.querySelectorAll<HTMLButtonElement>(".dock [data-lens]").forEach((b) =>
  b.addEventListener("click", () => {
    const id = b.dataset.lens as LensId;
    if (!active.has(id)) {
      setActive(id, true);
      focusLens(id);
    } else if (focused !== id) {
      focusLens(id);
    } else {
      setActive(id, false);
      focusLens([...active].at(-1) ?? null);
    }
  }),
);

onKeysChange(() => {
  renderStrip();
  // Adding or removing a Google key switches the map to or from Google.
  void basemap.apply();
});

// ---- Map interaction ----------------------------------------------------------

map.on("load", () => {
  addIcons(map);
  const saved = read<LensId[]>(ACTIVE, ["sky", "weather"]);
  for (const id of saved) if (id in lenses) setActive(id, true);
  focusLens(saved.at(-1) ?? null);
  now.schedule(4000);
});
map.on("styleimagemissing", () => addIcons(map));

map.on("click", (e) => {
  // Taps on the pin or the car marker are theirs, not the map's.
  if ((e.originalEvent?.target as Element | null)?.closest?.(".drop-pin, .car-pin")) return;
  for (const { layers, handler } of taps) {
    const existing = layers.filter((l) => map.getLayer(l) && map.getLayoutProperty(l, "visibility") !== "none");
    if (!existing.length) continue;
    const pad = 10;
    const hits = map.queryRenderedFeatures(
      [
        [e.point.x - pad, e.point.y - pad],
        [e.point.x + pad, e.point.y + pad],
      ],
      { layers: existing },
    );
    if (hits.length) {
      handler(hits[0]);
      return;
    }
  }
  if (sheet.kind) {
    sheet.close();
    return;
  }
  // A pin first, so it is clear which spot was picked; its callout opens the card.
  pin.drop({ lat: e.lngLat.lat, lng: e.lngLat.lng, title: "" });
});

function showPlace(p: Place, intent?: "navigate" | "walk"): void {
  pin.drop(p, { collapsed: true });
  openPlace(
    {
      map,
      sheet,
      toast,
      openCamera: (id) => {
        if (!active.has("traffic")) setActive("traffic", true);
        traffic.showCamera(id);
      },
      focusLens: (id) => {
        setActive(id, true);
        focusLens(id);
      },
    },
    p,
    intent,
  );
}

// ---- HUD ---------------------------------------------------------------------

let hudFrame = 0;
function updateHud(): void {
  hudFrame = 0;
  const c = map.getCenter();
  const z = map.getZoom();
  const mpp = (156543.03 * Math.cos((c.lat * Math.PI) / 180)) / 2 ** z;
  const altitude = 1.5 * map.getCanvas().clientHeight * mpp;
  const alt = altitude > 5000 ? `${Math.round(altitude / 1000).toLocaleString()} km` : `${Math.round(altitude).toLocaleString()} m`;
  $("readout").textContent = `${formatCoord({ lat: c.lat, lng: c.lng })}\n視高 ${alt}  方位 ${Math.round((map.getBearing() + 360) % 360)}°`;
  $("northArrow").style.transform = `rotate(${-map.getBearing()}deg)`;
  $("tilt").setAttribute("aria-pressed", String(map.getPitch() > 5));
}
map.on("move", () => {
  hudFrame ||= requestAnimationFrame(updateHud);
});
map.on("load", updateHud);

$("north").addEventListener("click", () => map.easeTo({ bearing: 0, pitch: 0, duration: 600 }));
$("tilt").addEventListener("click", () => {
  if (map.getPitch() > 5) map.easeTo({ pitch: 0, duration: 700 });
  else map.easeTo({ pitch: 60, zoom: Math.max(map.getZoom(), 15.5), duration: 1200 });
});

// ---- Screen modes & detection HUD ----------------------------------------------

const FX_NAMES: Record<string, string> = { "": "標準", nvg: "夜視", flir: "熱感・白熱", ironbow: "熱感・鐵虹", crt: "CRT", noir: "黑白", snow: "雪地" };
let fx = read<string>("gdg.fx.v1", "");
if (!(fx in FX_NAMES)) fx = "";
let detectOn = read<boolean>("gdg.detect.v1", false);
const detect = new DetectOverlay(map, () => sky.objects(), () => sky.trackedKey());
const applyFx = () => {
  if (fx) document.body.dataset.fx = fx;
  else delete document.body.dataset.fx;
  $("filter").setAttribute("aria-pressed", String(!!fx || detectOn));
  detect.set(detectOn);
};
applyFx();

function openScreenModes(): void {
  const body = sheet.open(
    "screen",
    "SENSOR",
    "畫面模式",
    `<div class="basemaps">${Object.entries(FX_NAMES)
      .map(([id, label]) => `<button class="basemap" data-mode="${id}" aria-pressed="${fx === id}"><span class="swatch fx-sw fx-sw-${id || "std"}" aria-hidden="true"></span>${label}</button>`)
      .join("")}</div>
    <h2>偵測框 HUD</h2>
    <div class="basemaps"><button class="basemap" id="detectToggle" aria-pressed="${detectOn}"><span class="swatch fx-sw fx-sw-detect" aria-hidden="true"></span>${detectOn ? "開啟中" : "關閉"}<small>框出畫面裡的飛機與衛星</small></button></div>
    <p class="micro">偵測框標示「天空」視角裡的航班與衛星，點任何一個都能鎖定追蹤。</p>`,
  );
  body.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      fx = b.dataset.mode ?? "";
      write("gdg.fx.v1", fx);
      applyFx();
      openScreenModes();
    }),
  );
  body.querySelector("#detectToggle")!.addEventListener("click", () => {
    detectOn = !detectOn;
    write("gdg.detect.v1", detectOn);
    if (detectOn && !active.has("sky")) {
      setActive("sky", true);
      focusLens("sky");
    }
    applyFx();
    openScreenModes();
  });
}
$("filter").addEventListener("click", openScreenModes);

function shareView(): void {
  const c = map.getCenter();
  const url = viewLink(`${location.origin}${location.pathname}`, {
    lat: c.lat,
    lng: c.lng,
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
    lenses: [...active],
    fx,
    map: basemap.effective().base,
    track: sky.trackedRef(),
  });
  void shareLink(url, "百眼", toast);
}
$("shareView").addEventListener("click", shareView);

const locator = new Locator(
  map,
  () => {
    $("locate").setAttribute("aria-pressed", "true");
    now.schedule(0);
  },
  toast,
);
$("locate").addEventListener("click", () => locator.start());

// ---- Top bar & now -------------------------------------------------------------

const now = new NowBar(
  map,
  () => locator.me,
  (s) => {
    if (!s) return toast("拉近地圖或按 ◎ 定位");
    if (s.warnings.length && active.has("weather")) focusLens("weather");
    showPlace({ lat: s.basis.lat, lng: s.basis.lng, title: s.mine ? "我的位置" : "" });
  },
);

const search = setupSearch({
  map,
  choose: (p) => showPlace(p),
  openSettings: (section) => ctx.openSettings(section),
  useGoogleMap: () => basemap.set({ ...basemap.choice(), base: "g-road" }),
});

// Android "share to 百眼" (manifest share_target) and ?q= links land here.
const shared = new URLSearchParams(location.search);
const sharedText = [shared.get("title"), shared.get("text"), shared.get("url"), shared.get("q")].filter(Boolean).join("\n");
if (sharedText) {
  history.replaceState(null, "", location.pathname);
  map.once("load", () => {
    const input = $<HTMLInputElement>("search");
    input.value = sharedText.split("\n").pop() ?? "";
    void search.runShared(sharedText);
  });
}
$("openSettings").addEventListener("click", () => ctx.openSettings());
$("layers").addEventListener("click", () => openLayers(sheet, basemap, (section) => ctx.openSettings(section)));
$("openSaved").addEventListener("click", () => openSaved(sheet, toast, (p, intent) => showPlace(p, intent)));

addEventListener("offline", () => toast("目前離線：收藏與已載入的資料仍可查看"));
addEventListener("online", () => toast("已恢復連線", 1500));

// ---- PWA ---------------------------------------------------------------------

let waiting: ServiceWorker | null = null;
let updating = false;
function checkUpdate(): void {
  if (!("serviceWorker" in navigator)) return toast("這個瀏覽器不支援離線更新");
  navigator.serviceWorker.getRegistration().then((r) => {
    if (!r) return toast("尚未安裝離線版本");
    toast("檢查更新中…", 1500);
    void r.update().then(() => {
      if (!r.waiting && !r.installing) toast("已是最新版本");
    });
  });
}
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker
    .register("./sw.js")
    .then((reg) => {
      if (!reg) return;
      const offer = (w: ServiceWorker | null) => {
        if (!w) return;
        waiting = w;
        $("update").classList.remove("hidden");
      };
      offer(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => w.state === "installed" && navigator.serviceWorker.controller && offer(w));
      });
    })
    .catch(() => {
      /* private mode or blocked: the app works without offline support */
    });
  // The first install also changes controller (clients.claim); only reload
  // when the user asked for the new version.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (updating) location.reload();
  });
}
$("applyUpdate").addEventListener("click", () => {
  updating = true;
  waiting?.postMessage("skipWaiting");
});
