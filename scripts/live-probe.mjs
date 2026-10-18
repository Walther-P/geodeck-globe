// Checks every data source the way a visitor's browser reaches it: from the
// app's own origin, direct (CORS) and through the relay, with a sanity check
// on the response shape. Writes a Markdown table to GITHUB_STEP_SUMMARY.
//
//   TEST_URL=http://localhost:8787/ node scripts/live-probe.mjs
//
// Optional, CI-only secrets for checking the keyed feeds (never shipped):
//   PROBE_TDX_ID, PROBE_TDX_SECRET, PROBE_CWA_KEY
// and PROBE_GOOGLE_KEY (the site's own browser key) for the Google map tiles.
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

const keys = { tdxId: process.env.PROBE_TDX_ID ?? "", tdxSecret: process.env.PROBE_TDX_SECRET ?? "", cwa: process.env.PROBE_CWA_KEY ?? "", google: process.env.PROBE_GOOGLE_KEY ?? "" };
const results = await page.evaluate(async (keys) => {
  const rows = [];
  const now = Math.floor(Date.now() / 1000);
  async function probe(name, url, check, init = {}, noteLimit = 160) {
    const row = { name, direct: "", relay: "", note: "" };
    for (const via of ["direct", "relay"]) {
      const target = via === "direct" ? url : `${location.origin}/relay?u=${encodeURIComponent(url)}`;
      try {
        const r = await fetch(target, { ...init, credentials: "omit", referrerPolicy: "no-referrer" });
        const type = r.headers.get("content-type") ?? "";
        const body = type.includes("json") ? await r.json() : type.startsWith("image/") ? { image: (await r.blob()).size } : await r.text();
        let note = "";
        try {
          // A refusal's own words (and Retry-After) say which limit was hit.
          const said = typeof body === "string" ? body : JSON.stringify(body);
          note = r.ok ? String(check(body)) : `HTTP ${r.status}${r.headers.get("retry-after") ? ` retry-after ${r.headers.get("retry-after")}` : ""} ${said.slice(0, 200)}`;
        } catch (e) {
          note = `shape: ${e.message}`;
        }
        row[via] = r.ok ? "ok" : `HTTP ${r.status}`;
        if (!row.note || via === "direct") row.note = note.slice(0, noteLimit);
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

  // Google Maps share links, followed by our Worker (deployed or wrangler dev).
  for (const [name, link] of [
    ["Resolve Google place URL", "https://www.google.com/maps/place/%E8%B5%A4%E5%B4%81%E6%A8%93/data=!3d22.9975!4d120.2026"],
    ["Resolve Google ?q= (page fetch)", "https://maps.google.com/?q=%E8%B5%A4%E5%B4%81%E6%A8%93+%E5%8F%B0%E5%8D%97"],
  ]) {
    try {
      const r = await fetch(`${location.origin}/api/resolve?u=${encodeURIComponent(link)}`);
      const d = await r.json();
      rows.push({ name, direct: r.ok ? "ok" : `HTTP ${r.status}`, relay: "-", note: d.lat !== undefined ? `${d.lat},${d.lng} ${d.title ?? ""}` : `no coords; ${d.error ?? d.url ?? ""}`.slice(0, 160) });
    } catch (e) {
      rows.push({ name, direct: "failed", relay: "-", note: String(e).slice(0, 120) });
    }
  }

  // Google's logo must load wherever Google tiles are shown (same list as src/map/basemap.ts).
  for (const src of [
    "https://maps.gstatic.com/mapfiles/api-3/images/google_white5_hdpi.png",
    "https://maps.gstatic.com/mapfiles/api-3/images/google_white5.png",
    "https://www.gstatic.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png",
  ]) {
    const logo = await new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => resolve("timeout"), 10000);
      img.onload = () => (clearTimeout(timer), resolve(`ok ${img.naturalWidth}×${img.naturalHeight}`));
      img.onerror = () => (clearTimeout(timer), resolve("failed"));
      img.src = src;
    });
    rows.push({ name: `Google logo ${src.split("/").pop()}`, direct: logo.startsWith("ok") ? "ok" : logo, relay: "-", note: `${logo} ${src}` });
  }

  if (keys.google) {
    const g = "https://tile.googleapis.com";
    const row = { name: "Google Map Tiles (site key)", direct: "", relay: "-", note: "" };
    try {
      const r = await fetch(`${g}/v1/createSession?key=${encodeURIComponent(keys.google)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mapType: "roadmap", language: "zh-TW", region: "TW", layerTypes: ["layerTraffic"] }) });
      const d = await r.json();
      row.direct = r.ok ? "ok" : `HTTP ${r.status}`;
      if (!d.session) row.note = JSON.stringify(d).slice(0, 300);
      else {
        const q = `session=${encodeURIComponent(d.session)}&key=${encodeURIComponent(keys.google)}`;
        const tile = await fetch(`${g}/v1/2dtiles/6/53/27?${q}`);
        const v = await fetch(`${g}/tile/v1/viewport?${q}&zoom=6&north=26&south=21&east=123&west=118`).then((x) => x.json()).catch((e) => ({ error: String(e) }));
        row.note = `session ok (expires ${new Date(Number(d.expiry) * 1000).toISOString().slice(0, 10)}, ${d.tileWidth}px); tile z6 HTTP ${tile.status} ${tile.headers.get("content-type")} ${(await tile.blob()).size} bytes; viewport ${JSON.stringify(v).slice(0, 120)}`;
      }
    } catch (e) {
      row.direct = "blocked (CORS/network)";
      row.note = String(e).slice(0, 160);
    }
    rows.push(row);
  } else rows.push({ name: "Google Map Tiles", direct: "skipped", relay: "-", note: "no GOOGLE_MAPS_KEY secret" });

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
      // A free key gets about five calls a minute: 12.5 s apart keeps every row readable.
      const pause = () => new Promise((r) => setTimeout(r, 12500));
      const tdx = "https://tdx.transportdata.tw/api/basic";
      const firstRow = (d, suffix) => (Array.isArray(d) ? d : Object.entries(d).find(([k, v]) => k.endsWith(suffix) && Array.isArray(v))?.[1] ?? [])[0] ?? {};
      await pause();
      await probe("TDX OnStreet segment Tainan", `${tdx}/v1/Parking/OnStreet/ParkingSegment/City/Tainan?$format=JSON&$top=1&$select=ParkingSegmentID,ParkingSegmentName,ParkingSegmentPosition,FareDescription`, (d) => `keys ${Object.keys(d)}; ${JSON.stringify(firstRow(d, "Segments"))}`, h, 700);
      await pause();
      await probe("TDX OnStreet availability Tainan", `${tdx}/v1/Parking/OnStreet/ParkingSegmentAvailability/City/Tainan?$format=JSON&$top=1`, (d) => `keys ${Object.keys(d)}; ${JSON.stringify(firstRow(d, "Availabilities"))}`, h, 700);
      await pause();
      await probe("TDX CarPark Tainan", `${tdx}/v1/Parking/OffStreet/CarPark/City/Tainan?$format=JSON&$top=2`, (d) => `keys ${Object.keys(d)}; park keys ${Object.keys(d.CarParks?.[0] ?? {}).join(",")}`, h, 400);
      await pause();
      await probe("TDX Availability Tainan", `${tdx}/v1/Parking/OffStreet/ParkingAvailability/City/Tainan?$format=JSON&$top=2`, (d) => `keys ${Object.keys(d)}; row ${JSON.stringify(d.ParkingAvailabilities?.[0] ?? {}).slice(0, 220)}`, h);
      await pause();
      await probe("TDX OnStreet availability Taipei", `${tdx}/v1/Parking/OnStreet/ParkingSegmentAvailability/City/Taipei?$format=JSON&$top=1`, (d) => `keys ${Object.keys(d)}; ${JSON.stringify(firstRow(d, "Availabilities"))}`, h, 400);
      await pause();
      await probe("TDX CCTV Freeway", `${tdx}/v2/Road/Traffic/CCTV/Freeway?$format=JSON&$top=1`, (d) => `keys ${Object.keys(d)}; row ${JSON.stringify(d.CCTVs?.[0] ?? {}).slice(0, 220)}`, h);
      await pause();
      await probe("TDX CCTV City Tainan", `${tdx}/v2/Road/Traffic/CCTV/City/Tainan?$format=JSON&$top=1`, (d) => `row ${JSON.stringify(d.CCTVs?.[0] ?? d[0] ?? {}).slice(0, 200)}`, h);
      // Camera feeds through our Worker: does each answer with an image or MJPEG?
      for (const [label, cam] of [
        ["Cam proxy Freeway", "https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=20100"],
        ["Cam proxy Tainan city", "https://trafficvideo2.tainan.gov.tw/192168234005"],
      ]) {
        try {
          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 12000);
          const r = await fetch(`${location.origin}/api/cam?u=${encodeURIComponent(cam)}`, { signal: ctrl.signal });
          rows.push({ name: label, direct: r.ok ? "ok" : `HTTP ${r.status}`, relay: "-", note: `${r.headers.get("content-type")} ${r.ok ? "" : (await r.text()).slice(0, 80)}` });
          ctrl.abort();
        } catch (e) {
          rows.push({ name: label, direct: "failed", relay: "-", note: String(e).slice(0, 100) });
        }
      }
      await pause();
      await probe("TDX Bus Tainan", `${tdx}/v2/Bus/RealTimeByFrequency/City/Tainan?$format=JSON&$top=1&$select=PlateNumb,RouteName,BusPosition,Speed,Azimuth,GPSTime,DutyStatus,BusStatus`, (d) => `row ${JSON.stringify(d[0] ?? {}).slice(0, 220)}`, h);
    }
  } else rows.push({ name: "TDX", direct: "skipped", relay: "skipped", note: "no PROBE_TDX_* secrets" });

  if (keys.cwa) {
    const cwa = (id) => `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${id}?Authorization=${encodeURIComponent(keys.cwa)}&format=JSON`;
    await probe("CWA warnings", cwa("W-C0033-001"), (d) => `records keys ${Object.keys(d.records ?? {})}; first ${JSON.stringify(d.records?.location?.[0] ?? {}).slice(0, 200)}`);
    await probe("CWA quake E-A0015", `${cwa("E-A0015-001")}&limit=1`, (d) => `records keys ${Object.keys(d.records ?? {})}; quake keys ${Object.keys((d.records?.Earthquake ?? d.records?.earthquake ?? [])[0] ?? {})}`);
    await probe("CWA typhoon", cwa("W-C0034-005"), (d) => {
      const tc = d.records?.TropicalCyclones?.TropicalCyclone?.[0] ?? d.records?.tropicalCyclones?.tropicalCyclone?.[0] ?? {};
      const an = tc.AnalysisData ?? tc.analysisData ?? {};
      const fc = tc.ForecastData ?? tc.forecastData ?? {};
      return `analysis ${JSON.stringify((an.Fix ?? an.fix ?? [])[0] ?? an).slice(0, 500)}; forecast ${JSON.stringify((fc.Fix ?? fc.fix ?? [])[0] ?? fc).slice(0, 500)}`;
    });
  } else rows.push({ name: "CWA", direct: "skipped", relay: "skipped", note: "no PROBE_CWA_KEY secret" });
  return rows;
}, keys);

// Real-data screenshots of the app itself. The Tainan one also runs the
// parking lens end to end with the probe's TDX key (CI only, never shipped)
// and records what the lens says about live counts.
for (const [name, w, h, view, lenses, tdx] of [
  ["live-globe", 393, 852, { lng: 121, lat: 23.6, zoom: 1.8 }, ["sky"], false],
  ["live-taiwan", 393, 852, { lng: 120.9, lat: 23.6, zoom: 6.6 }, ["weather", "sky"], false],
  ["live-tainan", 393, 852, { lng: 120.205, lat: 22.992, zoom: 15.5 }, ["traffic", "parking"], true],
]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const appKeys = tdx && keys.tdxId ? { tdxId: keys.tdxId, tdxSecret: keys.tdxSecret, cwa: "", google: "" } : null;
  await ctx.addInitScript(([view, lenses, appKeys]) => {
    localStorage.setItem("gdg.view.v1", JSON.stringify(view));
    localStorage.setItem("gdg.lenses.v1", JSON.stringify(lenses));
    if (appKeys) localStorage.setItem("gdg.keys.v1", JSON.stringify(appKeys));
  }, [view, lenses, appKeys]);
  // The probe's own TDX calls above share this key's five-a-minute budget:
  // let that minute pass so the app starts the way a visitor's would.
  if (appKeys) await new Promise((r) => setTimeout(r, 65000));
  const p = await ctx.newPage();
  await p.goto(base);
  await p.waitForTimeout(12000);
  if (appKeys) {
    // Wait for real counts; a rate-limited first try refreshes on its own a minute later.
    let status = "";
    for (let i = 0; i < 30; i++) {
      status = (await p.textContent("#strip .strip-status").catch(() => "")) ?? "";
      if (/停車場 \d+\/\d+/.test(status)) break;
      await p.waitForTimeout(5000);
    }
    const counts = status.match(/停車場 (\d+)\/(\d+)/);
    results.push({ name: "App: Tainan parking with TDX key", direct: counts && Number(counts[1]) > 0 ? "ok" : "check", relay: "-", note: status.slice(0, 200) });
  }
  await p.screenshot({ path: `${out}${name}.png` });
  await ctx.close();
}
await browser.close();

const table = ["| Source | Direct (CORS) | Relay | Check |", "| --- | --- | --- | --- |", ...results.map((r) => `| ${r.name} | ${r.direct} | ${r.relay} | ${String(r.note).replace(/\|/g, "\\|")} |`)].join("\n");
console.log(table);
console.log(`PROBE_JSON ${JSON.stringify(results)}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Live data probe (${base})\n\n${table}\n`);
