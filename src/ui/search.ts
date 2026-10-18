import { googleSearchUrl, searchPlaces, type Place } from "../data/places";
import { escapeHtml as esc } from "../lib/util";
import type { GlobeMap } from "../map/globe";
import { $ } from "./dom";

export function setupSearch(map: GlobeMap, choose: (p: Place) => void): void {
  const input = $<HTMLInputElement>("search");
  const box = $("searchResults");
  const clear = $("searchClear");
  let controller: AbortController | null = null;
  let timer = 0;
  let results: Place[] = [];

  const close = () => box.classList.add("hidden");
  const run = async () => {
    const q = input.value.trim();
    clear.classList.toggle("hidden", !q);
    if (q.length < 2) return close();
    controller?.abort();
    const mine = (controller = new AbortController());
    const c = map.getCenter();
    box.classList.remove("hidden");
    box.innerHTML = `<p>搜尋中…</p>`;
    try {
      results = await searchPlaces(q, map.getZoom() > 5 ? { lat: c.lat, lng: c.lng } : null, mine.signal);
      if (mine.signal.aborted) return;
      box.innerHTML =
        (results.length
          ? results.map((r, i) => `<button data-i="${i}" role="option">${esc(r.title)}<small>${esc(r.subtitle ?? `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`)}</small></button>`).join("")
          : `<p>OpenStreetMap 找不到「${esc(q)}」。台灣門牌地址收錄較少，可以改搜地標、路名或座標。</p>`) +
        `<a href="${esc(googleSearchUrl(q))}" target="_blank" rel="noopener">在 Google 地圖搜尋「${esc(q)}」<small>找到後可分享座標回來</small></a>`;
    } catch (e) {
      if (mine.signal.aborted) return;
      box.innerHTML = `<p>搜尋暫時無法使用：${esc((e as Error).message)}</p><a href="${esc(googleSearchUrl(q))}" target="_blank" rel="noopener">改用 Google 地圖搜尋</a>`;
    }
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(run, 450);
  });
  $("searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    clearTimeout(timer);
    void run();
  });
  box.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (!b) return;
    const p = results[Number(b.dataset.i)];
    close();
    input.blur();
    map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 15), duration: 1800 });
    choose(p);
  });
  clear.addEventListener("click", () => {
    input.value = "";
    clear.classList.add("hidden");
    close();
    input.focus();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!(e.target as HTMLElement).closest(".top")) close();
  });
}
