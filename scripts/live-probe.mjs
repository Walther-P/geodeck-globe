// Checks every data source the way a visitor's browser reaches it: from the
// app's own origin, direct (CORS) and through the relay, with a sanity check
// on the response shape. Writes a Markdown table to GITHUB_STEP_SUMMARY.
//
//   TEST_URL=http://localhost:8787/ node scripts/live-probe.mjs
//
// Optional, CI-only secrets for checking the keyed feeds (never shipped):
//   PROBE_TDX_ID, PROBE_TDX_SECRET, PROBE_CWA_KEY
// Screenshots of the live app go to artifacts/live/.

import { chromium } from "@playwright/test";
import { appendFileSync, mkdirSync } from "node:fs";

const base = process.env.TEST_URL ?? "http://localhost:8787/";
const out = new URL("../artifacts/live/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
// A same-origin document without the app's scripts, so nothing navigates
// away mid-probe and fetches carry this site's origin like the app's do.
await page.goto(new URL("icon.svg", base).toString());

const keys = { tdxId: process.env.PROBE_TDX_ID ?? "", tdxSecret: process.env.PROBE_TDX_SECRET ?? "", cwa: process.env.PROBE_CWA_KEY ?? "" };
const results = await page.evaluate(async (keys) => {
  const rows = [];
  const now = Math.floor(Date.now() / 1000);
  async function probe(name, url, check, init = {}) {
    const row = { name, direct: "", relay: "", note: "" };
    for (const via of ["direct", "relay"]) {
      const target = via === "direct" ? url : `${location.origin}/relay?u=${encodeURIComponent(url)}`;
      try {
        const r = await fetch(target, { ...init, credentials: "omit", referrerPolicy: "no-referrer" });
        const type = r.headers.get("content-type") ?? "";
        const body = type.includes("json") ? await r.json() : type.startsWith("image/") ? { image: (await r.blob()).size } : await r.text();
        let note = "";
        try {
          note = r.ok ? String(check(body)) : `HTTP ${r.status}`;
        } catch (e) {
          note = `shape: ${e.message}`;
        }
        row[via] = r.ok ? "ok" : `HTTP ${r.status}`;
        if (!row.note || via === "direct") row.note = note.slice(0, 160);
      } catch (e) {
        row[via] = via === "direct" ? "blocked (CORS/network)" : "failed";
      }
    }
    rows.push(row);
    return row;
  }
  const must = (v, what) => {
    if (!v) throw new Error(`missing ${what}`);
    return v;
  };

  await probe("Open-Meteo forecast", "https://api.open-meteo.com/v1/forecast?latitude=22.99&longitude=120.2&current=temperature_2m&minutely_15=precipitation&forecast_minutely_15=12&hourly=precipitation_probability&timezone=auto&timeformat=unixtime", (d) => `temp ${must(d.current, "current").temperature_2m}, 15min ${d.minutely_15?.time?.length}`);
  await probe("Open-Meteo air", "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=22.99&longitude=120.2&current=us_aqi", (d) => `aqi ${d.current?.us_aqi}`);
  let radarTile = "";
  await probe("RainViewer index", "https://api.rainviewer.com/public/weather-maps.json", (d) => {
    const f = must(d.radar?.past?.at(-1), "radar.past");
    radarTile = `${d.host}${f.path}/256/6/53/27/2/1_1.png`;
    return `${d.radar.past.length} frames, latest ${new Date(f.time * 1000).toISOString()}`;
  });
  if (radarTile) await probe("RainViewer tile z6", radarTile, (d) => `image ${d.image ?? "?"} bytes`);
  let cloudTime = "";
  await probe("GIBS DescribeDomains", "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=Himawari_AHI_Band13_Clean_Infrared&TILEMATRIXSET=GoogleMapsCompatible_Level6", (t) => {
    const d = String(t).match(/<Domain>([^<]+)<\/Domain>/g)?.pop() ?? "";
    cloudTime = (d.replace(/<\/?Domain>/g, "").split(",").pop() ?? "").split("/")[1] ?? "";
    return `latest ${cloudTime || "?"}`;
  });
  const gibsTile = (t) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Himawari_AHI_Band13_Clean_Infrared/default/${t}/GoogleMapsCompatible_Level6/4/6/13.png`;
  // The app uses the advertised latest time minus 30 minutes (settledTime).
  const back = (t, min) => (t ? new Date(Math.floor((Date.parse(t) - min * 60000) / 600000) * 600000).toISOString().replace(/\.\d{3}Z$/, "Z") : "default");
  await probe("GIBS tile at latest", gibsTile(cloudTime || "default"), (d) => `image ${d.image ?? "?"} bytes`);
  await probe("GIBS tile at latest-30m (app)", gibsTile(back(cloudTime, 30)), (d) => `image ${d.image ?? "?"} bytes`);
  await probe("USGS quakes", "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson", (d) => `${must(d.features, "features").length} quakes`);
  const acCount = (d) => `${must(d.ac ?? d.aircraft, "ac").length} aircraft`;
  await probe("adsb.lol point", "https://api.adsb.lol/v2/point/23.5/121/150", acCount);
  await probe("airplanes.live point", "https://api.airplanes.live/v2/point/23.5/121/150", acCount);
  await probe("adsb.fi point", "https://opendata.adsb.fi/api/v2/lat/23.5/lon/121/dist/150", acCount);
  await probe("adsb.one point", "https://api.adsb.one/v2/point/23.5/121/150", acCount);
  await probe("OpenSky states", "https://opensky-network.org/api/states/all?lamin=21&lamax=26&lomin=118&lomax=124", (d) => `${(d.states ?? []).length} aircraft`);
  await probe("CelesTrak visual", "https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle", (t) => `${String(t).split("\n").filter((l) => l.startsWith("1 ")).length} element sets`);
  await probe("Photon search", "https://photon.komoot.io/api/?q=%E8%B5%A4%E5%B4%81%E6%A8%93&limit=3&lat=23&lon=120.2", (d) => must(d.features, "features").map((f) => f.properties?.name).join(" / "));
  await probe("Photon reverse", "https://photon.komoot.io/reverse?lat=22.997&lon=120.2025&limit=1", (d) => d.features?.[0]?.properties?.name ?? "(no name)");
  await probe("OpenFreeMap TileJSON", "https://tiles.openfreemap.org/planet", (d) => `${must(d.tiles, "tiles")[0]} maxzoom ${d.maxzoom}; languages ${(d.vector_layers ?? []).find((l) => l.id === "place")?.fields?.["name:zh-Hant"] ? "has zh-Hant" : "?"}`);
  await probe("OpenFreeMap glyphs", "https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf", (t) => `${String(t).length} chars`);
  await probe("Freeway CCTV image", "https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=20100", () => "reachable");

  if (keys.tdxId && keys.tdxSecret) {
    let token = "";
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: keys.tdxId, client_secret: keys.tdxSecret }).toString();
    await probe(
      "TDX token",
      "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token",
      (d) => {
        token = must(d.access_token, "access_token");
        return `token ok, expires_in ${d.expires_in}`;
      },
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
    );
    if (token) {
      const h = { headers: { authorization: `Bearer ${token}`, accept: "application/json" } };
      const tdx = "https://tdx.transportdata.tw/api/basic";
      await probe("TDX CarPark Tainan", `${tdx}/v1/Parking/OffStreet/CarPark/City/Tainan?$format=JSON&$top=2`, (d) => `keys ${Object.keys(d)}; park keys ${Object.keys(d.CarParks?.[0] ?? {}).join(",")}`, h);
      await probe("TDX Availability Tainan", `${tdx}/v1/Parking/OffStreet/ParkingAvailability/City/Tainan?$format=JSON&$top=2`, (d) => `keys ${Object.keys(d)}; row ${JSON.stringify(d.ParkingAvailabilities?.[0] ?? {}).slice(0, 220)}`, h);
      await probe("TDX CCTV Freeway", `${tdx}/v2/Road/Traffic/CCTV/Freeway?$format=JSON&$top=1`, (d) => `keys ${Object.keys(d)}; row ${JSON.stringify(d.CCTVs?.[0] ?? {}).slice(0, 220)}`, h);
      await probe("TDX CCTV City Tainan", `${tdx}/v2/Road/Traffic/CCTV/City/Tainan?$format=JSON&$top=1`, (d) => `row ${JSON.stringify(d.CCTVs?.[0] ?? d[0] ?? {}).slice(0, 200)}`, h);
      await probe("TDX Bus Tainan", `${tdx}/v2/Bus/RealTimeByFrequency/City/Tainan?$format=JSON&$top=1&$select=PlateNumb,RouteName,BusPosition,Speed,Azimuth,GPSTime,DutyStatus,BusStatus`, (d) => `row ${JSON.stringify(d[0] ?? {}).slice(0, 220)}`, h);
    }
  } else rows.push({ name: "TDX", direct: "skipped", relay: "skipped", note: "no PROBE_TDX_* secrets" });

  if (keys.cwa) {
    const cwa = (id) => `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${id}?Authorization=${encodeURIComponent(keys.cwa)}&format=JSON`;
    await probe("CWA warnings", cwa("W-C0033-001"), (d) => `records keys ${Object.keys(d.records ?? {})}; first ${JSON.stringify(d.records?.location?.[0] ?? {}).slice(0, 200)}`);
    await probe("CWA quake E-A0015", `${cwa("E-A0015-001")}&limit=1`, (d) => `records keys ${Object.keys(d.records ?? {})}; quake keys ${Object.keys((d.records?.Earthquake ?? d.records?.earthquake ?? [])[0] ?? {})}`);
    await probe("CWA typhoon", cwa("W-C0034-005"), (d) => `records ${JSON.stringify(d.records ?? {}).slice(0, 240)}`);
  } else rows.push({ name: "CWA", direct: "skipped", relay: "skipped", note: "no PROBE_CWA_KEY secret" });
  return rows;
}, keys);

// Real-data screenshots of the app itself.
for (const [name, w, h, view, lenses] of [
  ["live-globe", 393, 852, { lng: 121, lat: 23.6, zoom: 1.8 }, ["sky"]],
  ["live-taiwan", 393, 852, { lng: 120.9, lat: 23.6, zoom: 6.6 }, ["weather", "sky"]],
  ["live-tainan", 393, 852, { lng: 120.205, lat: 22.992, zoom: 15.5 }, ["parking", "traffic"]],
]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(([view, lenses]) => {
    localStorage.setItem("gdg.view.v1", JSON.stringify(view));
    localStorage.setItem("gdg.lenses.v1", JSON.stringify(lenses));
  }, [view, lenses]);
  const p = await ctx.newPage();
  await p.goto(base);
  await p.waitForTimeout(12000);
  await p.screenshot({ path: `${out}${name}.png` });
  await ctx.close();
}
await browser.close();

const table = ["| Source | Direct (CORS) | Relay | Check |", "| --- | --- | --- | --- |", ...results.map((r) => `| ${r.name} | ${r.direct} | ${r.relay} | ${String(r.note).replace(/\|/g, "\\|")} |`)].join("\n");
console.log(table);
console.log(`PROBE_JSON ${JSON.stringify(results)}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Live data probe (${base})\n\n${table}\n`);
