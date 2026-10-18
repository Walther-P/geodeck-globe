// Renders public/icon.svg (rounded) and icon-maskable.svg (full-bleed, for
// Android masks and the iOS home screen) to the PNG sizes those need.
//   CHROMIUM_PATH=/path/to/chrome node scripts/render-icons.mjs
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
for (const [svg, size, out, transparent] of [
  [read("icon.svg"), 192, "icon-192.png", true],
  [read("icon.svg"), 512, "icon-512.png", true],
  [read("icon-maskable.svg"), 512, "icon-maskable-512.png", false],
  [read("icon-maskable.svg"), 180, "apple-touch-icon.png", false],
]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
  await page.screenshot({ path: new URL(`../public/${out}`, import.meta.url).pathname, omitBackground: transparent });
  await page.close();
}
await browser.close();
console.log("icons written");
