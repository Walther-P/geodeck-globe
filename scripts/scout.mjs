// Temporary: second pass — image URLs, list sizes, parking in OpenFreeMap tiles, more cities.
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
const ORIGIN = "https://geodeck-globe.ht500119es.workers.dev";
const UA = { origin: ORIGIN, "user-agent": "baiyan-scout/1 (+https://github.com/Walther-P/geodeck-globe)" };
async function get(url, headers = {}) {
  const t0 = Date.now();
  const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(25000) });
  const buf = Buffer.from(await r.arrayBuffer());
  return { r, buf, ms: Date.now() - t0 };
}
async function show(name, url, { headers, raw = 1500, json = true } = {}) {
  try {
    const { r, buf, ms } = await get(url, headers);
    const text = buf.toString("utf8");
    let summary = r.headers.get("content-type")?.startsWith("image") ? "(image)" : text.slice(0, raw).replace(/\s+/g, " ");
    if (json)
      try {
        const d = JSON.parse(text);
        const arr = Array.isArray(d) ? d : d.features ?? d.items ?? d.data ?? d.result?.records ?? d.result ?? d.webcams ?? null;
        summary = `json n=${Array.isArray(arr) ? arr.length : "?"}; ${JSON.stringify(Array.isArray(arr) ? arr[0] : d).slice(0, raw)}`;
      } catch {}
    console.log(`\n### ${name}\n${r.status} ${r.headers.get("content-type")} acao=${r.headers.get("access-control-allow-origin")} bytes=${buf.length} ${ms}ms cache=${r.headers.get("cache-control")}\n${url}\n${summary}`);
    return text;
  } catch (e) {
    console.log(`\n### ${name}\nERROR ${e.message} ${e.cause?.code ?? ""}\n${url}`);
    return "";
  }
}

for (const [n, u] of [
  ["img nz apex", "https://trafficnz.info/camera/714.jpg"],
  ["img nz www", "https://www.trafficnz.info/camera/714.jpg"],
  ["img dgt", "https://etraffic.dgt.es/camarasEtraffic/176130.jpg"],
  ["img drivebc", "https://www.drivebc.ca/images/872.jpg"],
  ["img ottawa a", "https://traffic.ottawa.ca/beta/camera?id=309"],
  ["img ottawa b", "https://traffic.ottawa.ca/beta/camera?id=2025"],
  ["img ottawa c", "https://traffic.ottawa.ca/opendata/camera?c=2025"],
  ["img ottawa d", "https://traffic.ottawa.ca/map/camera?id=309"],
  ["img calgary https", "https://trafficcam.calgary.ca/loc86.jpg"],
  ["img calgary http", "http://trafficcam.calgary.ca/loc86.jpg"],
  ["img austin", "https://cctv.austinmobility.io/image/670.jpg"],
  ["img nsw", "https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/5_ways_miranda.jpeg"],
]) await show(n, u, { raw: 200, json: false });
const sg = JSON.parse(await show("sg", "https://api.data.gov.sg/v1/transport/traffic-images", { raw: 100 }));
await show("img sg", sg.items[0].cameras[0].image, { raw: 100, json: false });
await show("iowa page", "https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0?f=json", { raw: 100 }).then((t) => console.log("maxRecordCount", JSON.parse(t).maxRecordCount));
const ia = JSON.parse(await show("iowa all", "https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0/query?where=1%3D1&outFields=Desc_,ImageURL,VideoURL,REGION&f=geojson", { raw: 300 }));
console.log("iowa features", ia.features?.length, "exceeded", ia.properties?.exceededTransferLimit ?? ia.exceededTransferLimit, "no image", ia.features?.filter((f) => !f.properties.ImageURL).length);
const au = JSON.parse(await show("austin on", "https://data.austintexas.gov/resource/b4k4-adkb.json?$where=camera_status%3D%27TURNED_ON%27&$limit=5000&$select=camera_id,location_name,screenshot_address,location", { raw: 300 }));
console.log("austin turned on", au.length);
const nsw = JSON.parse(await show("nsw", "https://www.livetraffic.com/datajson/all-feeds-web.json", { raw: 100 }));
const cats = {}; for (const f of nsw) cats[f.eventCategory] = (cats[f.eventCategory] ?? 0) + 1; console.log("nsw categories", JSON.stringify(cats));
const db = JSON.parse(await show("drivebc", "https://www.drivebc.ca/api/webcams/", { raw: 100 }));
console.log("drivebc on", db.filter((c) => c.is_on && c.should_appear).length, "stale", db.filter((c) => c.marked_stale).length);
const ott = JSON.parse(await show("ottawa", "https://traffic.ottawa.ca/beta/camera_list", { raw: 100 }));
console.log("ottawa types", JSON.stringify([...new Set(ott.map((c) => c.type))]), JSON.stringify(ott.slice(0, 3)));
const cg = JSON.parse(await show("calgary all", "https://data.calgary.ca/resource/k7p9-kppz.json?$limit=2000", { raw: 100 }));
console.log("calgary n", cg.length);
const tor = JSON.parse(await show("toronto pkg", "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=traffic-cameras", { raw: 100 }));
for (const r of tor.result.resources) console.log("toronto resource", r.name, r.format, r.url, r.datastore_active);
const geo = tor.result.resources.find((r) => /geojson/i.test(r.format) && /4326/.test(r.name)) ?? tor.result.resources.find((r) => /geojson/i.test(r.format));
if (geo) await show("toronto geojson", geo.url, { raw: 1200 });
await show("osm api way", "https://api.openstreetmap.org/api/0.6/way/150920360.json", { raw: 1200 });
await show("osm api node", "https://api.openstreetmap.org/api/0.6/node/890181843.json", { raw: 800 });
