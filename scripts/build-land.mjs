// Writes public/data/land-110m.json (Natural Earth, public domain) so the globe
// still shows continents when the vector tile service is unreachable.
import { readFileSync, writeFileSync } from "node:fs";
import { feature } from "topojson-client";

const topo = JSON.parse(readFileSync(new URL("../node_modules/world-atlas/land-110m.json", import.meta.url)));
const geo = feature(topo, topo.objects.land);
const round = (c) => (typeof c[0] === "number" ? [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100] : c.map(round));
for (const f of geo.features) f.geometry.coordinates = round(f.geometry.coordinates);
writeFileSync(new URL("../public/data/land-110m.json", import.meta.url), JSON.stringify(geo));
console.log("land-110m.json", JSON.stringify(geo).length, "bytes");
