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
// Images
for (const [n, u] of [
  ["img hk", "https://tdcctv.data.one.gov.hk/H429F.JPG"],
  ["img nz", "https://trafficnz.info/camera/714.jpg"],
  ["img qld", "https://cameras.qldtraffic.qld.gov.au/Metropolitan/Archerfield_Ipswich_Mwy_sth.jpg"],
  ["img fi", "https://weathercam.digitraffic.fi/C0150301.jpg"],
  ["img tfl", "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.jpg"],
  ["img nyc", "https://webcams.nyctmc.org/api/cameras/8a6bc417-4877-4ebe-8052-88c1b261baf1/image"],
  ["img caltrans", "https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv102i580westofsr24/tv102i580westofsr24.jpg"],
  ["img iceland", "https://www.vegagerdin.is/vgdata/vefmyndavelar/hellisheidi_1.jpg"],
  ["img iowa", "https://atmsqf.iowadot.gov/SNAPSHOTS/PUBLIC/Metro/qctv36hd.jpeg"],
  ["img quebec a", "https://www.quebec511.info/Carte/Fenetres/camera.ashx?id=3998"],
  ["img quebec b", "https://www.quebec511.info/diffusion/fr/camera/camera.ashx?format=mjpeg&id=3998"],
  ["hls maryland", "https://strmr5.sha.maryland.gov/rtplive/7a00a1dc01250075004d823633235daa/playlist.m3u8"],
  ["hls caltrans", "https://wzmedia.dot.ca.gov/D4/W580_JWO_24_IC.stream/playlist.m3u8"],
]) await show(n, u, { raw: 300, json: false });
// Spain: one camera device in full
const dgt = await show("dgt", "https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v36.xml", { raw: 200, json: false });
const dev = dgt.match(/<ns2:device [\s\S]*?<\/ns2:device>/);
console.log("DGT device count:", (dgt.match(/<ns2:device /g) || []).length, "\n", dev?.[0].replace(/\s+/g, " ").slice(0, 2500));
// Sizes and counts
for (let d = 1; d <= 12; d++) {
  const id = String(d).padStart(2, "0");
  try {
    const { r, buf } = await get(`https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${id}.json`);
    const j = JSON.parse(buf.toString());
    const lats = j.data.map((x) => +x.cctv.location.latitude), lngs = j.data.map((x) => +x.cctv.location.longitude);
    console.log(`caltrans d${d}: ${r.status} n=${j.data.length} bytes=${buf.length} bbox ${Math.min(...lats).toFixed(2)},${Math.min(...lngs).toFixed(2)} → ${Math.max(...lats).toFixed(2)},${Math.max(...lngs).toFixed(2)} images=${j.data.filter((x) => x.cctv.imageData?.static?.currentImageURL).length} video=${j.data.filter((x) => x.cctv.imageData?.streamingVideoURL).length}`);
  } catch (e) {
    console.log(`caltrans d${d}: ${e.message}`);
  }
}
await show("iowa count", "https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json");
// More candidates
for (const [n, u, h] of [
  ["drivebc new", "https://www.drivebc.ca/api/webcams/"],
  ["drivebc old", "https://images.drivebc.ca/webcam/api/v1/webcams/"],
  ["toronto ckan", "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=traffic-cameras"],
  ["ottawa", "https://traffic.ottawa.ca/beta/camera_list"],
  ["calgary", "https://data.calgary.ca/resource/k7p9-kppz.json?$limit=2"],
  ["austin", "https://data.austintexas.gov/resource/b4k4-adkb.json?$limit=2"],
  ["nsw livetraffic", "https://www.livetraffic.com/datajson/all-feeds-web.json"],
  ["wsdot nokey", "https://wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson"],
  ["autobahn A3", "https://verkehr.autobahn.de/o/autobahn/A3/services/webcam"],
  ["autobahn A9", "https://verkehr.autobahn.de/o/autobahn/A9/services/webcam"],
  ["norway", "https://webkamera.atlas.vegvesen.no/public/kameraer"],
  ["overpass main again", `https://overpass-api.de/api/interpreter?data=${encodeURIComponent('[out:json][timeout:20];nwr["amenity"="parking"](51.50,-0.13,51.52,-0.10);out center tags 5;')}`],
  ["osm api parking way", "https://api.openstreetmap.org/api/0.6/map.json?bbox=-0.125,51.505,-0.12,51.508"],
]) await show(n, u, { headers: h, raw: 900 });
// OpenFreeMap tiles: is parking in the poi layer, and with what properties?
const tj = JSON.parse(await show("ofm tilejson", "https://tiles.openfreemap.org/planet", { raw: 300 }));
const tpl = tj.tiles[0];
const tile = (lat, lng, z) => {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return [Math.floor(((lng + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)];
};
for (const [name, lat, lng] of [["Taipei", 25.0478, 121.517], ["Tokyo Shinjuku", 35.6905, 139.7005], ["London", 51.5074, -0.1278], ["Seoul", 37.5665, 126.978]]) {
  const [x, y] = tile(lat, lng, 14);
  const url = tpl.replace("{z}", 14).replace("{x}", x).replace("{y}", y);
  try {
    const { buf } = await get(url);
    const vt = new VectorTile(new Pbf(buf));
    const poi = vt.layers.poi;
    const classes = {};
    const parking = [];
    for (let i = 0; i < (poi?.length ?? 0); i++) {
      const f = poi.feature(i);
      const k = `${f.properties.class}/${f.properties.subclass}`;
      classes[k] = (classes[k] ?? 0) + 1;
      if (/parking/.test(k)) parking.push({ id: f.id, type: f.type, ...f.properties });
    }
    const top = Object.entries(classes).sort((a, b) => b[1] - a[1]).slice(0, 25);
    console.log(`\nOFM z14 ${name} ${url}\nlayers: ${Object.keys(vt.layers).join(",")}\npoi n=${poi?.length}; top classes ${JSON.stringify(top)}\nparking n=${parking.length}; samples ${JSON.stringify(parking.slice(0, 4))}`);
    // Parking may live in other layers too (landuse/aeroway/transportation?)
    for (const [ln, layer] of Object.entries(vt.layers)) {
      let hits = 0;
      for (let i = 0; i < layer.length; i++) if (/parking/.test(JSON.stringify(layer.feature(i).properties))) hits++;
      if (hits) console.log(`  layer ${ln}: ${hits} features mention parking`);
    }
  } catch (e) {
    console.log(`OFM ${name}: ${e.message}`);
  }
}
