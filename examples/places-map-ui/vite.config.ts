import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = path.dirname(fileURLToPath(import.meta.url));
// The installed (exact-pinned) maplibre-gl version is the version loaded from the CDN, so the
// types we compile against and the code the page runs are the same release.
const maplibreVersion = JSON.parse(readFileSync(path.join(root, "node_modules/maplibre-gl/package.json"), "utf8")).version;

/** `ANALYZE=1 npm run build` prints the minified bytes each package contributes. */
const analyze: Plugin = {
  name: "analyze-bundle",
  apply: "build",
  generateBundle(_, bundle) {
    if (!process.env.ANALYZE) return;
    const sizes = new Map<string, number>();
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== "chunk") continue;
      for (const [id, m] of Object.entries(chunk.modules)) {
        const nm = id.split("node_modules/").pop()!;
        const parts = nm.split("/");
        const key = !id.includes("node_modules/") ? "(app)" : parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
        sizes.set(key, (sizes.get(key) ?? 0) + m.renderedLength);
      }
    }
    for (const [k, v] of [...sizes].sort((a, b) => b[1] - a[1])) console.log(`${(v / 1024).toFixed(1).padStart(8)} KB  ${k}`);
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), analyze],
  define: { __MAPLIBRE_VERSION__: JSON.stringify(maplibreVersion) },
  resolve: {
    // React is written against, Preact (via preact/compat) is shipped: react-dom alone is ~200 KB
    // minified, which with the MCP Apps SDK (and the zod it validates with) puts one HTML file
    // over Wire's 512 KB per-UI cap. mapcn, lucide-react and ext-apps/react only use the hooks,
    // forwardRef, createPortal and useId that preact/compat implements.
    alias: [
      { find: "@", replacement: path.join(root, "src") },
      { find: "react/jsx-runtime", replacement: "preact/jsx-runtime" },
      { find: "react/jsx-dev-runtime", replacement: "preact/jsx-dev-runtime" },
      { find: "react-dom/client", replacement: "preact/compat/client" },
      { find: "react-dom", replacement: "preact/compat" },
      { find: "react", replacement: "preact/compat" },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: path.join(root, "places-map.html"),
      // MapLibre GL JS (~1 MB of ESM) is NOT bundled: the page's import map points the bare
      // specifier at a pinned, integrity-checked jsDelivr URL (see places-map.html and
      // scripts/postbuild.mjs). Everything else is inlined into one HTML file.
      external: ["maplibre-gl"],
    },
  },
});
