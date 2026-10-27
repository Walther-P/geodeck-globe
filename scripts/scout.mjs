// Temporary: what Tainan's parking site answers through the deployed relay (Cloudflare) vs directly.
const SITE = "https://geodeck-globe.ht500119es.workers.dev";
const TARGET = "https://parkweb.tainan.gov.tw/api/parking.php";
for (const [name, url, headers] of [
  ["direct", TARGET, { origin: SITE }],
  ["relay", `${SITE}/relay?u=${encodeURIComponent(TARGET)}`, { origin: SITE, referer: `${SITE}/` }],
  ["relay (accept json)", `${SITE}/relay?u=${encodeURIComponent(TARGET)}`, { origin: SITE, referer: `${SITE}/`, accept: "application/json" }],
]) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    console.log(`\n### ${name}\n${r.status} ${[...r.headers].map(([k, v]) => `${k}=${v}`).join(" | ")}\nlength ${t.length}\n${t.slice(0, 1200).replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`\n### ${name}\nERROR ${e.message} ${e.cause?.code ?? ""}`);
  }
}
