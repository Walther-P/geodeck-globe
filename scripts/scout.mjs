// Temporary: how often the keyless parking and bike feeds update.
const ORIGIN = "https://geodeck-globe.ht500119es.workers.dev";
const get = async (url, as = "text") => {
  const r = await fetch(url, { headers: { origin: ORIGIN, "user-agent": "baiyan-scout/1" }, signal: AbortSignal.timeout(25000) });
  return as === "json" ? r.json() : r.text();
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const tw = (s) => {
  const m = s?.match(/^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) CST (\d{4})$/);
  if (m) return Date.UTC(+m[6], MONTHS.indexOf(m[1]), +m[2], +m[3] - 8, +m[4], +m[5]);
  return s ? Date.parse(s.replace(" ", "T") + "+08:00") : NaN;
};
const age = (t) => (Number.isFinite(t) ? `${Math.round((Date.now() - t) / 1000)}s` : "?");
const stats = (ts) => {
  const a = ts.filter(Number.isFinite).map((t) => (Date.now() - t) / 60000).sort((x, y) => x - y);
  if (!a.length) return "none";
  const q = (p) => a[Math.floor(p * (a.length - 1))].toFixed(1);
  return `n=${a.length} min ${q(0)} p25 ${q(0.25)} median ${q(0.5)} p75 ${q(0.75)} p90 ${q(0.9)} max ${q(1)} (minutes)`;
};
for (let round = 0; round < 12; round++) {
  const line = [new Date().toISOString().slice(11, 19)];
  try {
    const x = await get("https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.xml");
    line.push(`taipei ${age(tw(x.match(/<UPDATETIME>([^<]+)/)?.[1]))}`);
  } catch (e) { line.push(`taipei ERR ${e.message}`); }
  try {
    const x = await get("https://opendata.tycg.gov.tw/api/dataset/f4cc0b12-86ac-40f9-8745-885bddc18f79/resource/0daad6e6-0632-44f5-bd25-5e1de1e9146f/download");
    line.push(`taoyuan ${age(tw(x.match(/updatetime="([^"]+)"/)?.[1]))}`);
  } catch (e) { line.push(`taoyuan ERR ${e.message}`); }
  try {
    const g = await get("https://motoretag.taichung.gov.tw/DataAPI/api/ParkingSpotListAPIV2", "json");
    const ts = g.flatMap((x) => x.ParkingLots ?? []).map((l) => tw(l.Updatetime));
    line.push(`taichung ${round % 4 === 0 ? stats(ts) : `newest ${age(Math.max(...ts.filter(Number.isFinite)))}`}`);
  } catch (e) { line.push(`taichung ERR ${e.message}`); }
  try {
    const rows = await get("https://parkweb.tainan.gov.tw/api/parking.php", "json");
    const ts = rows.map((r) => tw(r.update_time));
    line.push(`tainan ${round % 4 === 0 ? stats(ts) : `newest ${age(Math.max(...ts.filter(Number.isFinite)))}`}`);
  } catch (e) { line.push(`tainan ERR ${e.message}`); }
  if (round % 4 === 0)
    try {
      const n = await get("https://api.citybik.es/v2/networks/youbike-taipei", "json");
      const st = n.network.stations;
      line.push(`citybikes youbike-taipei ${st.length} stations ${stats(st.map((s) => Date.parse(s.timestamp)))} sample ${JSON.stringify(st[0]).slice(0, 400)}`);
    } catch (e) { line.push(`citybikes ERR ${e.message}`); }
  console.log(line.join(" | "));
  await new Promise((r) => setTimeout(r, 45000));
}
