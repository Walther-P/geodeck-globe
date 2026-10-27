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



const x = await show("taipei allavailable xml", "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.xml", { raw: 1500 });
if (typeof x === "string") console.log("taipei xml length", x.length, "records", (x.match(/<id>/gi) ?? []).length, "tail", x.slice(-300).replace(/\s+/g, " "));
const r = await fetch("https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.xml", { method: "HEAD", headers: { origin: ORIGIN } });
console.log("taipei xml last-modified", r.headers.get("last-modified"), "acao", r.headers.get("access-control-allow-origin"));
const c = await show("taipei cms xml", "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allCMSavailable.xml", { raw: 600 });
