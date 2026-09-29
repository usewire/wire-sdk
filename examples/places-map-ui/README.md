# Places map: a reference MCP App

An [MCP App](https://github.com/modelcontextprotocol/ext-apps) (`io.modelcontextprotocol/ui`, spec
2026-01-26) that renders saved places on an interactive map. It is the view for Someday's
`search_places` tool on Wire, and the reference an agent copies when it ships a UI in its Wire
manifest. Built with [mapcn](https://www.mapcn.dev/) (shadcn-registry map components on MapLibre GL),
React-style components compiled against Preact, Tailwind v4, and the ext-apps `App` SDK.

![Places map in the ext-apps basic-host, light theme, strict CSP](screenshot.jpg)

This package is self-contained. It is not part of the SDK's build, tests or published files.

## Build

```bash
npm install
npm run build        # dist/places-map.html (one file) + dist/csp.json
npm run verify:cdn   # optional: check the jsDelivr files match the installed maplibre-gl byte for byte
```

The build fails if the HTML is over Wire's per-UI cap (512 KB). It is about 337 KB today.
`ANALYZE=1 npm run build` prints what each package contributes.

## What it reads

Either of two results: a `render_places_map` result (wire_query rows, see
[In a Wire manifest](#in-a-wire-manifest)) or a `search_places` result. Either arrives as
`structuredContent` or as JSON in a text block (Wire's `tools/call` sends both). The search result:

```json
{ "presentation": "map", "center": { "lat": 40.7359, "lng": -73.9911 }, "matches": [ ... ] }
```

Each match is a `wire_search` match. Since engine usewire/wire#126, a declared-object record
carries its `fields`, coordinates first, capped at 4 KB (`fields_truncated: true` when trimmed):

```json
{ "id": "…", "score": 0.91, "content": "…", "source": "app:someday", "distance_km": 0.36,
  "fields": { "lat": 37.7825, "lng": -122.4074, "name": "Blue Bottle Coffee", "address": "66 Mint St" },
  "provenance": { "tags": ["coffee"], … } }
```

`src/places.ts` reads `match.fields` first: coordinates, name, address, and locality / region /
country. Tags come from top-level `tags`, then `provenance.tags`. It also accepts `object.fields`,
`_fields`, `properties._fields`, JSON content, and rows with top-level or nested `place` `lat`/`lng`
(what's-on style). For engines before #126, the last resort is the content Someday's `save_place`
writes (`name\naddress\narea\nlat <lat>, lng <lng>`); `LEGACY_MATCHES=1 npm run dev:server` serves
that shape. A match with no usable coordinates is skipped and counted, never pinned at 0,0.

When the search uses `matchLinked` (usewire/wire#128), a place found through a linked record
carries `matchedVia: [{ id, object, type, score, content, fields? }]`, best first. The view says
why, from the first entry: "Matched your note: “best cortado in town”", "Matched your visit on
2026-09-20", "Matched the event “…”". It adds "+N more" when several records matched.

## What it does

Fits the map to every place. Each place gets a numbered pin, the search `center` gets a ring, and
the list sits under the map. Clicking a list row flies to the place; clicking a pin pans to it.
Either opens a popup with name, address, area, distance, why it matched (when it was found through
a linked record) and tags. The list row shows why it matched too. The popup has two buttons, each
shown only when the host declares the capability: **Tell me more** (`ui/message`) and **Maps**
(`ui/open-link`). The page follows the host's theme (`data-theme`), style variables and fonts. It
fills a fixed-height container, or reports its own height.

It also sends diagnostics as MCP log messages (`app.sendLog`, logger `places-map`): where the tile
worker runs, any CSP violation, and MapLibre load errors. The sandboxed iframe's console is often
out of reach, so this is how you debug a blank map.

## CSP and loading

`dist/csp.json`:

```json
{
  "connectDomains": ["https://tiles.openfreemap.org"],
  "resourceDomains": ["https://cdn.jsdelivr.net"]
}
```

- **MapLibre GL JS** (6.11.2, ~1 MB of ESM) is not bundled. An import map resolves `maplibre-gl` to
  jsDelivr, and the import map's `integrity` plus `modulepreload` links pin SHA-384 digests. The
  digests are computed at build time from the installed, exact-pinned package. The stylesheet
  loads the same way, with SRI. The version comes from `package.json`, so bump it there.
- **Tiles** come from [OpenFreeMap](https://openfreemap.org) (positron / dark). It is free, needs
  no key, allows commercial use, and serves the style, vector and raster tiles, sprites and glyphs
  from one origin. mapcn defaults to CARTO basemaps. To use those instead, pass mapcn's default
  `styles` and set `connectDomains` to `https://basemaps.cartocdn.com` and
  `https://*.basemaps.cartocdn.com`. Mind CARTO's terms for commercial use.
- **The tile worker.** MapLibre parses tiles in a module Web Worker. A worker can't be started from a
  cross-origin URL, so MapLibre starts it from a `blob:` URL. That needs `worker-src blob:`, which
  some hosts allow (basic-host does). The spec's reference CSP doesn't, and a Wire manifest's
  `csp` can only add https origins. `src/maplibre-worker.ts` probes once at startup. If blob
  workers are refused, it swaps in an in-thread stand-in. That stand-in runs the same
  `maplibre-gl-worker.mjs`, imported from jsDelivr on the main thread, over a `MessageChannel`.
  The map works under either CSP. Under the strict one, tile parsing runs on the main thread,
  which is fine for a page of places.
- **zod's JIT** probes `new Function` on first parse, which is a CSP violation without
  `'unsafe-eval'`. The page sets `jitless: true`, so no probe runs.
- The worker module that a real (blob) worker imports is fetched without SRI, because import maps
  don't apply inside workers. It is the same pinned, immutable jsDelivr version.

## In a Wire manifest

The recommended shape splits finding from showing: `search_places` has **no** view, and a
separate `render_places_map` shows the places the model picked. The model reads the search
results and decides what's worth a map, so a map doesn't pop up on every search. See
`manifest-snippet.ts` for the whole thing, checked against the engine's validator:

```ts
ui: [{ name: 'places-map', title: 'Places map', html, csp }],
tools: [
  { name: 'search_places', /* ...as today, no ui... */ },
  {
    name: 'render_places_map',
    inputSchema: { type: 'object', properties: {
      place_ids: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 50 },
      title: { type: 'string', maxLength: 80 },
      center: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } }, required: ['lat', 'lng'] },
    }, required: ['place_ids'] },
    tool: { name: 'wire_query', args: {
      sql: "SELECT p._entry_id AS id, p.name, p.lat, p.lng, p.address, p.locality FROM json_each(?1, '$.ids') AS ids JOIN place AS p ON p._entry_id = ids.value ORDER BY ids.key",
      params: ['{"ids":{{input.place_ids}}}'],
    } },
    result: { presentation: 'map', columns: '{{tool.columns}}', rows: '{{tool.rows}}', truncated: '{{tool.truncated}}',
              _meta: { title: '{{input.title}}', center: '{{input.center}}' } },
    annotations: { title: 'Show places on a map' },
    ui: { resource: 'places-map' },
  },
],
```

Some details:

- **The param.** wire_query params must be scalars, and a whole-value `'{{input.place_ids}}'`
  keeps its array type, so the validator refuses it. Embedded in a string, the array becomes
  its JSON: `'{"ids":{{input.place_ids}}}'` binds `{"ids":["…","…"]}`, and `json_each(?1,
  '$.ids')` reads it. The ids are bound as a value, never spliced into SQL. Joining on
  `json_each` keeps the model's order, so pin numbers follow the list the model gives.
- **`_meta`** in `result` is view-only. Wire returns it as the MCP result's `_meta.view`: the
  view uses `title` as its heading and `center` as the search point, and the model never sees it.
- **The view reads both shapes.** A `render_places_map` result has wire_query's
  `{ columns, rows: [[…]] }`, zipped into records by column. A `search_places` result has
  `matches`. Keeping `ui` on `search_places` still works if you prefer one tool.
- **Hashed URI.** Wire serves the view at `ui://<app id>/places-map-<hash>`, where the hash is the
  first 8 hex digits of the HTML's SHA-256, so a host never renders a cached old version after
  an upgrade. A host without MCP Apps shows the tool's normal result. Keep that complete on its own.

## Test it locally

`dev-server/` is a stand-in for Someday on Wire, serving the built HTML at its hashed
`ui://someday/places-map-<hash>`. It has two tools:

- `render_places_map` runs the recommended SQL above in a real SQLite over the sample places, and
  returns `_meta.view`.
- `search_places` covers six NYC places and their notes and visits, in the engine's exact match
  shape. Search `"cortado"` to get a place found only through its note.

```bash
npm run build && npm run dev:server              # http://localhost:3001/mcp

git clone https://github.com/modelcontextprotocol/ext-apps && cd ext-apps/examples/basic-host
patch -p1 < <this dir>/dev-server/basic-host.patch   # optional: strict CSP, message capability
npm install && npm run build
bun serve.ts                                      # or STRICT_SPEC_CSP=1 bun serve.ts
# open http://localhost:8080, pick someday-dev / search_places, Call Tool
```

## Files

| Path | What |
|---|---|
| `src/components/ui/map.tsx` | mapcn's `map` component, installed with `npx shadcn add @mapcn/map`. One change: the CSS import is removed. |
| `src/App.tsx` | the view: connection, theme, sizing, map, list, popup |
| `src/places.ts` | tool result → places, defensively |
| `src/maplibre-worker.ts` | worker URL, blob probe, in-thread fallback |
| `src/diagnostics.ts` | CSP violations and errors → MCP log messages; zod jitless |
| `scripts/postbuild.mjs` | import map + SRI, `dist/csp.json`, size cap |
| `dev-server/` | local MCP server, sample places, basic-host test patch |
