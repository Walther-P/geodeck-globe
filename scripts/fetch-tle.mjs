// Bundles a fresh CelesTrak snapshot into dist/data so satellites still show
// when CelesTrak is unreachable. Run after `vite build`; failures are warnings.
import { writeFileSync } from "node:fs";

for (const group of ["stations", "visual", "starlink"]) {
  try {
    const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`, {
      headers: { "user-agent": "GeoDeckGlobe build (+https://github.com/Walther-P/geodeck-globe)" },
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    const sets = text.split("\n").filter((l) => l.startsWith("1 ")).length;
    if (!r.ok || sets === 0) throw new Error(`HTTP ${r.status}, ${sets} sets`);
    writeFileSync(new URL(`../dist/data/tle-${group}.txt`, import.meta.url), text);
    console.log(`tle-${group}.txt: ${sets} element sets`);
  } catch (e) {
    console.warn(`::warning::CelesTrak ${group} snapshot skipped: ${e.message}`);
  }
}
