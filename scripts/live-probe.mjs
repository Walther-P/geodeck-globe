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

const keys = { tdxId: process.env.PROBE_TDX_ID ?? "", tdxSecret: process.env.PROBE_TDX_SECRET ?? "", cwa: process.env.PROBE_CWA_KEY ?? "", google: (process.env.PROBE_GOOGLE_KEY ?? "").trim() };
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
  await probe("Open-Meteo wind grid", "https://api.open-meteo.com/v1/forecast?latitude=23,24,25&longitude=120,121,122&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timeformat=unixtime", (d) => `${Array.isArray(d) ? d.length : "not an array"} points; first ${JSON.stringify(d[0]?.current ?? {})}`);
  // Within 200 km of Taipei: every result should be Taiwanese if geo search works.
  await probe("Radio Browser near Taipei", "https://de1.api.radio-browser.info/json/stations/search?has_geo_info=true&is_https=true&hidebroken=true&order=clickcount&reverse=true&limit=8&geo_lat=25.03&geo_long=121.56&geo_distance=200000", (d) => `${d.length} stations; countries ${[...new Set(d.map((x) => x.countrycode))].join(",")}; ${d.map((x) => x.name).join(" / ").slice(0, 120)}`);
  await probe("Launch Library 2", "https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=3&mode=normal", (d) => `${must(d.results, "results").length} launches; next ${d.results[0]?.name ?? "?"} at ${d.results[0]?.net ?? "?"}; pad ${d.results[0]?.pad?.latitude ?? "?"},${d.results[0]?.pad?.longitude ?? "?"}`);
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
    // Says whether the secret even looks like an API key, without printing it.
    const shape = /^AIza[0-9A-Za-z_-]{35}$/.test(keys.google) ? "secret looks like an API key" : `secret is NOT an API key (${keys.google.length} chars, starts "${keys.google.slice(0, 2)}…")`;
    const row = { name: "Google Map Tiles (site key)", direct: "", relay: "-", note: "" };
    try {
      const r = await fetch(`${g}/v1/createSession?key=${encodeURIComponent(keys.google)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mapType: "roadmap", language: "zh-TW", region: "TW", layerTypes: ["layerTraffic"] }) });
      const d = await r.json();
      row.direct = r.ok ? "ok" : `HTTP ${r.status}`;
      if (!d.session) row.note = `${shape}; ${JSON.stringify(d).slice(0, 260)}`;
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

  // Road cameras abroad (src/data/worldcams.ts): each list, and how many cameras it has.
  const n = (v) => (Array.isArray(v) ? v.length : "not a list");
  const cams = [
    ["Cams Hong Kong", "https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_Tc.xml", (t) => `${(String(t).match(/<image>/g) ?? []).length} cameras`],
    ["Cams Singapore", "https://api.data.gov.sg/v1/transport/traffic-images", (d) => `${n(d.items?.[0]?.cameras)} cameras`],
    ["Cams New Zealand", "https://trafficnz.info/service/traffic/rest/4/cameras/all", (d) => `${n(d.response?.camera)} cameras`, { headers: { accept: "application/json" } }],
    ["Cams NSW", "https://www.livetraffic.com/datajson/all-feeds-web.json", (d) => `${d.filter?.((f) => f.eventCategory === "liveCams").length} cameras`],
    ["Cams Finland", "https://tie.digitraffic.fi/api/weathercam/v1/stations", (d) => `${n(d.features)} stations`],
    ["Cams London", "https://api.tfl.gov.uk/Place/Type/JamCam", (d) => `${n(d)} cameras`],
    ["Cams Spain", "https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v37.xml", (t) => `${(String(t).match(/deviceUrl>/g) ?? []).length / 2} cameras`],
    ["Cams Iceland", "https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1", (d) => `${n(d)} cameras`],
    ["Cams New York City", "https://webcams.nyctmc.org/api/cameras", (d) => `${n(d)} cameras`],
    ["Cams California D7", "https://cwwp2.dot.ca.gov/data/d7/cctv/cctvStatusD07.json", (d) => `${n(d.data)} cameras`],
    ["Cams Iowa", "https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0/query?where=1%3D1&outFields=Desc_,ImageURL&f=geojson", (d) => `${n(d.features)} cameras`],
    ["Cams Maryland", "https://chartexp1.sha.maryland.gov/CHARTExportClientService/getCameraMapDataJSON.do", (d) => `${n(d.data)} cameras`],
    ["Cams British Columbia", "https://www.drivebc.ca/api/webcams/", (d) => `${n(d)} cameras`],
    ["Cams Ottawa", "https://traffic.ottawa.ca/beta/camera_list", (d) => `${n(d)} cameras`],
    ["Cams Calgary", "https://data.calgary.ca/resource/k7p9-kppz.json?$limit=2000", (d) => `${n(d)} cameras`],
    [
      "Cams Toronto",
      "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/a3309088-5fd4-4d34-8297-77c8301840ac/resource/4a568300-c7f8-496d-b150-dff6f5dc6d4f/download/traffic-camera-list-4326.geojson",
      // Served as application/octet-stream, so it arrives as text.
      (d) => `${n((typeof d === "string" ? JSON.parse(d) : d).features)} cameras`,
    ],
    // Keyed by the site (Worker secrets); the relay answers 501 until the owner adds the key.
    ["Cams Windy (site key)", "https://api.windy.com/webcams/api/v3/webcams?nearby=35.5,139.5,60&categories=traffic&include=images,location,urls&limit=5", (d) => `${n(d.webcams)} webcams of ${d.total}; ${JSON.stringify(d.webcams?.[0] ?? {}).slice(0, 160)}`],
    ["Cams Ontario 511 (site key)", "https://511on.ca/api/v2/get/cameras?format=json", (d) => `${n(d)} cameras; ${JSON.stringify(d[0] ?? {}).slice(0, 160)}`],
    ["Cams Alberta 511 (site key)", "https://511.alberta.ca/api/v2/get/cameras?format=json", (d) => `${n(d)} cameras; ${JSON.stringify(d[0] ?? {}).slice(0, 160)}`],
    ["Cams 511NY (site key)", "https://511ny.org/api/getcameras?format=json", (d) => `${n(d)} cameras; ${JSON.stringify(d[0] ?? {}).slice(0, 160)}`],
  ];
  for (const [name, url, check, init] of cams) await probe(name, url, check, init ?? {}, 240);
  // Parking abroad: lots come from the basemap tiles, details from the OSM API on tap.
  await probe("OSM API parking details", "https://api.openstreetmap.org/api/0.6/way/150920360.json", (d) => JSON.stringify(must(d.elements?.[0]?.tags, "tags")));
  // Keyless live parking the cities publish themselves (the app reads them without TDX).
  const text = (d) => (typeof d === "string" ? d : JSON.stringify(d));
  await probe("Park Taipei XML", "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.xml", (t) => `${(text(t).match(/<PARK>/g) ?? []).length} lots, updated ${must(text(t).match(/<UPDATETIME>([^<]+)/), "UPDATETIME")[1]}`);
  await probe(
    "Park Taoyuan XML",
    "https://opendata.tycg.gov.tw/api/dataset/f4cc0b12-86ac-40f9-8745-885bddc18f79/resource/0daad6e6-0632-44f5-bd25-5e1de1e9146f/download",
    (t) => `${(text(t).match(/<parkingLot>/g) ?? []).length} lots, updated ${must(text(t).match(/updatetime="([^"]+)"/), "updatetime")[1]}`,
  );
  await probe("Park Taichung", "https://motoretag.taichung.gov.tw/DataAPI/api/ParkingSpotListAPIV2", (d) => {
    const lots = d.flatMap((g) => g.ParkingLots ?? []);
    return `${lots.length} lots, newest ${lots.map((l) => l.Updatetime ?? "").sort().at(-1)}`;
  });
  await probe("Park Tainan", "https://parkweb.tainan.gov.tw/api/parking.php", (d) => `${n(d)} lots, newest ${d.map((l) => l.update_time ?? "").sort().at(-1)}`);
  // Bike share: CityBikes (YouBike in a dozen Taiwanese cities, ~800 systems worldwide).
  await probe("Bikes CityBikes networks", "https://api.citybik.es/v2/networks?fields=id,name,location", (d) => `${n(d.networks)} networks, ${d.networks.filter((x) => x.location?.country === "TW").length} in Taiwan`);
  await probe("Bikes YouBike Taipei", "https://api.citybik.es/v2/networks/youbike-taipei", (d) => `${n(d.network?.stations)} stations, ${d.network?.stations?.[0]?.timestamp}`);
  return rows;
}, keys);

