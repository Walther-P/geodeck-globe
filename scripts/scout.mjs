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

const tp = await show("taipei allavailable json", "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json", { raw: 200 });
if (tp?.data) console.log("taipei top keys", Object.keys(tp.data), "UPDATETIME", tp.data.UPDATETIME, "known", tp.data.park.filter((p) => p.availablecar >= 0).length, "/", tp.data.park.length);
const r = await fetch("https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json", { method: "HEAD", headers: { origin: ORIGIN } });
console.log("taipei last-modified", r.headers.get("last-modified"), "acao", r.headers.get("access-control-allow-origin"), "cache", r.headers.get("cache-control"));
const tc = await show("taichung opendata", "https://motoretag.taichung.gov.tw/DataAPI/api/ParkingAPIV2/Opendata", { raw: 900 });
if (Array.isArray(tc)) console.log("taichung opendata n", tc.length, "keys", Object.keys(tc[0] ?? {}));
const tcs = await show("taichung spotlist", "https://motoretag.taichung.gov.tw/DataAPI/api/ParkingSpotListAPIV2", { raw: 100 });
if (Array.isArray(tcs)) {
  const lots = tcs.flatMap((g) => g.ParkingLots ?? []);
  console.log("taichung spotlist lots", lots.length, "keys", Object.keys(lots[0] ?? {}), "groups", Object.keys(tcs[0] ?? {}));
}
for (const id of ["25940", "83931"]) {
  const m = await show(`meta ${id}`, `https://data.gov.tw/api/v2/rest/dataset/${id}`, { raw: 50 });
  for (const d of m?.result?.distribution ?? []) console.log(id, d.resourceDescription, d.resourceFormat, d.resourceDownloadUrl, d.resourceAccessUrl);
}
await show("tainan parkweb", "https://parkweb.tainan.gov.tw/api/parking.php", { raw: 120 });
