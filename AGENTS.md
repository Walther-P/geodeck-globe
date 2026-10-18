# AGENTS.md — 給 AI 助手（Claude Code、Codex 等）的專案說明

每次開始工作前請先讀完這份檔案。擁有者習慣用中文溝通，請用中文回覆。

## 專案概要

GeoDeck Globe：手機優先的 3D 地球情報地圖（Vite + TypeScript + MapLibre GL JS v6 地球投影），
部署在 Cloudflare Worker `geodeck-globe`（`worker/` 提供靜態檔與 `/relay` 轉送）。
目標是「上帝之眼」的視覺與即時感，加上每天用得到的天氣、交通、停車。

- `src/map/`：地圖與深色戰術風格樣式（`style.ts`）、圖示、圖層工具
- `src/lenses/`：四個視角（`weather`、`traffic`、`parking`、`sky`），各自管理圖層與更新計時
- `src/data/`：各資料來源的讀取與解析（`tdx.ts`、`cwa.ts`、`weather.ts`、`sky.ts`、`parking.ts`…）
- `src/ui/`：此刻列、地點卡、搜尋、收藏、設定
- `worker/relay.ts`：轉送白名單（純函式，有測試）

## 常用指令

- `npm ci`、`npm test`、`npm run build`（提交前兩者都必須通過）
- `npm run screenshots`：用假資料截手機畫面（需先 build，環境變數 `CHROMIUM_PATH` 可指定瀏覽器）
- `npm run probe`：實測所有資料來源（CI 每次都會跑，結果在 Actions Summary）

## 必須遵守

1. **金鑰各自申請**：TDX、氣象署金鑰只能由使用者在設定頁輸入，存在 localStorage。不要把任何人的金鑰
   寫進程式、設定檔、測試或 CI 打包流程；CI 用的 `PROBE_*` secrets 只給 `scripts/live-probe.mjs`。
2. **轉送伺服器**：只加必要的主機與路徑到 `RELAY_RULES`；`keyed: true` 的規則 `ttl` 必須是 0
   （測試會檢查）。不要讓轉送變成任意網址代理。
3. **資料誠實**：顯示來源與時間；沒有時間的即時數字不當成即時；即時車位超過 5 分鐘顯示「?」
   （`LIVE_MAX_AGE_MS`）；缺值顯示「—」或「未知」，不要當成 0 或「沒有」。
4. **不要用會計費的服務**（Google Places／Routes／3D Tiles 等）當預設功能；要加先問擁有者。
5. **手機優先**：改介面後跑 `npm run screenshots`，看 393×852 直向與 852×393 橫向，按鈕不能互相遮住。
   觸控目標至少 40px；輸入框字級 16px（避免 iOS 放大）。
6. **效能**：手機上不要每格重建大量圖層；資料更新用 `setData`。Starlink 這類數千點的圖層要降頻。
7. **安全**：來自資料來源的字串一律 `escapeHtml`；網址一律經過 `safeUrl`。
8. 打包的資料（`public/data/`）要能用 `scripts/` 裡的腳本重建，並保留授權檔（停車目錄含 ODbL 資料）。

## 部署

- push 到 `main` 會自動部署（需 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` secrets）。
- 擁有者沒同意前不要直接改 `main`；改動先放分支。