// Real-data screenshots of the app itself. The Tainan one also runs the
// parking lens end to end with the probe's TDX key (CI only, never shipped)
// and records what the lens says about live counts.
for (const [name, w, h, view, lenses, tdx, want] of [
  ["live-globe", 393, 852, { lng: 121, lat: 23.6, zoom: 1.8 }, ["sky"], false],
  ["live-taiwan", 393, 852, { lng: 120.9, lat: 23.6, zoom: 6.6 }, ["weather", "sky"], false],
  ["live-tainan", 393, 852, { lng: 120.205, lat: 22.992, zoom: 15.5 }, ["traffic", "parking"], true],
  // Abroad: official cameras for the area, and OpenStreetMap parking from the basemap tiles.
  ["live-hongkong", 393, 852, { lng: 114.17, lat: 22.3, zoom: 12 }, ["traffic"], false, ["App: Hong Kong cameras", /香港官方鏡頭/]],
  ["live-tokyo", 393, 852, { lng: 139.7005, lat: 35.6905, zoom: 16 }, ["parking"], false, ["App: Tokyo parking (OSM)", /畫面中 \d+ 處停車場/]],
  // No key: Taipei's own feed gives the counts; YouBike docks from CityBikes.
  ["live-taipei", 393, 852, { lng: 121.5168, lat: 25.0466, zoom: 15.5 }, ["parking"], false, ["App: Taipei parking (no key)", /即時：停車場 [1-9]\d*\/\d+/]],
  ["live-taipei-bikes", 393, 852, { lng: 121.5168, lat: 25.0466, zoom: 15 }, ["traffic"], false, ["App: Taipei YouBike", /YouBike[^·]*畫面中 [1-9]\d* 站/]],
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
  if (name === "live-taiwan") {
    // What a visitor sees about flights right now (the relay may serve its last good copy).
    let status = "";
    for (let i = 0; i < 8; i++) {
      status = (await p.textContent("#strip .strip-status").catch(() => "")) ?? "";
      if (/航班 \d+ 架|拒絕|限流/.test(status)) break;
      await p.waitForTimeout(3000);
    }
    const flights = status.match(/航班[^·]*/)?.[0] ?? status;
    results.push({ name: "App: Taiwan flights", direct: /航班 \d+ 架/.test(flights) ? "ok" : "check", relay: "-", note: flights.slice(0, 200) });
  }
  if (want) {
    let status = "";
    for (let i = 0; i < 10; i++) {
      status = (await p.textContent("#strip .strip-status").catch(() => "")) ?? "";
      if (want[1].test(status)) break;
      await p.waitForTimeout(3000);
    }
    results.push({ name: want[0], direct: want[1].test(status) ? "ok" : "check", relay: "-", note: status.slice(0, 200) });
  }
  if (appKeys) {
    // Wait for real counts; a rate-limited first try refreshes on its own a minute later.
    let status = "";
    for (let i = 0; i < 30; i++) {
      status = (await p.textContent("#strip .strip-status").catch(() => "")) ?? "";
      if (/停車場 \d+\/\d+/.test(status)) break;
      await p.waitForTimeout(5000);
    }
    const counts = status.match(/停車場 (\d+)\/(\d+)/);
    results.push({ name: "App: Tainan parking (city feed, TDX kerbside)", direct: counts && Number(counts[1]) > 0 ? "ok" : "check", relay: "-", note: status.slice(0, 200) });
  }
  await p.screenshot({ path: `${out}${name}.png` });
  await ctx.close();
}
await browser.close();

const table = ["| Source | Direct (CORS) | Relay | Check |", "| --- | --- | --- | --- |", ...results.map((r) => `| ${r.name} | ${r.direct} | ${r.relay} | ${String(r.note).replace(/\|/g, "\\|")} |`)].join("\n");
console.log(table);
console.log(`PROBE_JSON ${JSON.stringify(results)}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Live data probe (${base})\n\n${table}\n`);
