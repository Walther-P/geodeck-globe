# 百眼

手機優先的 3D 地球情報地圖。打開是一顆深色地球，自動轉到你上次看的地方；
上方「此刻」列一句話告訴你現在要注意什麼，下方四個「視角」一鍵切換整組資訊。

（repo 與網址沿用 `geodeck-globe`。）GeoDeck 0.7（[KTAK-DEV/geodeck](https://github.com/Walther-P/KTAK-DEV/tree/main/geodeck)）的後繼版本，
重新設計，沒有沿用舊程式；只沿用了舊版整理好的台灣停車目錄、測速點與公路影像目錄。

## 功能

| 區塊 | 內容 | 需要金鑰？ |
| --- | --- | --- |
| 地圖 | 免費深色向量地圖（OpenFreeMap），可從太空地球一路放大到 3D 建築；指北、3D 傾斜；夜視／熱感／CRT 畫面濾鏡 | 不用 |
| 定位 | 藍點跟著 GPS 移動、精度範圍、手機面向的扇形（指南針；iPhone 第一次會詢問方向權限） | 不用 |
| 地圖 | 百眼深色 3D 地球（免費）；有 Google 金鑰時可換成 **Google 標準／深色／衛星／地形**，加上**路況**與**街景範圍**，一樣是可旋轉的地球 | Google 地圖需金鑰（站長提供則免設定） |
| 搜尋 | 地名、路名、座標（OpenStreetMap）；**貼上或分享 Google／Apple 地圖連結**直接跳到同一個地點；用 Google 地圖時可搜到和 Google 地圖一樣的店家 | Google 搜尋同上 |
| 此刻列 | 我的位置或地圖中心：天氣、三小時內何時下雨、AQI、附近 6 小時內 M4+ 地震、所在縣市天氣特報 | 特報要氣象署 |
| 天氣視角 | 風場動畫（Open-Meteo）、地震（USGS／氣象署）、雷達回波（可回放）、向日葵衛星雲圖、颱風路徑與七級風圈、天氣特報 | 颱風、特報要氣象署 |
| 交通視角 | 台灣 11,514 支道路與河川影像，加上國外 17 個地區約 14,000 支官方道路鏡頭（香港、新加坡、紐西蘭、澳洲、芬蘭、倫敦、西班牙、冰島、紐約、加州、加拿大…），看到該地區才載入；點開直接看畫面（即時串流或每 30 秒至 5 分鐘更新的快照）；警政署測速點；公車即時位置；有 TDX 時改用官方的縣市即時影像 | 公車要 TDX；Windy 全球網路攝影機要站長金鑰 |
| 停車視角 | 全台與離島 69,723 個停車位置；藍色方形 P＝停車場、綠色圓形「路」＝路邊，旁邊數字是即時剩餘格數（綠多、橙快滿、紅滿、灰 ? 為資料超過 5 分鐘）；台灣以外改用 OpenStreetMap 全球停車場（放大到街道顯示，點開看收費、營業時間、總車位，沒有即時格數）；我的停車位置 | 即時車位要 TDX |
| 天空視角 | 即時航班（ADS-B）、衛星與太空站、Starlink、近期火箭發射；**點飛機或衛星即鎖定追蹤**（鏡頭跟隨、漸淡軌跡、即時數據、駕駛艙視角）；**過境預報**（國際太空站等何時從你頭上飛過、能不能用肉眼看到，可加入行事曆） | 不用 |
| 電台視角 | 全球廣播電台（Radio Browser），點地圖上的紫點直接收聽，「隨機一台」飛到世界某處開始播 | 不用 |
| 點地圖 | 先落下標記（可拖動微調），點標記上的卡片才打開該處天氣與資訊 | 不用 |
| 畫面模式 | 夜視、熱感（白熱／鐵虹）、CRT、黑白、雪地；**偵測框 HUD** 框出畫面中的飛機與衛星 | 不用 |
| 分享畫面 | 一個連結帶著視角、圖層、畫面模式、底圖與追蹤目標，對方打開看到一樣的畫面 | 不用 |
| 地點卡 | 點地圖任何一點：逐時天氣（降雨機率＋雨量）、空氣品質、附近影像與停車、交給導航 App、收藏、分享 | 不用 |
| 收藏 | 收藏地點、備註、停車位置，存在裝置上，離線可看，可匯出／匯入備份 | 不用 |

## 金鑰：每個人用自己的

本站**不提供共用金鑰**，也不在程式碼裡放任何人的金鑰。使用者在「⚙ 設定 → 資料金鑰」貼上自己的：

- **TDX 運輸資料流通服務**（免費）：<https://tdx.transportdata.tw/register> 註冊 → 會員中心 → API 金鑰，取得 Client Id 與 Client Secret。
- **中央氣象署開放資料**（免費）：<https://opendata.cwa.gov.tw/user/authkey> 登入 → 取得授權碼（CWA- 開頭）。

**Google 地圖與搜尋**：站長在 repository secrets 設定 `GOOGLE_MAPS_KEY`（瀏覽器金鑰，限制在本站網址）後，
所有人打開就是 Google 地圖、搜得到和 Google 地圖一樣的店家，不用任何設定；使用者也可以在設定填自己的金鑰
（Google Cloud：啟用 Map Tiles API、Maps JavaScript API、Places API (New)，金鑰限制在本站網址；需要帳單帳戶，
每月有免費用量：地圖圖磚每月 10 萬格）。沒有金鑰也能用百眼深色地圖，也能貼上 Google 地圖的分享連結。

金鑰只存在該使用者手機的瀏覽器（localStorage），直接送到官方網站；只有官方網站不允許瀏覽器直接讀取時，
才會經過本站 Worker 的轉送（`/relay`），轉送不儲存、不快取、不記錄帶金鑰的請求（見 `worker/relay.ts`）。

## 部署（Cloudflare Workers）

`main` 每次 push 由 `.github/workflows/deploy.yml` 建置、測試並部署到 Worker `geodeck-globe`
（網址會是 `https://geodeck-globe.<你的子網域>.workers.dev`）。需要在 GitHub repository 設定兩個 secrets，
可以直接沿用 THUNDER SQUAD 的同一組：

- `CLOUDFLARE_API_TOKEN`：有 Edit Cloudflare Workers 權限的 token
- `CLOUDFLARE_ACCOUNT_ID`

沒有設定時只會建置與測試，不會部署。流程也會在真實瀏覽器裡實測每個資料來源（直連與轉送是否可用、
回傳格式是否符合），結果在 Actions 的 Summary。若想一併實測 TDX／氣象署，可另外設定只給 CI 用的
`PROBE_TDX_ID`、`PROBE_TDX_SECRET`、`PROBE_CWA_KEY`（不會被打包進網站）。

## 開發

```sh
npm ci
npm run dev          # Vite 開發伺服器（沒有 /relay，需要轉送的來源會改走直連）
npm run build        # 型別檢查 + 正式版建置到 dist/
npm run dev:worker   # 用 wrangler 在本機跑完整 Worker（含 /relay），先 build
npm test             # 單元測試
npm run screenshots  # 以假資料截手機畫面到 artifacts/screenshots/（需先 build）
npm run probe        # 實測所有資料來源（TEST_URL 指向執行中的站）
```

`scripts/import-geodeck-data.mjs` 從 GeoDeck 0.7 的 `geodeck/data` 重新匯入停車、測速與影像目錄；
`scripts/build-land.mjs` 重建離線陸地輪廓；`scripts/render-icons.mjs` 重畫主畫面圖示。

## 資料原則

- 每筆資料標示來源與時間；沒有時間的即時數字不當成即時。
- 即時車位超過 5 分鐘不顯示數字（顯示「?」），沒有資料不等於有空位。
- 天氣是模式預報，雷達透明不代表沒下雨；ADS-B 是社群接收，不是所有飛機。
- 測速點標的是該點速限，不是你目前道路的速限。
- 所有資料都可能延遲、不完整或錯誤，不能當成緊急應變或行車安全的唯一依據。

完整來源與授權見 [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md)。

## 和 Google 地圖互通

- **Google 地圖 → 這裡**：在 Google 地圖的地點按「分享」→「複製連結」，回來點搜尋框右邊的 ⧉（或長按貼上）。
  Android 把 GeoDeck 加到主畫面後，分享選單會直接出現 GeoDeck。短網址（maps.app.goo.gl）由本站 Worker 的
  `/api/resolve` 追到實際地點（`worker/resolve.ts`）。
- **這裡 → Google 地圖**：地點卡的「用 Google 地圖導航」；從 Google 搜尋來的地點會直接打開那家店。

## 做不到的事（網頁 App 的限制）

- 逐向導航、背景定位、鎖屏提醒：交給 Google 地圖／Apple 地圖／NAVER；開車時建議照常用導航加神盾。
- 離線底圖只有「看過的範圍」和全球陸地輪廓。
