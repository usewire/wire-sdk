// How an agent (Someday) ships this view in its Wire manifest. Not built or published; it is here
// to be copied. The manifest's `ui` list carries the HTML inline (hash-pinned, shown at consent)
// with the CSP the page needs, and the tool that renders into it names it by `ui.resource`.
//
// Wire serves the resource at ui://<app id>/places-map as `text/html;profile=mcp-app` with
// `_meta.ui.csp`, and lists `search_places` with `_meta.ui.resourceUri` pointing at it. A host
// without MCP Apps support ignores both and shows the tool's text result, which is why the
// result keeps `presentation: "map"` + `matches`: it must stand on its own.
//
// On Workers there is no fs: import the built files as text/JSON instead (wrangler `rules` with
// type "Text" for .html, or a build step that inlines them), e.g.
//   import html from "./ui/places-map.html";   import csp from "./ui/csp.json";

import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./dist/places-map.html", import.meta.url), "utf8");
const csp = JSON.parse(readFileSync(new URL("./dist/csp.json", import.meta.url), "utf8")) as {
  connectDomains: string[];
  resourceDomains: string[];
};

/** One entry of the manifest's `ui` list. */
export const placesMapUi = { name: "places-map", title: "Places map", html, csp };

/** The two manifest changes, shown against Someday's existing manifest (other fields elided). */
export const manifestChanges = {
  ui: [placesMapUi],
  tools: [
    {
      name: "search_places",
      // ...enabled, description, inputSchema, tool, result exactly as today. Keep the result's
      // `presentation: "map"`, `center` and `matches`: the view reads them, and so does any
      // client that can't render the view.
      ui: { resource: "places-map" },
    },
  ],
};
