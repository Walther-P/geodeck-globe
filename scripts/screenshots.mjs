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

const root = new URL("../dist/", import.meta.url).pathname;
const out = new URL("../artifacts/screenshots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };

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

const fixtures = {
  "api.open-meteo.com": () => ({
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
  }),
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
  "photon.komoot.io": () => ({ features: [{ geometry: { coordinates: [120.2049, 22.9908] }, properties: { name: "赤崁樓", city: "臺南市", district: "中西區", country: "臺灣", countrycode: "TW" } }] }),
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const shots = [
  { name: "phone-globe", w: 393, h: 852, view: { lng: 121, lat: 23.6, zoom: 1.8 }, lenses: ["sky"] },
  { name: "phone-taiwan-sky", w: 393, h: 852, view: { lng: 121, lat: 23.8, zoom: 6.6 }, lenses: ["weather", "sky"], tap: "now" },
  { name: "phone-tainan-parking", w: 393, h: 852, view: { lng: 120.205, lat: 22.992, zoom: 15.6 }, lenses: ["traffic", "parking"], healthy: true, tdx: true },
  { name: "phone-tainan-traffic", w: 393, h: 852, view: { lng: 120.205, lat: 22.992, zoom: 15.2 }, lenses: ["parking", "traffic"], healthy: true },
  { name: "phone-locate", w: 393, h: 852, view: { lng: 120.205, lat: 22.992, zoom: 15 }, lenses: ["parking"], locate: true },
  {
    name: "phone-shared-link",
    w: 393,
    h: 852,
    view: { lng: 121, lat: 23.6, zoom: 7 },
    lenses: ["parking"],
    share: "https://www.google.com/maps/place/%E8%B5%A4%E5%B4%81%E6%A8%93/@22.997,120.2,17z/data=!3m1!4b1!4m6!3m5!1s0x1:0x2!8m2!3d22.997534!4d120.202568",
  },
  { name: "phone-place-card", w: 393, h: 852, view: { lng: 120.205, lat: 22.992, zoom: 14 }, lenses: ["weather"], click: true },
  { name: "phone-settings", w: 393, h: 852, view: { lng: 121, lat: 23.6, zoom: 6 }, lenses: [], settings: true },
  { name: "phone-landscape", w: 852, h: 393, view: { lng: 121, lat: 23.8, zoom: 6.4 }, lenses: ["sky"], fx: "nvg" },
];

const errors = [];
for (const s of shots) {
  const ctx = await browser.newContext({
    viewport: { width: s.w, height: s.h },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
    geolocation: { latitude: 22.9925, longitude: 120.2048, accuracy: 25 },
    permissions: ["geolocation", "accelerometer", "gyroscope", "magnetometer"],
  });
  await ctx.addInitScript(({ view, lenses, fx, tdx }) => {
    if (tdx) localStorage.setItem("gdg.keys.v1", JSON.stringify({ tdxId: "demo", tdxSecret: "demo", cwa: "", google: "" }));
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
    await route.fulfill({ status: 200, contentType: typeof body === "string" ? "text/plain" : "application/json", headers: { "access-control-allow-origin": "*" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${s.name}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|net::ERR|AJAXError|tiles\.openfreemap|rainviewer/.test(m.text()) && errors.push(`${s.name}: console ${m.text()}`));
  await page.goto(base);
  await page.waitForTimeout(4500);
  if (s.tap) await page.click("#now");
  if (s.click) await page.mouse.click(s.w / 2, s.h / 2 - 60);
  if (s.settings) await page.click("#openSettings");
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
  if (s.share) {
    const title = (await page.textContent("#sheetTitle").catch(() => "")) ?? "";
    if (title !== "赤崁樓") errors.push(`${s.name}: shared link opened "${title}"`);
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
