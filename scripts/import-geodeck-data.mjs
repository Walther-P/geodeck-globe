// Copies the Taiwan datasets built for GeoDeck 0.7 (KTAK-DEV/geodeck/data)
// into public/data, slimmed to the fields this app reads.
//
//   node scripts/import-geodeck-data.mjs /path/to/KTAK-DEV/geodeck/data
//
// Camera images are kept only when the government operator hosts them
// (freeway.gov.tw, thb.gov.tw); entries that point at a third-party mirror
// keep their location and a link to that page, but no hotlinked image.

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";

const src = resolve(process.argv[2] ?? "");
const out = resolve(import.meta.dirname, "../public/data");
if (!process.argv[2]) {
  console.error("usage: node scripts/import-geodeck-data.mjs <KTAK-DEV/geodeck/data>");
  process.exit(1);
}
mkdirSync(out, { recursive: true });

cpSync(join(src, "parking"), join(out, "parking"), { recursive: true });
cpSync(join(src, "parking-cameras.json"), join(out, "parking-cameras.json"));

const enforcement = JSON.parse(readFileSync(join(src, "enforcement-tw.json"), "utf8"));
writeFileSync(
  join(out, "enforcement-tw.json"),
  JSON.stringify({
    provider: enforcement.provider,
    source: enforcement.source,
    license: enforcement.license,
    fetchedAt: enforcement.fetchedAt,
    points: enforcement.points.map((p) => ({
      id: p.id,
      lat: p.lat,
      lng: p.lng,
      name: p.name,
      direction: p.directionText ?? "",
      limit: p.speedLimit ?? null,
    })),
  }),
);

const OFFICIAL = /(^|\.)(freeway\.gov\.tw|thb\.gov\.tw)$/;
const cams = JSON.parse(gunzipSync(readFileSync(join(src, "cameras-tw.json.gz"))).toString("utf8"));
let official = 0;
const cameras = cams.cameras.map((c) => {
  let image = null;
  try {
    const u = new URL(c.image);
    if (u.protocol === "https:" && OFFICIAL.test(u.hostname)) image = u.toString();
  } catch {
    /* no image */
  }
  if (image) official += 1;
  return { id: c.id, lat: c.lat, lng: c.lng, name: c.name, image, page: c.source ?? null };
});
writeFileSync(
  join(out, "cameras-tw.json"),
  JSON.stringify({ updatedAt: cams.updatedAt, catalog: cams.source, cameras }),
);
console.log(`parking copied; ${enforcement.points.length} enforcement points; ${cameras.length} cameras (${official} with official images)`);
