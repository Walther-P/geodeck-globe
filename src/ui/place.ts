// Place card: everything about one point — weather, rain, air, nearby cameras
// and parking, and handing off to a navigation app.

import { Marker } from "maplibre-gl";
import { catalogLots } from "../data/parking";
import { defaultNavApp, isSaved, navigationUrl, NAV_APPS, removePlace, savePlace, setParkedCar, type NavApp, type Place, type TravelMode } from "../data/places";
import { bundledCameras, enforcementPoints, nearest } from "../data/roads";
import { inTaiwan } from "../data/taiwan";
import { air, aqiLabel, forecast, rainOutlook, weatherLabel } from "../data/weather";
import { getJson } from "../lib/net";
import { read } from "../lib/store";
import { clock } from "../lib/time";
import { escapeHtml as esc, formatCoord, formatDistance, type Point } from "../lib/util";
import type { GlobeMap } from "../map/globe";
import type { Sheet } from "./dom";

export interface PlaceDeps {
  map: GlobeMap;
  sheet: Sheet;
  toast(text: string): void;
  openCamera(id: string): void;
  focusLens(id: "parking"): void;
}

let pin: Marker | null = null;
let seq = 0;

export function navPreference(): NavApp | "auto" {
  return read<NavApp | "auto">("gdg.nav.v1", "auto");
}

export function openPlace(deps: PlaceDeps, p: Place, intent?: "navigate" | "walk"): void {
  const mine = ++seq;
  pin?.remove();
  const el = document.createElement("div");
  el.className = "pin";
  pin = new Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(deps.map);
  let title = p.title || "地圖上的位置";
  let mode: TravelMode = intent === "walk" ? "walking" : "driving";
  const body = deps.sheet.open(
    "place",
    formatCoord(p),
    title,
    `${inTaiwan(p) ? '<div class="actions"><button class="btn primary" id="plParkNear">🅿 這附近停車</button></div>' : ""}
    ${intent ? '<div id="plNav"></div>' : ""}
    <h2>此刻</h2>
    <div id="plNow" class="stat-row"><div class="stat"><b>…</b><small>天氣</small></div><div class="stat"><b>…</b><small>降雨</small></div><div class="stat"><b>…</b><small>空氣</small></div></div>
    <p id="plRain" class="muted"></p>
    <h2>逐時（降雨機率 · 雨量）</h2>
    <div id="plHours" class="hours"><p class="muted">載入中…</p></div>
    ${intent ? "" : '<h2>前往</h2><div id="plNav"></div>'}
    <div id="plNear"></div>
    <div class="actions">
      <button class="btn" id="plSave"></button>
      <button class="btn" id="plShare">分享位置</button>
      <button class="btn" id="plPark">我停在這裡</button>
    </div>
    <p class="micro">天氣：Open-Meteo 模式預報（非實測），空氣：CAMS 模式。缺值顯示「—」，不代表沒有下雨。</p>`,
    () => {
      if (mine === seq) {
        pin?.remove();
        pin = null;
      }
    },
  );

  body.querySelector("#plParkNear")?.addEventListener("click", () => {
    deps.sheet.close();
    deps.focusLens("parking");
    deps.map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(deps.map.getZoom(), 16.5), duration: 1200 });
    // Keep the destination pinned while looking for parking around it.
    pin = new Marker({ element: Object.assign(document.createElement("div"), { className: "pin" }) }).setLngLat([p.lng, p.lat]).addTo(deps.map);
  });

  const renderNav = () => {
    const app = defaultNavApp(p, navPreference());
    const others = (Object.keys(NAV_APPS) as NavApp[]).filter((a) => a !== app);
    const modes: Array<[TravelMode, string]> = [
      ["driving", "開車"],
      ["walking", "步行"],
      ["transit", "大眾運輸"],
    ];
    body.querySelector("#plNav")!.innerHTML = `<div class="chips" role="group" aria-label="交通方式">${modes
      .map(([m, label]) => `<button class="chip" data-mode="${m}" aria-pressed="${m === mode}">${label}</button>`)
      .join("")}</div>
      <div class="actions"><a class="btn primary" href="${esc(navigationUrl(app, p, mode))}" target="_blank" rel="noopener">用 ${esc(NAV_APPS[app])} 導航</a></div>
      <div class="nav-more">改用：${others.map((a) => `<a href="${esc(navigationUrl(a, p, mode))}" target="_blank" rel="noopener">${esc(NAV_APPS[a])}</a>`).join("")}</div>
      ${app === "naver" ? `<p class="micro">需要安裝 NAVER Map。</p>` : ""}`;
    body.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
      b.addEventListener("click", () => {
        mode = b.dataset.mode as TravelMode;
        renderNav();
      }),
    );
  };
  renderNav();

  const renderSave = () => {
    const saved = isSaved(p);
    const btn = body.querySelector<HTMLButtonElement>("#plSave")!;
    btn.textContent = saved ? "★ 已收藏" : "☆ 收藏";
    btn.onclick = () => {
      if (isSaved(p)) removePlace(isSaved(p)!.id);
      else savePlace({ ...p, title });
      deps.toast(isSaved(p) ? "已加入收藏（只存在這台裝置）" : "已移除收藏");
      renderSave();
    };
  };
  renderSave();

  body.querySelector("#plShare")!.addEventListener("click", async () => {
    const text = `${title} ${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
    const url = `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
    try {
      if (navigator.share) await navigator.share({ title, text, url });
      else {
        await navigator.clipboard.writeText(`${text} ${url}`);
        deps.toast("已複製座標與連結");
      }
    } catch {
      /* user cancelled */
    }
  });
  body.querySelector("#plPark")!.addEventListener("click", () => {
    setParkedCar({ lat: p.lat, lng: p.lng, savedAt: Date.now(), note: title });
    deps.toast("已記住停車位置");
  });

  if (!p.title) void reverseName(p).then((name) => {
    if (name && mine === seq) {
      title = name;
      deps.sheet.setTitle(name);
    }
  });

  void forecast(p)
    .then((f) => {
      if (mine !== seq) return;
      const w = weatherLabel(f.code, f.isDay);
      const rain = rainOutlook(f);
      const now = body.querySelector("#plNow")!;
      now.children[0].innerHTML = `<b>${f.temp === null ? "—" : Math.round(f.temp) + "°"}</b><small>${esc(w.icon + " " + w.text)}${f.feels === null ? "" : `<br>體感 ${Math.round(f.feels)}°`}</small>`;
      now.children[1].setAttribute("data-level", rain.level);
      const nextMm = f.next.slice(0, 8).reduce((s, x) => s + (x.mm ?? 0), 0);
      now.children[1].innerHTML = `<b>${rain.level === "unknown" ? "—" : nextMm.toFixed(1)}</b><small>未來 2 小時 mm</small>`;
      body.querySelector("#plRain")!.textContent = rain.text;
      // Show hours in the place's own time zone, not the phone's.
      const offset = f.utcOffset * 1000 + new Date().getTimezoneOffset() * 60000;
      body.querySelector("#plHours")!.innerHTML = f.hours
        .map((h) => {
          const wl = weatherLabel(h.code);
          const wet = (h.rainChance ?? 0) >= 40 || (h.rainMm ?? 0) >= 0.5;
          return `<div class="hour" data-rain="${wet}"><time>${clock(h.at + offset)}</time><span class="ic" title="${esc(wl.text)}">${wl.icon}</span>${h.temp === null ? "—" : Math.round(h.temp) + "°"}<span class="pop">${h.rainChance === null ? "—" : h.rainChance + "%"}</span><span class="mm">${h.rainMm === null ? "—" : h.rainMm.toFixed(1)}</span></div>`;
        })
        .join("");
    })
    .catch((e) => {
      if (mine !== seq) return;
      body.querySelector("#plHours")!.innerHTML = `<p class="muted">天氣暫時無法取得：${esc((e as Error).message)}</p>`;
      body.querySelector("#plRain")!.textContent = "";
    });

  void air(p)
    .then((a) => {
      if (mine !== seq) return;
      const l = aqiLabel(a.aqi);
      const cell = body.querySelector("#plNow")!.children[2];
      cell.setAttribute("data-level", l.level);
      cell.innerHTML = `<b>${a.aqi === null ? "—" : Math.round(a.aqi)}</b><small>AQI ${esc(l.text)}</small>`;
    })
    .catch(() => {
      if (mine === seq) body.querySelector("#plNow")!.children[2].innerHTML = `<b>—</b><small>空氣品質未知</small>`;
    });

  if (inTaiwan(p)) void nearby(deps, p, body, () => mine === seq);
}

