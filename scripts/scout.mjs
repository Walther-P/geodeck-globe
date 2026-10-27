// Temporary: keyless live parking, bike share, EV charging and building heights.
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { gunzipSync } from "node:zlib";
const ORIGIN = "https://geodeck-globe.ht500119es.workers.dev";
async function show(name, url, { init = {}, raw = 900, gz = false } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...init, headers: { origin: ORIGIN, "user-agent": "baiyan-scout/1", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(25000) });
    let buf = Buffer.from(await r.arrayBuffer());
    if (gz || (buf[0] === 0x1f && buf[1] === 0x8b)) buf = gunzipSync(buf);
    const text = buf.toString("utf8").replace(/^﻿/, "");
    let summary = text.slice(0, raw).replace(/\s+/g, " ");
    let data = null;
    try {
      data = JSON.parse(text);
      const arr = Array.isArray(data) ? data : data.data?.park ?? data.retVal ?? data.result?.records ?? data.result ?? data.stations ?? data.network?.stations ?? data.networks ?? data.data ?? data.records ?? null;
      summary = `json ${Array.isArray(data) ? "array" : `keys ${Object.keys(data).slice(0, 10).join(",")}`}; n=${Array.isArray(arr) ? arr.length : "?"}; first ${JSON.stringify(Array.isArray(arr) ? arr[0] : data).slice(0, raw)}`;
    } catch {}
    console.log(`\n### ${name}\n${r.status} ${r.headers.get("content-type")} acao=${r.headers.get("access-control-allow-origin")} enc=${r.headers.get("content-encoding")} bytes=${buf.length} ${Date.now() - t0}ms\n${url}\n${summary}`);
    return data ?? text;
  } catch (e) {
    console.log(`\n### ${name}\nERROR ${e.message} ${e.cause?.code ?? ""}\n${url}`);
    return null;
  }
}
// ---- Parking
await show("taipei allavailable json", "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json");
await show("taipei allavailable gz", "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.gz");
await show("taipei alldesc json", "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json", { raw: 600 });
await show("taipei roadside", "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_roadquery.json", { raw: 400 });
const ntpcLive = await show("ntpc lots live", "https://data.ntpc.gov.tw/api/datasets/e09b35a5-a738-48cc-b0f5-570b67ad9c78/json?page=0&size=1000");
if (Array.isArray(ntpcLive)) console.log("ntpc live count", ntpcLive.length);
await show("ntpc curb", "https://data.ntpc.gov.tw/api/datasets/54a507c4-c038-41b5-bf60-bbecb9d052c6/json?page=0&size=3");
await show("taoyuan live A", "https://data.tycg.gov.tw/api/v1/rest/datastore/0daad6e6-0632-44f5-bd25-5e1de1e9146f?format=json&limit=3");
for (const id of ["128435", "25940", "83931", "128439", "123130", "88693", "149306"]) await show(`data.gov.tw ${id}`, `https://data.gov.tw/api/v2/rest/dataset/${id}`, { raw: 1400 });
await show("data.gov.tw search", `https://data.gov.tw/api/v2/rest/dataset?q=${encodeURIComponent("停車場 剩餘車位")}`, { raw: 1500 });
await show("taichung live A", "https://motoretag.taichung.gov.tw/DataAPI/api/ParkingSpotListAPIV2", { raw: 500 });
await show("tainan parkweb", "https://parkweb.tainan.gov.tw/api/parking.php", { raw: 500 });
// ---- Bikes
const ybtp = await show("youbike taipei", "https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json", { raw: 500 });
if (Array.isArray(ybtp)) console.log("youbike taipei stations", ybtp.length);
await show("youbike ntpc", "https://data.ntpc.gov.tw/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?page=0&size=3", { raw: 500 });
const yb = await show("youbike official list", "https://apis.youbike.com.tw/json/station-yb2.json", { raw: 500 });
if (Array.isArray(yb)) console.log("youbike official stations", yb.length, JSON.stringify([...new Set(yb.map((s) => s.area_code))]));
await show("youbike official availability", "https://apis.youbike.com.tw/tw2/parkingInfo", { init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ station_no: Array.isArray(yb) ? yb.slice(0, 2).map((s) => s.station_no) : [] }) }, raw: 600 });
const nets = await show("citybikes networks", "https://api.citybik.es/v2/networks?fields=id,name,location,company", { raw: 300 });
if (nets?.networks) {
  console.log("citybikes networks", nets.networks.length);
  const tw = nets.networks.filter((n) => ["TW", "JP", "KR", "HK"].includes(n.location?.country));
  console.log("citybikes TW/JP/KR/HK", JSON.stringify(tw.map((n) => [n.id, n.name, n.location.city, n.location.country])));
  const pick = tw.find((n) => /youbike/i.test(n.id)) ?? nets.networks.find((n) => n.location?.city === "Paris");
  if (pick) await show(`citybikes ${pick.id}`, `https://api.citybik.es/v2/networks/${pick.id}`, { raw: 700 });
}
// ---- Map tiles: charging stations and building heights
const tj = await show("ofm tilejson", "https://tiles.openfreemap.org/planet", { raw: 80 });
const tile = (lat, lng, z) => {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return [Math.floor(((lng + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)];
};
for (const [name, lat, lng] of [["Taipei Xinyi", 25.033, 121.565], ["London", 51.5074, -0.1278], ["Tokyo", 35.6812, 139.7671], ["Oslo", 59.9139, 10.7522]]) {
  const [x, y] = tile(lat, lng, 14);
  const r = await fetch(tj.tiles[0].replace("{z}", 14).replace("{x}", x).replace("{y}", y));
  const vt = new VectorTile(new Pbf(Buffer.from(await r.arrayBuffer())));
  const poi = vt.layers.poi;
  const hits = {};
  const samples = [];
  for (let i = 0; i < (poi?.length ?? 0); i++) {
    const p = poi.feature(i).properties;
    const k = `${p.class}/${p.subclass}`;
    if (/charg|fuel|electric/i.test(k)) {
      hits[k] = (hits[k] ?? 0) + 1;
      if (samples.length < 3) samples.push(p);
    }
  }
  const b = vt.layers.building;
  const bprops = b ? b.feature(0).properties : null;
  let withHeight = 0;
  for (let i = 0; i < (b?.length ?? 0); i++) if (b.feature(i).properties.render_height) withHeight++;
  console.log(`\nOFM ${name}: charging/fuel ${JSON.stringify(hits)} samples ${JSON.stringify(samples)}\n  buildings n=${b?.length} with render_height=${withHeight} first ${JSON.stringify(bprops)}`);
}
