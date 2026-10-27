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


const gz = await show("taipei allavailable gz", "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.gz", { raw: 100 });
if (gz?.data) console.log("taipei gz UPDATETIME", gz.data.UPDATETIME, "n", gz.data.park?.length, "known", gz.data.park?.filter((p) => p.availablecar >= 0).length);
const m = await show("meta 128435", "https://data.gov.tw/api/v2/rest/dataset/128435", { raw: 50 });
for (const d of m?.result?.distribution ?? []) console.log("128435", d.resourceDescription, d.resourceFormat, d.resourceDownloadUrl);
const ty = await show("taoyuan download", "https://opendata.tycg.gov.tw/api/dataset/f4cc0b12-86ac-40f9-8745-885bddc18f79/resource/0daad6e6-0632-44f5-bd25-5e1de1e9146f/download", { raw: 1200 });
const tyj = await show("taoyuan download json", "https://opendata.tycg.gov.tw/api/dataset/f4cc0b12-86ac-40f9-8745-885bddc18f79/resource/0daad6e6-0632-44f5-bd25-5e1de1e9146f/download?format=json", { raw: 1200 });
await show("taoyuan v1 rest", "https://opendata.tycg.gov.tw/api/v1/rest/datastore/0daad6e6-0632-44f5-bd25-5e1de1e9146f?format=json&limit=2", { raw: 1200 });
const tcs = await show("taichung spotlist", "https://motoretag.taichung.gov.tw/DataAPI/api/ParkingSpotListAPIV2", { raw: 50 });
if (Array.isArray(tcs)) {
  const lots = tcs.flatMap((g) => g.ParkingLots ?? []);
  console.log("taichung lots", lots.length, "sample", JSON.stringify(lots.slice(0, 2).map(({ Notes, EnNotes, ...x }) => x)));
  console.log("taichung updatetimes", JSON.stringify([...new Set(lots.map((l) => l.Updatetime))].slice(0, 6)));
}
