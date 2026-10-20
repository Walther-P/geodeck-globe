// Temporary: what each candidate source answers, and whether a browser may read it.
const ORIGIN = "https://geodeck-globe.ht500119es.workers.dev";
const ovq = (s, w, n, e) => `[out:json][timeout:20];nwr["amenity"="parking"](${s},${w},${n},${e});out center tags 30;`;
const C = [
  ["hk list tc", "https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_Tc.xml"],
  ["hk list en", "https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.xml"],
  ["sg", "https://api.data.gov.sg/v1/transport/traffic-images"],
  ["nz", "https://trafficnz.info/service/traffic/rest/4/cameras/all", { accept: "application/json" }],
  ["qld", "https://api.qldtraffic.qld.gov.au/v1/webcams?apikey=3e83add325cbb69ac4d8e5bf433d770b"],
  ["fi", "https://tie.digitraffic.fi/api/weathercam/v1/stations"],
  ["tfl", "https://api.tfl.gov.uk/Place/Type/JamCam"],
  ["dgt", "https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v36.xml"],
  ["autobahn roads", "https://verkehr.autobahn.de/o/autobahn/"],
  ["autobahn A1", "https://verkehr.autobahn.de/o/autobahn/A1/services/webcam"],
  ["nyc", "https://webcams.nyctmc.org/api/cameras"],
  ["caltrans d4", "https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json"],
  ["drivebc", "https://images.drivebc.ca/webcam/api/v1/webcams"],
  ["ontario", "https://511on.ca/api/v2/get/cameras?format=json"],
  ["alberta", "https://511.alberta.ca/api/v2/get/cameras?format=json"],
  ["maryland", "https://chartexp1.sha.maryland.gov/CHARTExportClientService/getCameraMapDataJSON.do"],
  ["quebec", "https://ws.mapserver.transports.gouv.qc.ca/swtq?service=wfs&version=2.0.0&request=getfeature&typename=ms:infos_cameras&outputformat=geojson"],
  ["iceland", "https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1"],
  ["iowa", "https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson&resultRecordCount=3"],
  ["virginia", "https://511.vdot.virginia.gov/services/map/layers/map/cams"],
  ["slovenia", "https://opendata.si/promet/kamere/"],
  ["windy (no key)", "https://api.windy.com/webcams/api/v3/webcams?limit=1"],
  ["overpass main", `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(ovq(25.03, 121.5, 25.05, 121.53))}`],
  ["overpass kumi", `https://overpass.kumi.systems/api/interpreter?data=${encodeURIComponent(ovq(35.68, 139.75, 35.7, 139.77))}`],
  ["overpass private.coffee", `https://overpass.private.coffee/api/interpreter?data=${encodeURIComponent(ovq(51.5, -0.13, 51.52, -0.1))}`],
  ["overpass mail.ru", `https://maps.mail.ru/osm/tools/overpass/api/interpreter?data=${encodeURIComponent(ovq(48.85, 2.33, 48.87, 2.36))}`],
];
for (const [name, url, headers = {}] of C) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { origin: ORIGIN, "user-agent": "baiyan-scout/1 (+https://github.com/Walther-P/geodeck-globe)", ...headers }, signal: AbortSignal.timeout(25000) });
    const text = await r.text();
    let summary = text.slice(0, 1500).replace(/\s+/g, " ");
    try {
      const d = JSON.parse(text);
      const arr = Array.isArray(d) ? d : d.features ?? d.items ?? d.webcams ?? d.data ?? d.elements ?? d.cameras ?? null;
      summary = `json ${Array.isArray(d) ? "array" : `keys ${Object.keys(d).slice(0, 12).join(",")}`}; n=${Array.isArray(arr) ? arr.length : "?"}; first ${JSON.stringify(Array.isArray(arr) ? arr[0] : d).slice(0, 1500)}`;
    } catch {}
    console.log(`\n### ${name}\n${r.status} ${r.headers.get("content-type")} acao=${r.headers.get("access-control-allow-origin")} bytes=${text.length} ${Date.now() - t0}ms\n${url}\n${summary}`);
  } catch (e) {
    console.log(`\n### ${name}\nERROR ${e.message} ${Date.now() - t0}ms\n${url}`);
  }
}
