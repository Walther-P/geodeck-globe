# 資料來源與授權

| 資料 | 來源 | 取得方式 | 授權／條款 | 更新 |
| --- | --- | --- | --- | --- |
| 底圖向量圖磚、字型 | [OpenFreeMap](https://openfreemap.org)（OpenMapTiles 格式） | 瀏覽器直連 | 資料 © OpenStreetMap 貢獻者（ODbL）；圖磚架構 © OpenMapTiles | 每週 |
| 離線陸地輪廓 | [Natural Earth](https://www.naturalearthdata.com) 1:110m（world-atlas） | 打包在 `public/data/land-110m.json` | 公有領域 | 固定 |
| 天氣、15 分鐘降雨、逐時預報 | [Open-Meteo](https://open-meteo.com) | 直連 | CC BY 4.0；免費方案限非商業 | 每小時（模式） |
| 空氣品質 | Open-Meteo Air Quality（CAMS） | 直連 | CC BY 4.0 | 每小時（模式） |
| 雷達回波 | [RainViewer](https://www.rainviewer.com/api.html) | 直連 | RainViewer 免費 API 條款（需標示） | 約 10 分鐘 |
| 衛星雲圖 | [NASA GIBS](https://www.earthdata.nasa.gov/gibs)：Himawari／GOES 紅外線、MODIS | 直連 | NASA 開放資料 | 10 分鐘至每日 |
| 全球地震 | [USGS](https://earthquake.usgs.gov/earthquakes/feed/) 24 小時 M2.5+ | 直連，失敗改轉送 | 公有領域 | 每分鐘 |
| 地震報告、颱風路徑、天氣特報 | [中央氣象署開放資料](https://opendata.cwa.gov.tw) E-A0015-001、E-A0016-001、W-C0034-005、W-C0033-001 | 使用者自己的授權碼，直連，失敗改轉送（不快取） | 政府資料開放授權條款第 1 版 | 即時 |
| 航班 | 社群 ADS-B：adsb.lol、airplanes.live、adsb.fi、adsb.one、OpenSky（依序嘗試） | 都不允許瀏覽器直連，只能轉送；只有 adsb.lol 有時接受 Cloudflare 的伺服器。轉送保留最後一份成功的資料 10 分鐘，來源限流時先用它；App 依資料時間推算位置最多 2 分鐘 | 各網站條款 | 即時 |
| 火箭發射時程 | [The Space Devs Launch Library 2](https://thespacedevs.com/llapi) | 直連，失敗改轉送（快取 1 小時） | 免費方案每 IP 每小時 15 次 | 每小時 |
| 衛星軌道 | [CelesTrak](https://celestrak.org) GP 資料，SGP4 推算 | 轉送（快取 4 小時）；建置時另存快照 | CelesTrak 使用條款 | 每日 |
| 停車目錄 | OpenStreetMap ＋ 臺北、新北、桃園、臺中、臺南開放資料（GeoDeck 0.7 整理，2026-09-27） | 打包在 `public/data/parking/` | ODbL（含 OSM）＋政府資料開放授權條款；見 `public/data/parking/LICENSE.md` | 手動重建 |
| 即時車位、公車動態、道路影像（TDX） | [TDX 運輸資料流通服務](https://tdx.transportdata.tw) | 使用者自己的金鑰，直連，失敗改轉送（不快取） | 政府資料開放授權條款第 1 版 | 即時 |
| 測速執法點 | 內政部警政署「測速執法設置點」[資料集 7320](https://data.gov.tw/dataset/7320)（2026-09-20 快照，1,895 筆） | 打包 | 政府資料開放授權條款第 1 版 | 手動重建 |
| 公路影像目錄 | 高速公路局、公路局影像（座標與名稱來自 GeoDeck 0.7 的目錄快照，2026-09-20） | 打包；影像本身由主管機關伺服器提供 | 各主管機關 | 手動重建 |
| 停車場影像關聯 | 人工核對（目前：冷水坑 1 號停車場入口） | 打包 `parking-cameras.json` | — | 90 天未複核自動停用 |
| 地點搜尋、反查地名 | [Photon](https://photon.komoot.io)（OpenStreetMap） | 直連 | ODbL；公共伺服器合理使用 | — |
| 底圖（Google） | Google Map Tiles API 2D 圖磚（roadmap／satellite／terrain，layerTraffic、layerStreetview） | 站長金鑰或使用者自己的金鑰，瀏覽器直接讀；session 存在瀏覽器到過期前 1 天；不經本站轉送、不快取圖磚；顯示 Google 標誌與 viewport 版權字 | Google Maps Platform 條款；費用由金鑰擁有者負擔（每月 10 萬格免費） | 路況即時 |
| 地點搜尋（Google） | Google Places（Maps JavaScript API 的 Places 程式庫） | 同上；只在 Google 底圖時使用 | Google Maps Platform 條款；費用由金鑰擁有者負擔 | 即時 |
| 分享連結解析 | Google 地圖短網址（maps.app.goo.gl）→ 本站 `/api/resolve` 跟隨轉址，必要時讀頁面上的座標 | 只接受 Google 地圖網址、只跟隨 Google 網域，結果快取 1 天 | — | — |

## 公路影像目錄的處理

GeoDeck 0.7 的目錄有 11,514 支鏡頭，其中 4,302 支的影像網址是公路主管機關自己的伺服器
（freeway.gov.tw、thb.gov.tw），點開直接看官方串流。其餘 7,212 支（水利署、各縣市道路）只有
twipcam 轉載的靜態快照：只在有人點開那支鏡頭時才載入，標示出處，每 30 秒更新一次，不做縮圖或預載。
有 TDX 金鑰時，同位置（40 m 內）的官方縣市即時影像會取代轉載快照。官方影像如果只有 http，
經本站 `/api/cam` 轉接（只限 `*.gov.tw`），因為 https 網頁不能載入 http 影像。

## 轉送伺服器（`/relay`）

只轉送 `worker/relay.ts` 列出的主機與路徑；只接受本站網頁發出的請求；帶使用者金鑰的請求一律不快取、
不在使用者之間共用；回應上限 12 MB。

## 實測紀錄

`scripts/live-probe.mjs` 在 GitHub Actions 的 Chromium 裡，從本站網址實際讀取每個來源
（「直連」= 瀏覽器直接讀，需要對方允許 CORS；「轉送」= 經過本站 `/relay`）。

2026-10-18（GitHub Actions，美國機房）：

| 來源 | 直連 | 轉送 | 結果 |
| --- | --- | --- | --- |
| Open-Meteo 天氣／空氣 | 可 | 不需要 | 15 分鐘降雨 12 筆 |
| RainViewer 索引與圖磚 | 可 | 不需要 | 13 張雷達畫面 |
| NASA GIBS 向日葵雲圖 | 可 | 不需要 | DescribeDomains 標示的最新時間常常還沒有圖磚（404），往前 30 分鐘就有，App 用這個時間 |
| USGS 地震 | 可 | 可 | — |
| adsb.lol 航班 | **不可（CORS）** | GitHub 機房可；Cloudflare 回 429 | |
| airplanes.live 航班 | 不可（CORS） | GitHub 機房 403；Cloudflare 403 | |
| adsb.fi 航班 | 不可（CORS） | GitHub 機房可；Cloudflare 403 | |
| adsb.one 航班 | 不可（CORS） | Cloudflare 403 | |
| OpenSky 航班 | 不可（CORS） | Cloudflare 522（連線被拒） | |
| CelesTrak | 可 | 可 | 走轉送以便快取 4 小時，減輕 CelesTrak 負擔 |
| Photon 搜尋／反查 | 可 | 不需要 | 「赤崁樓」可找到 |
| OpenFreeMap TileJSON／字型 | 可 | 不需要 | 圖磚有 `name:zh-Hant` |
| Google 地圖頁面（`/api/resolve` 讀座標） | — | Cloudflare 回 429 | 短網址轉到沒有座標的網址時，改用網址裡的店名＋地址搜尋 |
| TDX（token 與資料） | **不可（CORS）** | Cloudflare 可 | 所以 TDX 一律經轉送（帶使用者自己的金鑰，不快取）；token、停車場、剩餘車位、CCTV、路邊路段、公車都已在正式網站實測 |
| TDX 連續呼叫 | — | 每分鐘第 6 次回 429 | 回應 `API rate limit exceeded`、`Retry-After` 約 20 秒（間隔 3 秒也一樣），所以是每分鐘額度；App 每分鐘最多 5 次、停車優先、靜態清單快取 6 小時 |
| Google 標誌圖檔 | 可（`<img>`） | — | `maps.gstatic.com/mapfiles/api-3/images/google_white5(_hdpi).png` 與 `www.gstatic.com` 品牌圖可載入；`developers.google.com` 的圖檔網址失效 |
| App 端到端（臺南停車＋TDX 金鑰） | — | 可 | 正式網站實測：「577 處 · 即時：停車場 76/108、路段 451/451 有 5 分鐘內資料」 |
| TDX 路邊停車 | — | 可 | `ParkingSegments`（`ParkingSegmentPosition` 為點）與 `CurbParkingSegmentAvailabilities`（每分鐘更新，有 `DataCollectTime`）；臺南、臺北已實測 |
| 氣象署 | 可 | 可 | 特報、地震報告、颱風（欄位為大寫開頭，例如 `TropicalCyclones.TropicalCyclone`） |

公路局、高公局影像用 `<img>` 顯示，不需要 CORS；它們的伺服器可能擋國外 IP，所以 CI 的直連結果不代表台灣使用者的情況。

### 航班的結論（2026-10-18）

五個免費 ADS-B 來源都不允許瀏覽器直接讀，而且都拒絕 Cloudflare Workers 的共用出口 IP；從其他機房
（GitHub Actions）則有兩個可用。要在正式網站顯示航班，需要一個不在 Cloudflare 上的轉送點
（例如 Supabase Edge Function），或等來源開放。App 目前會顯示「資料來源目前拒絕本站連線」，並每 3 分鐘
重試一次，不會一直打對方的伺服器。
