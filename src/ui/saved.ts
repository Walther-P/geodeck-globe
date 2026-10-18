import { exportBackup, importBackup, parkedCar, removePlace, savedPlaces, setParkedCar, updatePlace, type Place } from "../data/places";
import { ago } from "../lib/time";
import { escapeHtml as esc, formatCoord } from "../lib/util";
import type { Sheet } from "./dom";

export function openSaved(sheet: Sheet, toast: (t: string) => void, openPlace: (p: Place, intent?: "walk") => void): void {
  const rows = savedPlaces();
  const car = parkedCar();
  const body = sheet.open(
    "saved",
    "SAVED",
    "收藏與停車位置",
    `${car ? `<h2>我的車</h2><ul class="list"><li><div>${esc(car.note || "停車位置")}<small>${esc(ago(car.savedAt))} · ${formatCoord(car)}</small></div><button class="btn primary" id="svCar">走回車位</button></li></ul><div class="actions"><button class="btn danger" id="svCarClear">清除停車位置</button></div>` : ""}
    <h2>收藏地點</h2>
    ${
      rows.length
        ? `<ul class="list">${rows
            .map(
              (p) => `<li><div><button class="link" data-open="${esc(p.id)}">${esc(p.title)}</button><small>${p.note ? esc(p.note) + " · " : ""}${formatCoord(p, 3)}</small></div>
              <button class="icon-btn" data-edit="${esc(p.id)}" aria-label="編輯備註">✎</button><button class="icon-btn" data-del="${esc(p.id)}" aria-label="移除">✕</button></li>`,
            )
            .join("")}</ul>`
        : `<p class="muted">點地圖上任何位置，在地點卡按「☆ 收藏」。收藏和備註只存在這台裝置，離線也看得到。</p>`
    }
    <div class="actions"><button class="btn" id="svExport">匯出備份</button><label class="btn">匯入備份<input id="svImport" type="file" accept="application/json,.json" hidden></label></div>`,
  );
  body.querySelector("#svCar")?.addEventListener("click", () => openPlace({ lat: car!.lat, lng: car!.lng, title: "我的車" }, "walk"));
  body.querySelector("#svCarClear")?.addEventListener("click", () => {
    setParkedCar(null);
    openSaved(sheet, toast, openPlace);
  });
  body.querySelectorAll<HTMLElement>("[data-open]").forEach((b) =>
    b.addEventListener("click", () => {
      const p = rows.find((r) => r.id === b.dataset.open);
      if (p) openPlace(p);
    }),
  );
  body.querySelectorAll<HTMLElement>("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => {
      const p = rows.find((r) => r.id === b.dataset.edit);
      if (!p) return;
      const title = prompt("名稱", p.title);
      if (title === null) return;
      const note = prompt("備註", p.note) ?? p.note;
      updatePlace(p.id, { title: title.trim() || p.title, note });
      openSaved(sheet, toast, openPlace);
    }),
  );
  body.querySelectorAll<HTMLElement>("[data-del]").forEach((b) =>
    b.addEventListener("click", () => {
      removePlace(b.dataset.del!);
      openSaved(sheet, toast, openPlace);
    }),
  );
  body.querySelector("#svExport")!.addEventListener("click", () => {
    const blob = new Blob([exportBackup()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `geodeck-globe-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  body.querySelector<HTMLInputElement>("#svImport")!.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const n = importBackup(await file.text());
      toast(`已匯入 ${n} 個地點`);
      openSaved(sheet, toast, openPlace);
    } catch {
      toast("這個檔案不是 GeoDeck Globe 的備份");
    }
  });
}
