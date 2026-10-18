# AGENTS.md — 給 AI 助手（Claude Code、Codex 等）的專案說明

每次開始工作前請先讀完這份檔案。擁有者習慣用中文溝通，請用中文回覆。

## 專案概要

百眼（repo／Worker 名稱仍是 geodeck-globe）：手機優先的 3D 地球情報地圖（Vite + TypeScript + MapLibre GL JS v6 地球投影），
部署在 Cloudflare Worker `geodeck-globe`（`worker/` 提供靜態檔與 `/relay` 轉送）。
目標是「上帝之眼」的視覺與即時感，加上每天用得到的天氣、交通、停車。

- `src/map/`：地圖與深色戰術風格樣式（`style.ts`）、圖示、圖層工具
- `src/lenses/`：五個視角（`weather`、`traffic`、`parking`、`sky`、`radio`），各自管理圖層與更新計時；
  地震在天氣視角（`quakes.ts`），風場動畫是 `src/ui/wind.ts`＋`src/data/wind.ts`
- `src/ui/pin.ts`：點地圖先落下標記（可拖動），點標記卡片才開地點資訊；搜尋結果也會標記位置
- `src/data/`：各資料來源的讀取與解析（`tdx.ts`、`cwa.ts`、`weather.ts`、`sky.ts`、`parking.ts`…）
- `src/ui/`：此刻列、地點卡、搜尋、收藏、設定
- `worker/relay.ts`：轉送白名單（純函式，有測試）
- `worker/resolve.ts` + `/api/resolve`：追 Google 地圖分享短網址到實際地點；`src/data/maplinks.ts` 解析各種地圖連結
- `src/map/basemap.ts` + `src/ui/layers.ts`：底圖切換（百眼深色／Google 標準、深色、衛星、地形＋路況、街景範圍），
  Google 圖磚走 Map Tiles API，圖層合併在同一個 session（每格只計費一次）；必須顯示 Google 標誌與版權字
- `src/data/google.ts`：Google 地點搜尋。站長金鑰在建置時由 `GOOGLE_MAPS_KEY` secret 注入
  （`VITE_GOOGLE_MAPS_KEY`，瀏覽器金鑰，必須限制網址）；使用者也可在設定填自己的（優先使用）
- `worker/camera.ts` + `/api/cam`：只限 `*.gov.tw` 的 http 影像串流轉接（https 頁面不能載入 http 影像）
- `src/ui/locate.ts`：定位藍點、精度圈、指南針扇形（iOS 要在點擊當下要求方向權限）
- `src/ui/track.ts`：點選追蹤（鏡頭跟隨、軌跡、駕駛艙視角、目標面板）；`src/ui/detect.ts`：偵測框 HUD（canvas）
- `src/data/passes.ts`：衛星過境與肉眼可見判斷（太陽位置、地球陰影）、行事曆檔；`src/data/launches.ts`：火箭發射
- `src/ui/share.ts`：分享畫面連結（`?c=lat,lng&z=&b=&p=&l=&fx=&m=&t=`），開啟時在地圖啟動前套用

## 常用指令

- `npm ci`、`npm test`、`npm run build`（提交前兩者都必須通過）
- `npm run screenshots`：用假資料截手機畫面並做煙霧測試（停車／交通狀態列不能有錯誤、定位扇形、
  分享連結能打開地點）；CI 部署前會跑，失敗就不部署（需先 build，`CHROMIUM_PATH` 可指定瀏覽器）
- `npm run probe`：實測所有資料來源（CI 每次都會跑，結果在 Actions Summary）
- `node scripts/render-icons.mjs`：改 `public/icon.svg`／`icon-maskable.svg` 後重畫 PNG 圖示

## 必須遵守

1. **金鑰各自申請**：TDX、氣象署金鑰只能由使用者在設定頁輸入，存在 localStorage。不要把任何人的金鑰
   寫進程式、設定檔、測試或 CI 打包流程；CI 用的 `PROBE_*` secrets 只給 `scripts/live-probe.mjs`。
2. **轉送伺服器**：只加必要的主機與路徑到 `RELAY_RULES`；`keyed: true` 的規則 `ttl` 必須是 0
   （測試會檢查）。不要讓轉送變成任意網址代理。
3. **資料誠實**：顯示來源與時間；沒有時間的即時數字不當成即時；即時車位超過 5 分鐘顯示「?」
   （`LIVE_MAX_AGE_MS`）；缺值顯示「—」或「未知」，不要當成 0 或「沒有」。
4. **不要用會計費的服務**（Google Places／Routes／3D Tiles 等）當預設功能；要加先問擁有者。
   擁有者已同意（2026-10-18）用站長金鑰提供 Google 地圖圖磚與地點搜尋，讓使用者不用設定：
   有金鑰時預設 Google 標準地圖，可在「圖層」改回百眼深色。Google 搜尋結果只在 Google 底圖上使用
   （Google 條款不允許把 Google 內容放在非 Google 地圖上），所以百眼深色時搜尋改用 OpenStreetMap。
5. **手機優先**：改介面後跑 `npm run screenshots`，看 393×852 直向與 852×393 橫向，按鈕不能互相遮住。
   觸控目標至少 40px；輸入框字級 16px（避免 iOS 放大）。
6. **效能**：手機上不要每格重建大量圖層；資料更新用 `setData`。Starlink 這類數千點的圖層要降頻。
7. **安全**：來自資料來源的字串一律 `escapeHtml`；網址一律經過 `safeUrl`。
8. 打包的資料（`public/data/`）要能用 `scripts/` 裡的腳本重建，並保留授權檔（停車目錄含 ODbL 資料）。
9. 停車標記：方形藍底 P＝停車場、圓形綠底「路」＝路邊；旁邊數字＝即時剩餘格數（`pk-sign` 圖層）。
   沒有即時來源的停車場不顯示數字，不要拿總車位冒充剩餘格數。
   路邊的數字來自 TDX OnStreet（整個路段合計），放大到 13 級以上才讀。
10. **TDX 呼叫要省**：免費金鑰實測約每分鐘 5 次（第 6 次回 429，Retry-After ≈ 20 秒）。所有 TDX 呼叫經
   `tdxGet` 的優先佇列（停車 > 公車 > 影像清單），每分鐘最多 5 次並遵守 Retry-After；位置、名稱、
   影像清單用 `tdxStatic` 快取 6 小時（小的清單也存進 localStorage，最多 4 份）；停車只讀地圖中心的城市，
   公車每分鐘更新一次。新增 TDX 功能前先算每分鐘會多用幾次。
11. **航班**：只有 adsb.lol 偶爾接受 Cloudflare；轉送有 `staleTtl`（來源拒絕時回最後一份好資料，標頭 `x-relay-cache: STALE`）。
   App 用每架飛機的資料時間（`at`）推算位置，最多 `DEAD_RECKON_S` 秒，之後變淡並標示，不要假裝是即時位置。

## 部署

- push 到 `main` 會自動部署（需 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` secrets）。
- 擁有者在對話中要求的修改可以直接推 `main`（會自動部署，部署前有煙霧測試）；
  大幅改版或擁有者沒提過的方向，先放分支並說明。
