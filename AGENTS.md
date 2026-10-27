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
- `src/data/worldcams.ts`：國外官方道路影像（16 個地區＋要站長金鑰的 Windy、511），地圖看到該地區才讀清單；
  解析器都是純函式（`tests/world.test.ts`）。新增來源前先用 CI 實測清單與影像網址（`scripts/live-probe.mjs` 的 Cams 列）
- `src/data/osmparking.ts`：台灣停車目錄以外的停車場，直接用底圖向量圖磚的 `poi`／`class=parking`（`pk-osm` 圖層），
  點開才用 OSM API 讀標籤；Overpass 公共伺服器常常滿載，不要當主要來源。充電站同樣從圖磚讀（`subclass=charging_station`，
  `pk-ev` 圖層），點開讀插座、功率、收費
- `src/data/cityparking.ts`：免金鑰的即時車位（臺北、桃園、臺中自己發布的檔案；新北拒絕外部讀取、臺南停車網對 Cloudflare 回空白頁，這兩市仍走 TDX）。臺北只有編號與格數，位置、名稱、
  費率用停車目錄同編號（`taipei-TPE0001`）補上；每個城市的下載保留一分鐘，平移地圖只重新對應畫面中的停車場
- `src/data/heading.ts`：影像的拍攝方向（地圖上鏡頭圖示下的扇形，`tr-cam-fan` 圖層）。只用來源自己說的：名稱裡的
  「向北／往東」（不含「車行往北」這種車流方向）、國外來源的方向欄位（紐西蘭說明、新南威爾斯 direction、卑詩 orientation、
  冰島「séð til」）。國道只標示監看哪個方向的車道，扇形改用虛線、沿著前後鏡頭推出的道路方向畫；沒有方向的鏡頭不畫扇形，不要猜
- `src/data/bikes.ts`：共享單車（CityBikes，全球約 800 個系統，台灣各縣市 YouBike 都在內），交通圖層 14 級以上才讀
- `src/map/extras.ts` + `src/data/sun.ts`：所有底圖共用的 3D 建築（OpenFreeMap `building` 高度）與日夜線、晨昏帶，
  圖層選單「地圖效果」可關；日夜線每分鐘依太陽位置重算
- `src/data/taiwan.ts` + `src/data/counties.ts`：判斷一個點在哪個縣市（真實縣市界線，`node scripts/build-counties.mjs` 產生；
  以前只用矩形，臺中車站被當成彰化、板橋被當成臺北）。海上或小島才退回矩形
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
3. **資料誠實**：顯示來源與時間；沒有時間的即時數字不當成即時；即時車位超過 5 分鐘顯示「?」（`LIVE_MAX_AGE_MS`；
   臺北檔案每 5 分鐘發布且晚 2–3 分鐘出現，放寬為 10 分鐘，`LiveLot.maxAgeMs`）；缺值顯示「—」或「未知」，不要當成 0 或「沒有」。
4. **不要用會計費的服務**（Google Places／Routes／3D Tiles 等）當預設功能；要加先問擁有者。
   擁有者已同意（2026-10-18）用站長金鑰提供 Google 地圖圖磚與地點搜尋，讓使用者不用設定：
   有金鑰時預設 Google 標準地圖，可在「圖層」改回百眼深色。Google 搜尋結果只在 Google 底圖上使用
   （Google 條款不允許把 Google 內容放在非 Google 地圖上），所以百眼深色時搜尋改用 OpenStreetMap。
5. **手機優先**：改介面後跑 `npm run screenshots`，看 393×852 直向與 852×393 橫向，按鈕不能互相遮住。
   觸控目標至少 40px；輸入框字級 16px（避免 iOS 放大）。
   整頁不能被放大：雙指縮放和連點只作用在地圖（viewport `user-scalable=no`、全域 `touch-action: pan-x pan-y`、
   擋 iOS 的 `gesturestart`）；`phone-locate` 截圖會在介面上雙指放大，頁面放大就算失敗。
6. **效能**：手機上不要每格重建大量圖層；資料更新用 `setData`。Starlink 這類數千點的圖層要降頻。
7. **安全**：來自資料來源的字串一律 `escapeHtml`；網址一律經過 `safeUrl`。
8. 打包的資料（`public/data/`）要能用 `scripts/` 裡的腳本重建，並保留授權檔（停車目錄含 ODbL 資料）。
9. 停車標記：方形藍底 P＝停車場、圓形綠底「路」＝路邊；旁邊數字＝即時剩餘格數（`pk-sign` 圖層）。
   每個 P 旁邊都要有字：即時剩餘格數、「滿」，或灰色「?」（沒有即時資料、資料過時、或國外 OpenStreetMap 停車場；
   擁有者 2026-10-26 要求）。數字一律允許重疊、不能被擠掉；不要拿總車位冒充剩餘格數。13 級以上就顯示個別標記（12 級以下才群聚）。
   路邊的數字來自 TDX OnStreet（整個路段合計），放大到 13 級以上才讀。
   停車場的數字：臺北、桃園、臺中用城市自己的開放資料（任何人都看得到，不用金鑰，也不花使用者的 TDX 額度）；
   其他縣市要使用者自己的 TDX 金鑰。共享單車的數字同理：超過 15 分鐘就顯示「?」。
10. **TDX 呼叫要省**：免費金鑰實測約每分鐘 5 次（第 6 次回 429，Retry-After ≈ 20 秒）。所有 TDX 呼叫經
   `tdxGet` 的優先佇列（停車 > 公車 > 影像清單），每分鐘最多 5 次並遵守 Retry-After；位置、名稱、
   影像清單用 `tdxStatic` 快取 6 小時（小的清單也存進 localStorage，最多 4 份）；停車只讀地圖中心的城市，
   公車每分鐘更新一次。新增 TDX 功能前先算每分鐘會多用幾次。
11. **航班**：只有 adsb.lol 偶爾接受 Cloudflare；轉送有 `staleTtl`（來源拒絕時回最後一份好資料，標頭 `x-relay-cache: STALE`）。
   App 用每架飛機的資料時間（`at`）推算位置，最多 `DEAD_RECKON_S` 秒，之後變淡並標示，不要假裝是即時位置。

12. **站長金鑰（攝影機）**：`WINDY_WEBCAMS_KEY`、`ON511_KEY`、`AB511_KEY`、`NY511_KEY` 是 GitHub secrets，部署時
   寫成 Worker secrets（`deploy.yml`），轉送依 `RelayRule.siteKey` 加在送出的請求上；網頁、快取鍵、記錄都不能出現金鑰。
   沒設金鑰時轉送回 501，App 安靜地不顯示該來源。國外影像只接政府或網站正式公開的鏡頭，不接私人或被破解的監視器。

## 部署

- push 到 `main` 會自動部署（需 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` secrets）。
- 擁有者在對話中要求的修改可以直接推 `main`（會自動部署，部署前有煙霧測試）；
  大幅改版或擁有者沒提過的方向，先放分支並說明。
