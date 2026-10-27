import { googleAvailable, siteGoogleKey } from "../data/google";
import { escapeHtml as esc } from "../lib/util";
import { BASES, OVERLAYS, type BaseId, type Basemap, type OverlayId } from "../map/basemap";
import type { ExtrasState, MapExtras } from "../map/extras";
import type { Sheet } from "./dom";

/** The map-type picker, laid out like Google Maps' layers sheet. */
export function openLayers(sheet: Sheet, basemap: Basemap, openSettings: (section: string) => void, extras: MapExtras): void {
  const reopen = () => openLayers(sheet, basemap, openSettings, extras);
  const fx = extras.get();
  const choice = basemap.choice();
  const shown = basemap.effective();
  const google = googleAvailable();
  const body = sheet.open(
    "layers",
    "LAYERS",
    "地圖類型",
    `<div class="basemaps">${(Object.keys(BASES) as BaseId[])
      .map((id) => {
        const b = BASES[id];
        const locked = b.google && !google;
        return `<button class="basemap" data-base="${id}" aria-pressed="${shown.base === id}"${locked ? ' data-locked="true"' : ""}><span class="swatch sw-${id}" aria-hidden="true"></span>${esc(b.label)}<small>${esc(locked ? "需要 Google 金鑰" : b.note)}</small></button>`;
      })
      .join("")}</div>
    <h2>地圖詳細資料</h2>
    <div class="basemaps">${(Object.keys(OVERLAYS) as OverlayId[])
      .map((id) => {
        const off = !BASES[shown.base].google;
        return `<button class="basemap" data-overlay="${id}" aria-pressed="${!off && choice.overlays.includes(id)}"${off ? ' data-locked="true"' : ""}><span class="swatch sw-${id}" aria-hidden="true"></span>${esc(OVERLAYS[id].label)}<small>${off ? "選 Google 地圖後可用" : "Google"}</small></button>`;
      })
      .join("")}</div>
    <h2>地圖效果</h2>
    <div class="basemaps">
      <button class="basemap" data-extra="buildings" aria-pressed="${fx.buildings}"><span class="swatch sw-buildings" aria-hidden="true"></span>3D 建築<small>放大到街道，按 3D 傾斜看</small></button>
      <button class="basemap" data-extra="daynight" aria-pressed="${fx.daynight}"><span class="swatch sw-daynight" aria-hidden="true"></span>日夜分界<small>即時晨昏線與太陽位置</small></button>
    </div>
    <p class="micro">${
      google
        ? `${siteGoogleKey() ? "本站已提供 Google 地圖，不用設定。" : "使用你自己的 Google 金鑰。"}選 Google 地圖時，搜尋也會找到和 Google 地圖一樣的店家。Google 沒有開放大眾運輸與單車圖層給其他 App；公車即時位置在「交通」。`
        : `Google 地圖需要金鑰。<button class="link" id="layersKey">到設定加入</button>`
    }</p>`,
  );
  body.querySelectorAll<HTMLButtonElement>("[data-base]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (b.dataset.locked) return openSettings("google");
      await basemap.set({ ...basemap.choice(), base: b.dataset.base as BaseId });
      reopen();
    }),
  );
  body.querySelectorAll<HTMLButtonElement>("[data-overlay]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (b.dataset.locked) return;
      const id = b.dataset.overlay as OverlayId;
      const current = basemap.choice();
      const overlays = current.overlays.includes(id) ? current.overlays.filter((o) => o !== id) : [...current.overlays, id];
      await basemap.set({ ...current, overlays });
      reopen();
    }),
  );
  body.querySelectorAll<HTMLButtonElement>("[data-extra]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.extra as keyof ExtrasState;
      extras.set({ [id]: !extras.get()[id] });
      reopen();
    }),
  );
  body.querySelector("#layersKey")?.addEventListener("click", () => openSettings("google"));
}
