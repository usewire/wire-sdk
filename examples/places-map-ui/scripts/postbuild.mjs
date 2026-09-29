// After `vite build`: point the page at the pinned maplibre-gl on jsDelivr (import map +
// modulepreload + stylesheet, each with SRI computed from the installed package), write the
// CSP the page needs to dist/csp.json, and enforce Wire's per-UI size cap.
//
//   node scripts/postbuild.mjs               build step
//   node scripts/postbuild.mjs --verify-cdn  only fetch each CDN file and check its digest
//                                            matches the installed package (needs network)

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const htmlPath = path.join(dist, "places-map.html");

/** Wire's cap on one UI resource's html (UI_HTML_MAX_BYTES in the engine's manifest validator). */
const HARD_CAP = 512 * 1024;
const TARGET = 300 * 1024;

/** Every origin the page reaches, by CSP list (McpUiResourceCsp; Wire's manifest `ui[].csp`). */
export const CSP = {
  // fetch(): the map style, vector + raster tiles, sprites and glyphs. All OpenFreeMap.
  connectDomains: ["https://tiles.openfreemap.org"],
  // <script type=module>/import(), <link rel=stylesheet>: maplibre-gl JS, its worker, its CSS.
  resourceDomains: ["https://cdn.jsdelivr.net"],
};

const pkg = JSON.parse(readFileSync(path.join(root, "node_modules/maplibre-gl/package.json"), "utf8"));
const version = pkg.version;
const cdn = `https://cdn.jsdelivr.net/npm/maplibre-gl@${version}/dist`;
const local = path.join(root, "node_modules/maplibre-gl/dist");
const sri = (bytes) => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

const files = ["maplibre-gl.mjs", "maplibre-gl-shared.mjs", "maplibre-gl-worker.mjs", "maplibre-gl.css"];
const integrity = Object.fromEntries(files.map((f) => [f, sri(readFileSync(path.join(local, f)))]));

if (process.argv.includes("--verify-cdn")) {
  for (const f of files) {
    const res = await fetch(`${cdn}/${f}`);
    if (!res.ok) throw new Error(`${cdn}/${f}: HTTP ${res.status}`);
    const got = sri(Buffer.from(await res.arrayBuffer()));
    if (got !== integrity[f]) throw new Error(`${f}: CDN digest ${got} != installed ${integrity[f]}`);
    console.log(`verified ${f} ${got}`);
  }
  process.exit(0);
}

// The import map resolves the bare `maplibre-gl` specifier left in the bundle (vite external),
// and its `integrity` map covers every module URL the page imports: the entry, the shared chunk
// it imports, and the worker module (imported on the main thread when a strict CSP blocks blob:
// workers; see src/maplibre-worker.ts). The modulepreloads carry the same digests, which is what
// enforces them in browsers that predate import-map integrity.
const importMap = {
  imports: { "maplibre-gl": `${cdn}/maplibre-gl.mjs` },
  integrity: Object.fromEntries(files.filter((f) => f.endsWith(".mjs")).map((f) => [`${cdn}/${f}`, integrity[f]])),
};
const head = [
  `<script type="importmap">${JSON.stringify(importMap)}</script>`,
  `<link rel="modulepreload" href="${cdn}/maplibre-gl.mjs" integrity="${integrity["maplibre-gl.mjs"]}" crossorigin="anonymous">`,
  `<link rel="modulepreload" href="${cdn}/maplibre-gl-shared.mjs" integrity="${integrity["maplibre-gl-shared.mjs"]}" crossorigin="anonymous">`,
  `<link rel="stylesheet" href="${cdn}/maplibre-gl.css" integrity="${integrity["maplibre-gl.css"]}" crossorigin="anonymous">`,
].join("\n    ");

let html = readFileSync(htmlPath, "utf8");
const marker = /<!--\s*MAPLIBRE_FROM_CDN[\s\S]*?-->/;
if (!marker.test(html)) throw new Error("places-map.html: the MAPLIBRE_FROM_CDN marker is missing from the built page");
html = html.replace(marker, () => head);
const mapAt = html.indexOf('<script type="importmap">');
const moduleAt = html.indexOf('<script type="module"');
if (moduleAt !== -1 && moduleAt < mapAt) throw new Error("the import map must precede the first module script");
if (!/from\s*["']maplibre-gl["']/.test(html)) throw new Error("expected the bundle to import the bare 'maplibre-gl' specifier (is it still external?)");
writeFileSync(htmlPath, html);
writeFileSync(path.join(dist, "csp.json"), `${JSON.stringify(CSP, null, 2)}\n`);

const bytes = Buffer.byteLength(html, "utf8");
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`dist/places-map.html  ${kb(bytes)} (maplibre-gl ${version} from jsDelivr)`);
console.log(`dist/csp.json         ${JSON.stringify(CSP)}`);
if (bytes > HARD_CAP) {
  console.error(`places-map.html is ${kb(bytes)}; Wire's per-UI cap is ${kb(HARD_CAP)}`);
  process.exit(1);
}
if (bytes > TARGET) console.warn(`note: over the ${kb(TARGET)} target`);
