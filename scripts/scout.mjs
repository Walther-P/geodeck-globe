// Temporary: which camera feeds say which way each camera looks.
const ORIGIN = "https://geodeck-globe.ht500119es.workers.dev";
const DIRKEY = /dir|orient|bear|head|view|angle|azim|look|facing|caption|desc|preset|quadrant|bound/i;
async function get(url, headers = {}) {
  const r = await fetch(url, { headers: { origin: ORIGIN, "user-agent": "baiyan-scout/1", ...headers }, signal: AbortSignal.timeout(30000) });
  return r.text();
}
function walk(o, path, out) {
  if (Array.isArray(o)) {
    o.slice(0, 400).forEach((x) => walk(x, `${path}[]`, out));
    return;
  }
  if (o && typeof o === "object")
    for (const [k, v] of Object.entries(o)) {
      const p = `${path}.${k}`;
      if (DIRKEY.test(k) && (typeof v !== "object" || v === null)) {
        const m = (out[p] ??= new Map());
        const s = String(v).slice(0, 60);
        m.set(s, (m.get(s) ?? 0) + 1);
      }
      walk(v, p, out);
    }
}
const list = (d) => (Array.isArray(d) ? d : d.features ?? d.data ?? d.response?.camera ?? d.items?.[0]?.cameras ?? d.webcams ?? []);
for (const [name, url, headers] of [
  ["NZ", "https://trafficnz.info/service/traffic/rest/4/cameras/all", { accept: "application/json" }],
  ["NSW", "https://www.livetraffic.com/datajson/all-feeds-web.json"],
  ["Finland", "https://tie.digitraffic.fi/api/weathercam/v1/stations"],
  ["Finland station", "https://tie.digitraffic.fi/api/weathercam/v1/stations/C01503"],
  ["TfL", "https://api.tfl.gov.uk/Place/Type/JamCam"],
  ["Iceland", "https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1"],
  ["NYC", "https://webcams.nyctmc.org/api/cameras"],
  ["Caltrans D7", "https://cwwp2.dot.ca.gov/data/d7/cctv/cctvStatusD07.json"],
  ["Iowa", "https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson&resultRecordCount=300"],
  ["Maryland", "https://chartexp1.sha.maryland.gov/CHARTExportClientService/getCameraMapDataJSON.do"],
  ["DriveBC", "https://www.drivebc.ca/api/webcams/"],
  ["Ottawa", "https://traffic.ottawa.ca/beta/camera_list"],
  ["Calgary", "https://data.calgary.ca/resource/k7p9-kppz.json?$limit=300"],
  ["Toronto", "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/a3309088-5fd4-4d34-8297-77c8301840ac/resource/4a568300-c7f8-496d-b150-dff6f5dc6d4f/download/traffic-camera-list-4326.geojson"],
  ["Singapore", "https://api.data.gov.sg/v1/transport/traffic-images"],
]) {
  try {
    const t = await get(url, headers);
    const d = JSON.parse(t);
    const rows = list(d);
    const out = {};
    walk(d, "", out);
    console.log(`\n### ${name}: ${Array.isArray(rows) ? rows.length : "?"} rows\nfirst: ${JSON.stringify(Array.isArray(rows) ? rows[0] : d).slice(0, 900)}`);
    for (const [k, m] of Object.entries(out)) console.log(`  ${k}: ${m.size} distinct; ${[...m].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([v, n]) => `${JSON.stringify(v)}×${n}`).join(", ")}`);
  } catch (e) {
    console.log(`\n### ${name}\nERROR ${e.message}`);
  }
}
for (const [name, url, rec] of [
  ["HK", "https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_Tc.xml", /<image>[\s\S]*?<\/image>/g],
  ["Spain", "https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v37.xml", /<(?:[\w-]+:)?device\b[\s\S]*?<\/(?:[\w-]+:)?device>/g],
]) {
  try {
    const t = await get(url);
    const recs = t.match(rec) ?? [];
    console.log(`\n### ${name}: ${recs.length} records\n${(recs[0] ?? t.slice(0, 1500)).replace(/\s+/g, " ").slice(0, 1800)}`);
    const tags = new Map();
    for (const r of recs.slice(0, 500)) for (const [, tag, v] of r.matchAll(/<(?:[\w-]+:)?(\w*(?:[Dd]ir|[Bb]ear|[Hh]ead|[Oo]rient|[Aa]ngle|[Aa]zim|[Ll]ook|[Vv]iew|[Dd]estination)\w*)>([^<]*)</g)) {
      const k = `${tag}=${v.slice(0, 40)}`;
      tags.set(k, (tags.get(k) ?? 0) + 1);
    }
    console.log([...tags].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `${k}×${n}`).join(" | "));
  } catch (e) {
    console.log(`\n### ${name}\nERROR ${e.message}`);
  }
}