async function nearby(deps: PlaceDeps, p: Point, body: HTMLElement, current: () => boolean): Promise<void> {
  const box = { south: p.lat - 0.012, north: p.lat + 0.012, west: p.lng - 0.013, east: p.lng + 0.013 };
  const [cams, lots, speed] = await Promise.allSettled([bundledCameras(), catalogLots(box), enforcementPoints()]);
  if (!current()) return;
  const parts: string[] = [];
  const camRows = cams.status === "fulfilled" ? nearest(cams.value.cameras, p, 2500, 3) : [];
  if (camRows.length)
    parts.push(
      `<h2>附近即時影像</h2><ul class="list">${camRows
        .map((c) => `<li><div>${esc(c.name)}<small>${formatDistance(c.distance)}</small></div><button class="btn" data-cam="${esc(c.id)}">看影像</button></li>`)
        .join("")}</ul>`,
    );
  if (lots.status === "fulfilled") {
    const near = nearest(lots.value, p, 600, 999);
    const n = near.filter((l) => l.kind === "lot").length;
    const curb = near.length - n;
    parts.push(
      `<h2>附近停車（600 m）</h2><p>${n} 處停車場、${curb} 處路邊或車格 <button class="btn" id="plParking">看停車地圖</button></p>`,
    );
  }
  if (speed.status === "fulfilled") {
    const s = nearest(speed.value.points, p, 1000, 99);
    if (s.length) parts.push(`<p class="muted">1 km 內有 ${s.length} 個測速執法點（交通視角可看位置）。</p>`);
  }
  const el = body.querySelector("#plNear");
  if (!el) return;
  el.innerHTML = parts.join("");
  el.querySelectorAll<HTMLButtonElement>("[data-cam]").forEach((b) => b.addEventListener("click", () => deps.openCamera(b.dataset.cam!)));
  el.querySelector("#plParking")?.addEventListener("click", () => {
    deps.sheet.close();
    deps.focusLens("parking");
    deps.map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(deps.map.getZoom(), 16) });
  });
}

export async function reverseName(p: Point): Promise<string | null> {
  try {
    const d = await getJson<{ features?: Array<{ properties?: Record<string, string> }> }>(
      `https://photon.komoot.io/reverse?lat=${p.lat.toFixed(5)}&lon=${p.lng.toFixed(5)}&limit=1`,
      { timeout: 8000 },
    );
    const q = d.features?.[0]?.properties;
    if (!q) return null;
    return q.name || [q.district || q.city, q.street, q.housenumber].filter(Boolean).join(" ") || null;
  } catch {
    return null;
  }
}
