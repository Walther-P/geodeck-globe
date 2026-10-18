// Gives dist/sw.js a unique build id so browsers notice each deploy.
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("../dist/sw.js", import.meta.url);
const build = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${process.env.GITHUB_SHA?.slice(0, 7) ?? "local"}`;
writeFileSync(file, readFileSync(file, "utf8").replace("__BUILD__", build));
console.log(`sw.js build ${build}`);
