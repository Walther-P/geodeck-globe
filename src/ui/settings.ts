import { testCwa } from "../data/cwa";
import { siteGoogleKey, testGoogle } from "../data/google";
import { clearKeys, hasCwa, hasGoogle, hasTdx, keys, mask, saveKeys } from "../data/keys";
import { NAV_APPS, type NavApp } from "../data/places";
import { forgetTdxToken, testTdx } from "../data/tdx";
import { write } from "../lib/store";
import { escapeHtml as esc } from "../lib/util";
import type { Sheet } from "./dom";
import { navPreference } from "./place";

export const VERSION = "0.2.0";

export function openSettings(sheet: Sheet, toast: (t: string) => void, focus?: string, checkUpdate?: () => void): void {
  const k = keys();
  const pref = navPreference();
  const body = sheet.open(
    "settings",
    "SETTINGS",
    "設定與資料金鑰",
    `<h2 id="keys">資料金鑰（各自申請，只存在你的手機）</h2>
    <p class="muted">百眼不提供共用的 TDX／氣象署金鑰。公車、即時車位、更多道路影像需要 <b>TDX</b>；颱風、特報、氣象署地震報告需要<b>氣象署授權碼</b>。兩者都免費。沒有金鑰也能用：天氣、雷達、雲圖、全球地震、航班、衛星、停車目錄、測速點、公路影像。</p>

    <h2 id="tdx">TDX 運輸資料 ${hasTdx() ? '<span class="ok">● 已設定</span>' : ""}</h2>
    <ol class="steps">
      <li>到 <a href="https://tdx.transportdata.tw/register" target="_blank" rel="noopener">TDX 運輸資料流通服務</a> 免費註冊會員並完成信箱驗證。</li>
      <li>登入後在會員中心找到「API 金鑰」，複製 <b>Client Id</b> 與 <b>Client Secret</b>。</li>
      <li>貼到下面，按「儲存並測試」。</li>
    </ol>
    <label class="field"><span>Client Id（目前：${esc(mask(k.tdxId))}）</span><input id="tdxId" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(k.tdxId)}"></label>
    <label class="field"><span>Client Secret（目前：${esc(mask(k.tdxSecret))}）</span><input id="tdxSecret" type="password" autocomplete="off" value="${esc(k.tdxSecret)}"></label>
    <div class="actions"><button class="btn primary" id="saveTdx">儲存並測試 TDX</button></div>
    <p id="tdxResult" class="muted" role="status"></p>

    <h2 id="cwa">中央氣象署開放資料 ${hasCwa() ? '<span class="ok">● 已設定</span>' : ""}</h2>
    <ol class="steps">
      <li>到 <a href="https://opendata.cwa.gov.tw/user/authkey" target="_blank" rel="noopener">氣象資料開放平臺</a> 免費註冊／登入。</li>
      <li>登入後在會員資訊的「API授權碼」取得授權碼（開頭是 CWA-）。</li>
      <li>貼到下面，按「儲存並測試」。</li>
    </ol>
    <label class="field"><span>授權碼（目前：${esc(mask(k.cwa))}）</span><input id="cwaKey" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(k.cwa)}"></label>
    <div class="actions"><button class="btn primary" id="saveCwa">儲存並測試氣象署</button></div>
    <p id="cwaResult" class="muted" role="status"></p>

    <h2 id="google">Google 地點搜尋 ${hasGoogle() ? '<span class="ok">● 使用你的金鑰</span>' : siteGoogleKey() ? '<span class="ok">● 本站已提供</span>' : ""}</h2>
    <p class="muted">${
      siteGoogleKey()
        ? "本站已開啟 Google 地點搜尋，不用設定也能直接搜到和 Google 地圖一樣的店家。下面可以改用你自己的金鑰（選填）。"
        : "沒有這把金鑰也能搜尋（用 OpenStreetMap），也能貼上 Google 地圖的分享連結。加上自己的 Google 金鑰後，打「某某餐廳」就能找到和 Google 地圖一樣的店家。"
    }</p>
    <ol class="steps">
      <li>到 <a href="https://console.cloud.google.com/google/maps-apis/start" target="_blank" rel="noopener">Google Cloud 的 Maps Platform</a> 建立專案並啟用帳單（需要信用卡；Google 每月有免費用量，個人搜尋通常用不完）。</li>
      <li>在「API 和服務 → 程式庫」啟用 <b>Maps JavaScript API</b> 和 <b>Places API (New)</b>。</li>
      <li>「憑證 → 建立憑證 → API 金鑰」。編輯金鑰：應用程式限制選「網站」，加入 <code>${esc(location.origin)}/*</code>；API 限制只勾上面兩個。</li>
      <li>建議在「配額」把每日上限調低，就不會有意外費用。</li>
    </ol>
    <label class="field"><span>Google API 金鑰（目前：${esc(mask(k.google))}）</span><input id="googleKey" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(k.google)}"></label>
    <div class="actions"><button class="btn primary" id="saveGoogle">儲存並測試 Google</button></div>
    <p id="googleResult" class="muted" role="status"></p>

    <div class="note">金鑰只存在這台裝置的瀏覽器裡，直接送到 TDX／氣象署官方網站。只有在官方網站不允許瀏覽器直接讀取時，才會經過本站的轉送伺服器送出；轉送伺服器不儲存、不記錄金鑰。換手機或清除網站資料後要重新輸入。</div>
    <div class="actions"><button class="btn danger" id="clearKeys">清除這台裝置的所有金鑰</button></div>

    <h2>導航 App</h2>
    <label class="field"><span>按「導航」時開啟</span><select id="navApp">
      <option value="auto"${pref === "auto" ? " selected" : ""}>自動（台灣與多數國家用 Google 地圖，韓國用 NAVER）</option>
      ${(Object.keys(NAV_APPS) as NavApp[]).map((a) => `<option value="${a}"${pref === a ? " selected" : ""}>${esc(NAV_APPS[a])}</option>`).join("")}
    </select></label>

    <h2>加入主畫面</h2>
    <p class="muted">iPhone：Safari 分享 → 加入主畫面。Android：瀏覽器選單 → 安裝應用程式。</p>

    <h2>資料來源</h2>
    <p class="micro">底圖：OpenFreeMap／OpenMapTiles／© OpenStreetMap 貢獻者 · 陸地輪廓：Natural Earth<br>
    天氣與空氣：Open-Meteo（含 CAMS）· 雷達：RainViewer · 雲圖：NASA GIBS（向日葵／GOES）<br>
    地震：USGS、中央氣象署 · 颱風與特報：中央氣象署<br>
    航班：adsb.lol 社群接收（ODbL）· 衛星：CelesTrak 軌道根數 + SGP4<br>
    停車：© OpenStreetMap 貢獻者（ODbL）與臺北、新北、桃園、臺中、臺南開放資料；即時車位、公車、道路影像：TDX<br>
    測速點：內政部警政署開放資料 · 公路影像：交通部高速公路局、公路局<br>
    搜尋：Photon（OpenStreetMap）；設定 Google 金鑰後加上 Google Places</p>
    <p class="micro">所有資料都可能延遲、不完整或錯誤，不可作為緊急應變或行車安全的唯一依據。</p>

    <h2>關於</h2>
    <p class="micro">百眼 ${VERSION} · <a href="https://github.com/Walther-P/geodeck-globe" target="_blank" rel="noopener">原始碼</a></p>
    <div class="actions"><button class="btn" id="checkUpdate">檢查更新</button></div>`,
  );

  const result = (id: string, ok: boolean, text: string) => {
    const el = body.querySelector<HTMLElement>(id)!;
    el.className = ok ? "ok" : "bad";
    el.textContent = text;
  };

  body.querySelector("#saveTdx")!.addEventListener("click", async () => {
    saveKeys({ tdxId: body.querySelector<HTMLInputElement>("#tdxId")!.value, tdxSecret: body.querySelector<HTMLInputElement>("#tdxSecret")!.value });
    forgetTdxToken();
    if (!hasTdx()) return result("#tdxResult", false, "已清除 TDX 金鑰");
    result("#tdxResult", true, "測試中…");
    try {
      result("#tdxResult", true, `✓ ${await testTdx()}`);
    } catch (e) {
      result("#tdxResult", false, `✗ ${(e as Error).message}`);
    }
  });
  body.querySelector("#saveCwa")!.addEventListener("click", async () => {
    saveKeys({ cwa: body.querySelector<HTMLInputElement>("#cwaKey")!.value });
    if (!hasCwa()) return result("#cwaResult", false, "已清除氣象署授權碼");
    result("#cwaResult", true, "測試中…");
    try {
      result("#cwaResult", true, `✓ ${await testCwa()}`);
    } catch (e) {
      result("#cwaResult", false, `✗ ${(e as Error).message}`);
    }
  });
  body.querySelector("#saveGoogle")!.addEventListener("click", async () => {
    saveKeys({ google: body.querySelector<HTMLInputElement>("#googleKey")!.value });
    if (!hasGoogle()) return result("#googleResult", false, "已清除 Google 金鑰");
    result("#googleResult", true, "測試中…");
    try {
      result("#googleResult", true, `✓ ${await testGoogle()}`);
    } catch (e) {
      result("#googleResult", false, `✗ ${(e as Error).message}`);
    }
  });
  body.querySelector("#clearKeys")!.addEventListener("click", () => {
    clearKeys();
    forgetTdxToken();
    toast("已清除這台裝置的金鑰");
    openSettings(sheet, toast, undefined, checkUpdate);
  });
  body.querySelector<HTMLSelectElement>("#navApp")!.addEventListener("change", (e) => write("gdg.nav.v1", (e.target as HTMLSelectElement).value));
  body.querySelector("#checkUpdate")!.addEventListener("click", () => checkUpdate?.());
  if (focus) body.querySelector(`#${focus}`)?.scrollIntoView({ block: "start" });
}
