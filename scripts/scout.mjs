// Temporary: Spain's redirect and New Zealand's format by Accept header.
for (const [name, url, headers] of [
  ["dgt manual", "https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v36.xml", {}],
  ["nz accept */*", "https://trafficnz.info/service/traffic/rest/4/cameras/all", { accept: "*/*" }],
  ["nz accept json", "https://trafficnz.info/service/traffic/rest/4/cameras/all", { accept: "application/json" }],
  ["qld again", "https://api.qldtraffic.qld.gov.au/v1/webcams?apikey=3e83add325cbb69ac4d8e5bf433d770b", {}],
]) {
  let u = url;
  for (let hop = 0; hop < 5; hop++) {
    const r = await fetch(u, { redirect: "manual", headers: { "user-agent": "Baiyan/0.2 (+https://github.com/Walther-P/geodeck-globe)", ...headers }, signal: AbortSignal.timeout(25000) });
    const loc = r.headers.get("location");
    const body = loc ? "" : (await r.text()).slice(0, 160).replace(/\s+/g, " ");
    console.log(`${name} hop${hop}: ${r.status} ${r.headers.get("content-type")} ${loc ? `-> ${loc}` : body}`);
    if (!loc) break;
    u = new URL(loc, u).toString();
  }
}
