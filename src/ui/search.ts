import { googleSearch } from "../data/google";
import { hasGoogle } from "../data/keys";
import { extractUrl, resolveSharedPlace } from "../data/maplinks";
import { googleSearchUrl, searchPlaces, type Place } from "../data/places";
import { escapeHtml as esc, type Point } from "../lib/util";
import type { GlobeMap } from "../map/globe";
import { $ } from "./dom";

export interface SearchDeps {
  map: GlobeMap;
  choose(p: Place): void;
  openSettings(section: string): void;
}

export function setupSearch({ map, choose, openSettings }: SearchDeps): { runShared(text: string): Promise<void> } {
  const input = $<HTMLInputElement>("search");
  const box = $("searchResults");
  const clear = $("searchClear");
  const paste = $("searchPaste");
  let controller: AbortController | null = null;
  let timer = 0;
  let results: Place[] = [];

  const near = (): Point | null => {
    const c = map.getCenter();
    return map.getZoom() > 5 ? { lat: c.lat, lng: c.lng } : null;
  };
  const close = () => box.classList.add("hidden");
  const go = (p: Place) => {
    close();
    input.blur();
    map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 16), duration: 1800 });
    choose(p);
  };
  const show = (html: string) => {
    box.classList.remove("hidden");
    box.innerHTML = html;
  };
  const googleTip = () =>
    hasGoogle()
      ? ""
      : `<button class="tip" data-action="google-key">想跟 Google 地圖找到一樣的店家？<small>到設定加入你自己的 Google 搜尋金鑰（選填）</small></button>`;

  const render = (q: string, found: Place[], note = "") => {
    results = found;
    show(
      (note ? `<p>${esc(note)}</p>` : "") +
        (found.length
          ? found
              .map(
                (r, i) =>
                  `<button data-i="${i}" role="option">${esc(r.title)}<small>${r.source ? `<span class="src">${esc(r.source)}</span> ` : ""}${esc(r.subtitle || `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`)}</small></button>`,
              )
              .join("")
          : `<p>找不到「${esc(q)}」。可以改搜地標、路名或座標，或從 Google 地圖分享連結過來。</p>`) +
        `<a href="${esc(googleSearchUrl(q))}" target="_blank" rel="noopener">在 Google 地圖搜尋「${esc(q)}」<small>找到後按「分享」→ 複製連結，回來貼在這裡</small></a>` +
        googleTip(),
    );
  };

  /** A link or share text from Google/Apple Maps: jump straight to that place. */
  const runShared = async (text: string): Promise<void> => {
    controller?.abort();
    const mine = (controller = new AbortController());
    show(`<p>讀取地圖連結…</p>`);
    const place = await resolveSharedPlace(text, mine.signal);
    if (mine.signal.aborted) return;
    if (place?.lat !== undefined && place.lng !== undefined) {
      go({ lat: place.lat, lng: place.lng, title: place.title || "分享的地點", source: "地圖連結" });
      return;
    }
    if (place?.query) {
      input.value = place.query;
      await runQuery(place.query, "連結沒有座標，改用名稱搜尋，請確認是不是同一個地方：");
      return;
    }
    show(`<p>看不懂這個連結。請在 Google 地圖按「分享」→「複製連結」再貼上。</p>`);
  };

  const runQuery = async (q: string, note = "") => {
    controller?.abort();
    const mine = (controller = new AbortController());
    show(`<p>搜尋中…</p>`);
    try {
      const r = await searchPlaces(q, near(), mine.signal, hasGoogle() ? googleSearch : undefined);
      if (mine.signal.aborted) return;
      render(q, r.places, [note, r.googleError ? `Google 搜尋沒有結果：${r.googleError}` : ""].filter(Boolean).join(" "));
    } catch (e) {
      if (mine.signal.aborted) return;
      render(q, [], `搜尋暫時無法使用：${(e as Error).message}`);
    }
  };

  const run = () => {
    const q = input.value.trim();
    clear.classList.toggle("hidden", !q);
    paste.classList.toggle("hidden", !!q);
    if (extractUrl(q)) return void runShared(q);
    if (q.length < 2) return close();
    void runQuery(q);
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(run, 450);
  });
  $("searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    clearTimeout(timer);
    run();
  });
  box.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-action='google-key']")) {
      close();
      openSettings("google");
      return;
    }
    const b = target.closest<HTMLElement>("[data-i]");
    if (b) go(results[Number(b.dataset.i)]);
  });
  clear.addEventListener("click", () => {
    input.value = "";
    clear.classList.add("hidden");
    paste.classList.remove("hidden");
    close();
    input.focus();
  });
  paste.addEventListener("click", async () => {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      input.focus();
      show(`<p>請在搜尋框長按 →「貼上」Google 地圖的分享連結。</p>`);
      return;
    }
    if (!text.trim()) return show(`<p>剪貼簿是空的。先在 Google 地圖按「分享」→「複製連結」。</p>`);
    input.value = text.trim();
    clear.classList.remove("hidden");
    paste.classList.add("hidden");
    run();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!(e.target as HTMLElement).closest(".top")) close();
  });
  return { runShared };
}
