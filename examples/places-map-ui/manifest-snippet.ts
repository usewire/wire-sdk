// How an agent (Someday) ships this view in its Wire manifest. Not built or published; it is here
// to be copied. The manifest's `ui` list carries the HTML inline (hash-pinned, shown at consent)
// with the CSP the page needs, and the tool that renders into it names it by `ui.resource`.
//
// Wire serves the view at a HASHED URI, ui://<app id>/places-map-<sha256(html)[0..8]>
// (`uiUri(appId, name, uiResourceHash(html))` in @usewire/sdk/agent), as
// `text/html;profile=mcp-app` with `_meta.ui.csp`, and lists the rendering tool with
// `_meta.ui.resourceUri` pointing at it. A changed view is a new URI, so a host never renders a
// cached old one. A host without MCP Apps ignores all of it and shows the tool's normal result.
//
// THE RECOMMENDED SHAPE: split finding from showing (usewire/wire#129).
//   search_places      finds places (wire_search). NO `ui`: the model reads the matches and decides
//                      which ones matter, without a map popping up on every search.
//   render_places_map  shows the places the model picked, by id (wire_query). Carries the view.
// The view also still renders a search_places result, if you prefer one tool.
//
// WHY THE PARAM LOOKS LIKE THAT. wire_query binds `params` to `?1`… and each param must be a
// string, number, boolean or null. A whole-value `'{{input.place_ids}}'` keeps its array type, so
// the manifest validator refuses it ("input.place_ids can be array, but wire_query expects string
// or number or boolean or null here"). Embedded in a longer string, a substituted array becomes
// its JSON text, so `'{"ids":{{input.place_ids}}}'` binds `{"ids":["id1","id2"]}`, which the SQL
// reads with json_each(?1, '$.ids'). The ids are JSON-encoded by the engine and bound as a value,
// never spliced into SQL. Joining on json_each (rather than `IN (...)`) keeps the model's order.
// Verified against the engine's own validator and template substitution (vendored at
// usewire/wire@027a1cf) and in SQLite; dev-server/server.mjs runs this SQL.
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

/** The manifest changes, shown against Someday's existing manifest (other fields elided). */
export const manifestChanges = {
  ui: [placesMapUi],
  tools: [
    {
      name: "search_places",
      // ...enabled, description, inputSchema, tool (wire_search), result exactly as today, and
      // NO `ui`. Its description should end: "To show places on a map, call render_places_map
      // with the ids of the ones you want to show."
    },
    {
      name: "render_places_map",
      enabled: true,
      description:
        "Show saved places on a map for the user. Pass the ids of places you already found with search_places or get_place (each match's `id`), in the order you want them listed. Nothing is searched.",
      inputSchema: {
        type: "object",
        properties: {
          place_ids: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 50 },
          title: { type: "string", maxLength: 80, description: 'A short heading for the map, e.g. "Coffee near you".' },
          center: {
            type: "object",
            properties: { lat: { type: "number" }, lng: { type: "number" } },
            required: ["lat", "lng"],
            description: "The point the places were found around, if any.",
          },
        },
        required: ["place_ids"],
      },
      tool: {
        name: "wire_query",
        args: {
          sql: "SELECT p._entry_id AS id, p.name, p.lat, p.lng, p.address, p.locality FROM json_each(?1, '$.ids') AS ids JOIN place AS p ON p._entry_id = ids.value ORDER BY ids.key",
          params: ['{"ids":{{input.place_ids}}}'],
        },
      },
      // wire_query answers { columns, rows: [[...]], rowCount, truncated }. The model gets those
      // (and `presentation`); `_meta` is VIEW-ONLY: Wire returns it as the MCP result's
      // `_meta.view`, which the view reads and the model never sees.
      result: {
        presentation: "map",
        columns: "{{tool.columns}}",
        rows: "{{tool.rows}}",
        truncated: "{{tool.truncated}}",
        _meta: { title: "{{input.title}}", center: "{{input.center}}" },
      },
      // Inherited from wire_query: readOnlyHint true, destructiveHint false, openWorldHint false.
      // Overrides may only be more cautious; a title is always allowed.
      annotations: { title: "Show places on a map" },
      ui: { resource: "places-map" },
    },
  ],
};
