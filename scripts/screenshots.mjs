// Phone-size screenshots of the built app with every external feed answered by
// local fixtures, so the UI can be checked without network access.
//
//   npm run build && CHROMIUM_PATH=/path/to/chrome node scripts/screenshots.mjs
//
// Basemap tiles are refused on purpose: the shots show the offline globe.

import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { mkdirSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const root = new URL("../dist/", import.meta.url).pathname;
const out = new URL("../artifacts/screenshots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };

/** A tiny RGB PNG drawn by `pixel(x, y)`, for fixture map tiles and logos. */
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// Light "Google-like" tiles: grey land, white roads every 64 px, a red traffic stretch.
const GOOGLE_TILE = png(256, 256, (x, y) => (y % 64 < 6 && x > 120 && x < 200 ? [217, 48, 37] : x % 64 < 5 || y % 64 < 5 ? [255, 255, 255] : [232, 234, 237]));
const GOOGLE_LOGO = png(59, 18, () => [255, 255, 255]);

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "") || "index.html";
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;

const now = Date.now();
const sec = Math.floor(now / 1000);
const hourly = [...Array(48)].map((_, i) => Math.floor(now / 3600000) * 3600 + i * 3600);
const quarter = [...Array(12)].map((_, i) => Math.floor(now / 900000) * 900 + i * 900);
const day = 1 + (Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - Date.UTC(new Date().getUTCFullYear(), 0, 1)) / 86400000;
const epoch = `${String(new Date().getUTCFullYear()).slice(2)}${String(day.toFixed(8)).padStart(12, "0")}`;
const tle = (name, id, inc, raan, ma, mm) =>
  `${name}\n1 ${id}U 98067A   ${epoch}  .00016717  00000-0  10270-3 0  9005\n2 ${id} ${inc.padStart(8)} ${raan.padStart(8)} 0006703 130.5360 ${ma.padStart(8)} ${mm}563537\n`;

const openMeteo = () => ({
    utc_offset_seconds: 28800,
    current: { time: sec, temperature_2m: 27.4, apparent_temperature: 30.1, relative_humidity_2m: 78, weather_code: 2, wind_speed_10m: 11, is_day: 1 },
    minutely_15: { time: quarter, precipitation: [0, 0, 0, 0.2, 0.6, 1.1, 0.8, 0.3, 0, 0, 0, 0] },
    hourly: {
      time: hourly,
      temperature_2m: hourly.map((_, i) => 26 + 3 * Math.sin(i / 4)),
      precipitation_probability: hourly.map((_, i) => [10, 20, 60, 75, 40, 20, 10, 5][i % 8]),
      precipitation: hourly.map((_, i) => [0, 0, 1.2, 2.4, 0.4, 0, 0, 0][i % 8]),
      weather_code: hourly.map((_, i) => [2, 3, 61, 63, 61, 3, 2, 1][i % 8]),
    },
  });

/** Many points in one request is the wind grid: a north-east monsoon, stronger in the strait. */
function windRows(url) {
  const q = new URL(url).searchParams;
  const lngs = q.get("longitude").split(",").map(Number);
  return q.get("latitude").split(",").map((lat, i) => ({ current: { time: sec, wind_speed_10m: 4 + Math.abs(Math.sin(Number(lat) / 2 + lngs[i] / 3)) * 12, wind_direction_10m: 35 + 25 * Math.sin(lngs[i]) } }));
}

function radio(url) {
  if (new URL(url).pathname.startsWith("/json/url/")) return { ok: true };
  const st = (id, name, cc, country, lat, lng, clicks) => ({ stationuuid: id, name, url_resolved: `https://stream.example/${id}.mp3`, homepage: "https://radio.example/", favicon: "", country, countrycode: cc, state: "", language: "chinese", tags: "news,talk", codec: "MP3", bitrate: 128, geo_lat: lat, geo_long: lng, clickcount: clicks, hls: 0, lastcheckok: 1 });
  return [
    st("r1", "台北之音", "TW", "Taiwan", 25.04, 121.53, 900),
    st("r2", "台南知音廣播", "TW", "Taiwan", 22.99, 120.21, 500),
    st("r3", "高雄港都電台", "TW", "Taiwan", 22.62, 120.3, 420),
    st("r4", "BBC World Service", "GB", "United Kingdom", 51.5, -0.12, 9000),
    st("r5", "NHK Radio 1", "JP", "Japan", 35.68, 139.69, 4000),
    { ...st("r6", "http only", "TW", "Taiwan", 24.1, 120.6, 10), url_resolved: "http://insecure.example/x.mp3" },
  ];
}

const fixtures = {
  "api.open-meteo.com": (url) => ((new URL(url).searchParams.get("latitude") ?? "").includes(",") ? windRows(url) : openMeteo()),
  "de1.api.radio-browser.info": (url) => radio(url),
  "fi1.api.radio-browser.info": (url) => radio(url),
  "de2.api.radio-browser.info": (url) => radio(url),
  "air-quality-api.open-meteo.com": () => ({ current: { us_aqi: 42, pm2_5: 9.8 } }),
  "api.rainviewer.com": () => ({ host: "https://tilecache.rainviewer.com", radar: { past: [...Array(6)].map((_, i) => ({ time: sec - (5 - i) * 600, path: `/v2/radar/${sec - (5 - i) * 600}` })) } }),
  "earthquake.usgs.gov": () => ({
    features: [
      { id: "us7000a", geometry: { coordinates: [121.62, 23.95, 18] }, properties: { mag: 5.1, place: "21 km NNE of Hualien City, Taiwan", time: now - 40 * 60000, url: "https://earthquake.usgs.gov/" } },
      { id: "us7000b", geometry: { coordinates: [142.3, 37.8, 35] }, properties: { mag: 4.6, place: "off the east coast of Honshu, Japan", time: now - 5 * 3600000, url: "https://earthquake.usgs.gov/" } },
      { id: "us7000c", geometry: { coordinates: [125.1, 7.2, 60] }, properties: { mag: 4.9, place: "Mindanao, Philippines", time: now - 20 * 3600000, url: "https://earthquake.usgs.gov/" } },
    ],
  }),
  "api.adsb.lol": () => ({
    now: Date.now(),
    ac: [
      ["8964a1", "CAL7", "B-18901", "A359", 25.08, 121.23, 4200, 180, 230],
      ["899012", "EVA16", "B-16717", "B77W", 24.8, 121.6, 33000, 470, 45],
      ["8990a3", "JX802", "B-58301", "A321", 23.4, 120.4, 28000, 430, 20],
      ["899105", "CI113", "B-18316", "A333", 22.9, 120.9, 36000, 480, 200],
      ["8990ff", "IT201", "B-50003", "A320", 24.2, 120.1, 21000, 380, 350],
      ["8991aa", "BR108", "B-16721", "B77W", 25.4, 121.9, 38000, 495, 60],
    ].map(([hex, flight, r, t, lat, lon, alt, gs, track]) => ({ hex, flight, r, t, lat, lon, alt_baro: alt, gs, track, seen_pos: 1.2 })),
  }),
  "celestrak.org": () =>
    tle("ISS (ZARYA)", "25544", "51.6416", "247.4627", "325.0288", "15.721253") +
    tle("CSS (TIANHE)", "48274", "41.4700", "120.1000", "100.0000", "15.600000") +
    tle("HST", "20580", "28.4700", "300.1000", "200.0000", "15.100000"),
  "tdx.transportdata.tw": (url) => {
    const path = new URL(url).pathname;
    const lots = [
      ["A1", "府前路停車場", 22.9935, 120.2032, 42, 0],
      ["B2", "中正立體停車場", 22.9905, 120.2068, 6, 0],
      ["C3", "民生地下停車場", 22.9952, 120.2071, 0, 0],
      ["D4", "西門停車場", 22.9898, 120.2015, 15, 20],
    ];
    const iso = (minsAgo) => new Date(now - minsAgo * 60000).toISOString();
    if (path.endsWith("/token")) return { access_token: "demo", expires_in: 86400 };
    if (path.includes("/CarPark/City/Tainan"))
      return { CarParks: lots.map(([id, name, lat, lng]) => ({ CarParkID: id, CarParkName: { Zh_tw: name }, CarParkPosition: { PositionLat: lat, PositionLon: lng } })) };
    if (path.includes("/ParkingAvailability/City/Tainan"))
      return {
        UpdateTime: iso(1),
        ParkingAvailabilities: lots.map(([id, , , , free, age]) => ({ CarParkID: id, TotalSpaces: 120, AvailableSpaces: free, FullStatus: free === 0 ? 1 : 0, ServiceStatus: 1, DataCollectTime: iso(age + 1) })),
      };
    const curbs = [
      ["S1", "民生路一段", 22.9918, 120.2052, 5, 0],
      ["S2", "永福路二段", 22.9932, 120.2009, 0, 0],
      ["S3", "忠義路二段", 22.9946, 120.2045, 14, 0],
    ];
    if (path.includes("/ParkingSegment/City/Tainan"))
      return { ParkingSegments: curbs.map(([id, name, lat, lng]) => ({ ParkingSegmentID: id, ParkingSegmentName: { Zh_tw: name }, ParkingSegmentPosition: { PositionLat: lat, PositionLon: lng } })) };
    if (path.includes("/ParkingSegmentAvailability/City/Tainan"))
      return {
        UpdateTime: iso(1),
        CurbParkingSegmentAvailabilities: curbs.map(([id, , , , free, age]) => ({ ParkingSegmentID: id, TotalSpaces: 20, AvailableSpaces: free, FullStatus: free === 0 ? 1 : 0, ServiceStatus: 1, DataCollectTime: iso(age + 1) })),
      };
    return {};
  },
  // Tainan's own parking site (keyless counts); TDX above still serves the kerbside segments.
  "parkweb.tainan.gov.tw": () => {
    const tw = (minsAgo) => new Date(now - minsAgo * 60000 + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
    return [
      ["A1", "府前路停車場", 22.9935, 120.2032, 42, 1],
      ["B2", "中正立體停車場", 22.9905, 120.2068, 6, 2],
      ["C3", "民生地下停車場", 22.9952, 120.2071, 0, 1],
      ["D4", "西門停車場", 22.9898, 120.2015, 15, 20],
    ].map(([code, name, lat, lng, car, age]) => ({ code, name, address: "臺南市中西區", car, car_total: 120, chargeFee: "30元/時", update_time: tw(age), lnglat: `${lat},${lng}` }));
  },
  "api.citybik.es": (url) => {
    const path = new URL(url).pathname;
    if (path === "/v2/networks") return { networks: [{ id: "youbike-tainan", name: "YouBike", location: { latitude: 22.99, longitude: 120.21, city: "Tainan", country: "TW" } }] };
    const at = new Date(now - 60000).toISOString().replace("Z", "+00:00Z");
    return {
      network: {
        stations: [
          ["s1", "赤崁樓站", 22.9975, 120.2028, 8, 4],
          ["s2", "民生綠園站", 22.9925, 120.2053, 0, 16],
          ["s3", "孔廟站", 22.9905, 120.2075, 2, 12],
        ].map(([id, name, latitude, longitude, free_bikes, empty_slots]) => ({ id, name, latitude, longitude, free_bikes, empty_slots, timestamp: at, extra: { slots: 16, ebikes: 1, online: true, address: "臺南市中西區" } })),
      },
    };
  },
  "tile.googleapis.com": (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/createSession")) return { session: "demo-session", expiry: String(Math.floor(now / 1000) + 14 * 86400), tileWidth: 256, tileHeight: 256, imageFormat: "png" };
    if (path.includes("/viewport")) return { copyright: "Map data ©2026 Google" };
    return GOOGLE_TILE;
  },
  "maps.gstatic.com": () => GOOGLE_LOGO,
  "ll.thespacedevs.com": () => ({
    results: [
      { id: "l1", name: "Falcon 9 Block 5 | Starlink Group 12-3", net: new Date(now + 26 * 3600000).toISOString(), status: { abbrev: "Go", name: "Go for Launch" }, launch_service_provider: { name: "SpaceX" }, pad: { name: "SLC-40", latitude: "28.5618", longitude: "-80.577", location: { name: "Cape Canaveral, FL, USA" } } },
      { id: "l2", name: "Long March 2F | Shenzhou 23", net: new Date(now + 3 * 86400000).toISOString(), status: { abbrev: "TBC", name: "To Be Confirmed" }, launch_service_provider: { name: "CASC" }, pad: { name: "LC-43/91", latitude: "40.958", longitude: "100.291", location: { name: "Jiuquan, China" } } },
    ],
  }),
  "static.data.gov.hk": () =>
    `<?xml version="1.0" encoding="UTF-8"?><image-list>${[
      ["H210F", "香港仔隧道灣仔入口 [H210F]", 22.2747, 114.17936],
      ["H429F", "香港仔海傍道近魚市場 [H429F]", 22.24845, 114.1505],
      ["K109F", "彌敦道近窩打老道 [K109F]", 22.3203, 114.1694],
    ]
      .map(([key, d, lat, lng]) => `<image><key>${key}</key><description>${d}</description><latitude>${lat}</latitude><longitude>${lng}</longitude><url>https://tdcctv.data.one.gov.hk/${key}.JPG</url></image>`)
      .join("")}</image-list>`,
  "tdcctv.data.one.gov.hk": () => GOOGLE_TILE,
  "photon.komoot.io": () => ({ features: [{ geometry: { coordinates: [120.2049, 22.9908] }, properties: { name: "赤崁樓", city: "臺南市", district: "中西區", country: "臺灣", countrycode: "TW" } }] }),
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const shots = [
  { name: "phone-globe", w: 393, h: 852, view: { lng: 121, lat: 23.6, zoom: 1.8 }, lenses: ["sky"] },
  { name: "phone-taiwan-sky", w: 393, h: 852, view: { lng: 121, lat: 23.8, zoom: 6.6 }, lenses: ["weather", "sky"], tap: "now" },
  { name: "phone-tainan-parking", w: 393, h: 852, view: { lng: 120.205, lat: 22.992, zoom: 15.6 }, lenses: ["traffic", "parking"], healthy: true, tdx: true },
  { name: "phone-tainan-traffic", w: 393, h: 852, view: { lng: 120.205, lat: 22.992, zoom: 15.2 }, lenses: ["parking", "traffic"], healthy: true, expect: /YouBike：畫面中 3 站/ },
  // No key at all: Tainan's own feed still gives counts.
  { name: "phone-tainan-parking-open", w: 393, h: 852, view: { lng: 120.205, lat: 22.992, zoom: 15.6 }, lenses: ["traffic", "parking"], healthy: true, expect: /即時：停車場 3\/4 有最新資料/ },
  { name: "phone-locate", w: 393, h: 852, view: { lng: 120.205, lat: 22.992, zoom: 15 }, lenses: ["parking"], locate: true, pinchUi: true },
  {
    name: "phone-shared-link",
    w: 393,
    h: 852,
    view: { lng: 121, lat: 23.6, zoom: 7 },
    lenses: ["parking"],
    share: "https://www.google.com/maps/place/%E8%B5%A4%E5%B4%81%E6%A8%93/@22.997,120.2,17z/data=!3m1!4b1!4m6!3m5!1s0x1:0x2!8m2!3d22.997534!4d120.202568",
  },
  { name: "phone-pin", w: 393, h: 852, view: { lng: 120.205, lat: 22.992, zoom: 14 }, lenses: ["weather"], click: true, pinOnly: true },
  { name: "phone-place-card", w: 393, h: 852, view: { lng: 120.205, lat: 22.992, zoom: 14 }, lenses: ["weather"], click: true },
  { name: "phone-wind", w: 393, h: 852, view: { lng: 121, lat: 23.6, zoom: 6.2 }, lenses: ["weather"], chip: "wind", expect: /風場 .*m\/s/ },
  { name: "phone-radio", w: 393, h: 852, view: { lng: 121, lat: 23.8, zoom: 6.6 }, lenses: ["radio"], expect: /電台 [1-9]\d* 台/ },
  // Official cameras abroad load for the area in view; tapping one opens its picture.
  { name: "phone-hk-camera", w: 393, h: 852, view: { lng: 114.17936, lat: 22.2747, zoom: 15 }, lenses: ["traffic"], camera: "香港仔隧道灣仔入口" },
  // Outside the Taiwan catalog, parking switches to OpenStreetMap from the basemap tiles.
  { name: "phone-world-parking", w: 393, h: 852, view: { lng: 139.7005, lat: 35.6905, zoom: 16 }, lenses: ["parking"], expect: /OpenStreetMap/ },
  { name: "phone-settings", w: 393, h: 852, view: { lng: 121, lat: 23.6, zoom: 6 }, lenses: [], settings: true },
  { name: "phone-google-map", w: 393, h: 852, view: { lng: 120.205, lat: 22.992, zoom: 15.4 }, lenses: ["parking"], google: true, layers: true },
  { name: "phone-google-parking", w: 393, h: 852, view: { lng: 120.205, lat: 22.992, zoom: 15.4 }, lenses: ["parking"], google: true, healthy: true },
  { name: "phone-landscape", w: 852, h: 393, view: { lng: 121, lat: 23.8, zoom: 6.4 }, lenses: ["sky"], fx: "ironbow", detect: true },
  // A shared view link that locks onto CAL7 with detection boxes on.
  { name: "phone-track", w: 393, h: 852, view: { lng: 121, lat: 23.8, zoom: 7 }, lenses: [], detect: true, query: "?c=24.9,121.2&z=8&l=sky&t=plane:8964a1", track: "CAL7" },
  { name: "phone-cockpit", w: 393, h: 852, view: { lng: 121, lat: 23.8, zoom: 7 }, lenses: [], query: "?c=24.9,121.2&z=8&l=sky&t=plane:8964a1", track: "CAL7", cockpit: true },
  { name: "phone-passes", w: 393, h: 852, view: { lng: 121.5, lat: 25.03, zoom: 7 }, lenses: ["sky"], passes: true },
  { name: "phone-google-landscape", w: 852, h: 393, view: { lng: 121.5, lat: 25.03, zoom: 9 }, lenses: ["sky"], google: true, query: "?c=24.9,121.2&z=8&l=sky&t=plane:8964a1", track: "CAL7" },
];

const errors = [];
// SHOTS=phone-track,phone-cockpit runs just those.
const only = process.env.SHOTS?.split(",");
for (const s of shots) {
  if (only && !only.includes(s.name)) continue;
  const ctx = await browser.newContext({
    viewport: { width: s.w, height: s.h },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
    geolocation: { latitude: 22.9925, longitude: 120.2048, accuracy: 25 },
    permissions: ["geolocation", "accelerometer", "gyroscope", "magnetometer"],
  });
  await ctx.addInitScript(({ view, lenses, fx, tdx, google, detect }) => {
    if (detect) localStorage.setItem("gdg.detect.v1", "true");
    if (tdx || google) localStorage.setItem("gdg.keys.v1", JSON.stringify({ tdxId: tdx ? "demo" : "", tdxSecret: tdx ? "demo" : "", cwa: "", google: google ? "demo-key" : "" }));
    if (google) localStorage.setItem("gdg.basemap.v1", JSON.stringify({ base: "g-road", overlays: ["traffic"] }));
    localStorage.setItem("gdg.view.v1", JSON.stringify(view));
    localStorage.setItem("gdg.lenses.v1", JSON.stringify(lenses));
    if (fx) localStorage.setItem("gdg.fx.v1", JSON.stringify(fx));
    // Skip the fly-in so shots are deterministic.
    window.matchMedia = ((orig) => (q) => (q.includes("reduced-motion") ? { matches: true, addEventListener() {}, removeEventListener() {} } : orig.call(window, q)))(window.matchMedia);
  }, s);
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    const host = new URL(route.request().url()).hostname;
    const make = fixtures[host];
    if (!make) return route.abort();
    const body = make(route.request().url());
    const type = Buffer.isBuffer(body) ? "image/png" : typeof body === "string" ? "text/plain" : "application/json";
    await route.fulfill({ status: 200, contentType: type, headers: { "access-control-allow-origin": "*" }, body: Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${s.name}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|net::ERR|AJAXError|tiles\.openfreemap|rainviewer/.test(m.text()) && errors.push(`${s.name}: console ${m.text()}`));
  await page.goto(base + (s.query ?? ""));
  await page.waitForTimeout(4500);
  if (s.tap) await page.click("#now");
  if (s.click) {
    // A tap drops a pin; its callout opens the place card.
    await page.mouse.click(s.w / 2, s.h / 2 - 60);
    await page.waitForTimeout(700);
    if (!(await page.$(".drop-pin .pin-callout"))) errors.push(`${s.name}: no pin after tapping the map`);
    if (await page.evaluate(() => !!document.body.dataset.sheet)) errors.push(`${s.name}: a card opened before the pin was tapped`);
    if (!s.pinOnly) await page.click(".drop-pin .pin-callout");
  }
  if (s.camera) {
    await page.waitForFunction(() => /香港/.test(document.querySelector("#strip .strip-status")?.textContent ?? ""), null, { timeout: 15000 }).catch(() => {});
    await page.mouse.click(s.w / 2, s.h / 2);
    await page.waitForTimeout(1500);
  }
  if (s.chip) await page.click(`[data-chip="${s.chip}"]`);
  if (s.settings) await page.click("#openSettings");
  if (s.layers) await page.click("#layers");
  if (s.track) {
    // The target appears once the first flight update lands.
    await page.waitForFunction(() => document.body.dataset.tracking === "plane", null, { timeout: 15000 }).catch(() => {});
    if (s.cockpit) {
      await page.click('[data-th="cockpit"]').catch(() => {});
      for (let i = 0; i < (process.env.DEBUG_COCKPIT ? 8 : 1); i++) {
        await page.waitForTimeout(process.env.DEBUG_COCKPIT ? 400 : 1800);
        if (process.env.DEBUG_COCKPIT) console.log(await page.evaluate(() => document.getElementById("northArrow")?.style.transform));
      }
    }
  }
  if (s.passes) {
    await page.click("#skyPasses");
    await page.waitForFunction(() => !document.querySelector("#sheetBody")?.textContent?.includes("計算中"), null, { timeout: 20000 }).catch(() => {});
  }
  if (s.locate) {
    await page.click("#locate");
    await page.waitForTimeout(1200);
    // A phone facing east (alpha 270 → heading 90°), as a few compass readings.
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => dispatchEvent(new DeviceOrientationEvent("deviceorientationabsolute", { alpha: 270, beta: 0, gamma: 0, absolute: true })));
      await page.waitForTimeout(150);
    }
  }
  if (s.share) {
    await page.fill("#search", s.share);
    await page.press("#search", "Enter");
    // A search result gets the red pin first and no card; the pin's callout opens the card.
    await page.waitForSelector(".drop-pin .pin-callout", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2200);
    const first = await page.evaluate(() => ({ pin: document.querySelector(".drop-pin .pin-callout b")?.textContent ?? "", sheet: document.body.dataset.sheet ?? "" }));
    if (first.pin !== "赤崁樓" || first.sheet) errors.push(`${s.name}: search should drop a pin titled 赤崁樓 before any card ${JSON.stringify(first)}`);
    await page.screenshot({ path: `${out}${s.name}-pin.png` });
    await page.click(".drop-pin .pin-callout").catch(() => {});
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}${s.name}.png` });
  // Smoke checks: the focused lens must not report a failure.
  if (s.healthy) {
    const status = (await page.textContent("#strip .strip-status").catch(() => "")) ?? "";
    if (!status || /無法|Invalid|Failed|錯誤|載入中/.test(status)) errors.push(`${s.name}: lens status "${status}"`);
  }
  if (s.locate) {
    const heading = await page.getAttribute(".me", "data-heading").catch(() => null);
    if (heading !== "on") {
      const info = await page.evaluate(() => ({
        hasEvent: typeof DeviceOrientationEvent,
        asks: typeof DeviceOrientationEvent?.requestPermission,
        toast: document.getElementById("toast")?.textContent,
      }));
      errors.push(`${s.name}: location marker has no heading (${heading}) ${JSON.stringify(info)}`);
    }
  }
  if (s.click && !s.pinOnly) {
    const kind = await page.evaluate(() => document.body.dataset.sheet ?? "");
    if (kind !== "place") errors.push(`${s.name}: the pin's callout opened "${kind}" instead of the place card`);
  }
  if (s.expect) {
    const status = (await page.textContent("#strip .strip-status").catch(() => "")) ?? "";
    if (!s.expect.test(status)) errors.push(`${s.name}: lens status "${status}"`);
  }
  if (s.track) {
    const hud = (await page.textContent("#targetHud").catch(() => "")) ?? "";
    const tracking = await page.evaluate(() => document.body.dataset.tracking ?? "");
    if (tracking !== "plane" || !hud.includes(s.track)) errors.push(`${s.name}: not tracking ${s.track} (tracking="${tracking}", hud="${hud.slice(0, 80)}")`);
  }
  if (s.passes) {
    const title = (await page.textContent("#sheetTitle").catch(() => "")) ?? "";
    const text = (await page.textContent("#sheetBody").catch(() => "")) ?? "";
    if (title !== "衛星過境預報" || /無法|計算中/.test(text) || !/國際太空站|沒有高於/.test(text)) errors.push(`${s.name}: passes sheet "${title}" ${text.slice(0, 120)}`);
  }
  if (s.google) {
    const state = await page.evaluate(() => ({ basemap: document.body.dataset.basemap, copyright: document.querySelector(".gbrand .gcopy")?.textContent, toast: document.getElementById("toast")?.textContent }));
    if (state.basemap !== "google" || !state.copyright) errors.push(`${s.name}: Google map not shown ${JSON.stringify(state)}`);
  }
  if (s.camera) {
    const state = await page.evaluate(() => ({
      kind: document.body.dataset.sheet ?? "",
      title: document.getElementById("sheetTitle")?.textContent ?? "",
      image: document.getElementById("camImg")?.naturalWidth ?? 0,
      status: document.querySelector("#strip .strip-status")?.textContent ?? "",
    }));
    if (state.kind !== "camera" || state.title !== s.camera || !state.image || !/香港官方鏡頭/.test(state.status)) errors.push(`${s.name}: camera sheet ${JSON.stringify(state)}`);
  }
  if (s.share) {
    const title = (await page.textContent("#sheetTitle").catch(() => "")) ?? "";
    if (title !== "赤崁樓") errors.push(`${s.name}: shared link opened "${title}"`);
  }
  if (s.pinchUi) {
    // A two-finger pinch on the interface must not zoom the whole page.
    const cdp = await ctx.newCDPSession(page);
    for (const sel of [".dock", ".search"]) {
      const b = await page.locator(sel).boundingBox();
      const at = (d) => [{ x: b.x + b.width / 2 - d, y: b.y + b.height / 2, id: 0 }, { x: b.x + b.width / 2 + d, y: b.y + b.height / 2, id: 1 }];
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(15) });
      for (let k = 1; k <= 15; k++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(15 + k * 8) });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(500);
      const scale = await page.evaluate(() => visualViewport.scale);
      if (scale !== 1) errors.push(`${s.name}: pinching ${sel} zoomed the page to ${scale.toFixed(2)}×`);
    }
  }
  await ctx.close();
}
await browser.close();
server.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
}
console.log(`screenshots in ${out}`);
