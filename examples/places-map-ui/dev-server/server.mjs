// A local stand-in for Someday on Wire, for testing the places map in an MCP Apps host (e.g. the
// ext-apps basic-host). Two tools render into the view, one per shape the view reads:
//
//   render_places_map  the RECOMMENDED shape (usewire/wire#129's data/render split): the model
//                      finds places with search_places (no view), then shows the ones it picked.
//                      wire_query rows { columns, rows } + view-only `_meta.view` { title, center }.
//   search_places      a wire_search over object "place" ({ presentation: "map", center, matches }).
//                      It carries the view here only so both shapes can be tried; in the
//                      recommended manifest it has none.
//
// Both answer like the engine's tools/call (text JSON AND structuredContent). The view is served
// at its hashed URI, ui://someday/places-map-<sha8>, with the CSP from dist/csp.json.
//
//   npm run build && npm run dev:server        # http://localhost:3001/mcp  (PORT to change)

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { SAMPLE_LINKED, SAMPLE_PLACES } from "./sample-places.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");
const PORT = Number(process.env.PORT ?? 3001);
// Wire serves an app's UI at ui://<app id>/<name> (the engine's uiUri).
const RESOURCE_BASE = "ui://someday/places-map";

const toRad = (d) => (d * Math.PI) / 180;
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

/** What wire_search returns for one place record, in the engine's match shape (usewire/wire#126):
 *  `fields` for a declared-object record, coordinates first; `content` is what Someday's
 *  save_place wrote; tags under provenance. LEGACY_MATCHES=1 serves the pre-#126 shape (no
 *  `fields`), which exercises the view's content-scrape fallback. */
function toMatch(p, center, score, via) {
  const distance = haversineKm(center, p.fields);
  const { lat, lng, ...rest } = p.fields;
  return {
    id: p.id,
    score: Number(score.toFixed(4)),
    content: `${p.fields.name}\n${p.fields.address}\n${[p.fields.locality, p.fields.region, p.fields.country].join(", ")}\nlat ${lat}, lng ${lng}`,
    source: "app:someday",
    object: "place",
    distance_km: Number(distance.toFixed(3)),
    ...(process.env.LEGACY_MATCHES ? {} : { fields: { lat, lng, ...rest } }),
    // usewire/wire#128: the linked records that lifted this place, best first (at most 5).
    ...(via.length ? { matchedVia: via.slice(0, 5).map((v) => ({ id: v.id, object: v.object, type: v.type, score: v.score, content: v.content, fields: v.fields })) } : {}),
    provenance: { source: "app:someday", ingestedAt: p.ingestedAt, tags: p.tags, contentType: "text/plain" },
    _meta: { wire: { navigate: { entryId: p.id, relationships: 0 } } },
  };
}

/** A small imitation of wire_search over object "place" with `near` and, like Someday's
 *  search_places, `matchLinked: { objects: ["note", "visit", "event"] }`: a query term found in a
 *  linked note or visit lifts its place into the results and is listed in `matchedVia`. */
function searchPlaces({ query, lat, lng, radius_km, limit = 10 }) {
  const center = { lat, lng };
  const q = (query ?? "").trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const hitsIn = (text) => terms.filter((t) => text.toLowerCase().includes(t)).length;
  const scored = SAMPLE_PLACES.map((p) => {
    const direct = hitsIn(`${p.fields.name} ${p.fields.address} ${p.tags.join(" ")}`);
    const via = terms.length
      ? SAMPLE_LINKED.filter((l) => l.place === p.id)
          .map((l) => ({ ...l, hits: hitsIn(l.content) }))
          .filter((l) => l.hits > 0)
          .map((l) => ({ ...l, score: Number((0.5 + 0.1 * l.hits).toFixed(4)) }))
          .sort((a, b) => b.score - a.score)
      : [];
    return { p, hits: Math.max(direct, via[0]?.hits ?? 0), via, km: haversineKm(center, p.fields) };
  })
    .filter((s) => (terms.length ? s.hits > 0 : true))
    .filter((s) => (radius_km ? s.km <= radius_km : true))
    .sort((a, b) => b.hits - a.hits || a.km - b.km)
    .slice(0, limit);
  return {
    presentation: "map",
    center,
    matches: scored.map((s, i) => toMatch(s.p, center, 1 / (1 + i * 0.15 + s.km / 50), s.via)),
  };
}

/** The place table wire_query sees: one row per record of object "place", its fields as columns,
 *  plus `_entry_id`. Built from the sample data in a real SQLite, so the recommended
 *  render_places_map SQL runs here exactly as written. */
function placeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE place (_entry_id TEXT PRIMARY KEY, _source TEXT, name TEXT, lat REAL, lng REAL, address TEXT, locality TEXT, region TEXT, country TEXT)");
  const insert = db.prepare("INSERT INTO place VALUES (?, 'app:someday', ?, ?, ?, ?, ?, ?, ?)");
  for (const p of SAMPLE_PLACES) {
    const f = p.fields;
    insert.run(p.id, f.name, f.lat, f.lng, f.address, f.locality, f.region, f.country);
  }
  return db;
}

/** Someday's recommended render_places_map, as its manifest states it (see manifest-snippet.ts):
 *  wire_query with the ids bound as ONE JSON text param. A string[] can't be a wire_query param
 *  (params are scalars), and a whole-value `{{input.place_ids}}` keeps its array type, so the
 *  manifest embeds it in a string, which the engine fills with the array's JSON. */
//  Joined on json_each rather than `IN (...)` so the rows come back in the order the model passed
//  the ids (`ORDER BY ids.key`), and the pins are numbered the way the model lists them.
export const RENDER_SQL =
  "SELECT p._entry_id AS id, p.name, p.lat, p.lng, p.address, p.locality FROM json_each(?1, '$.ids') AS ids JOIN place AS p ON p._entry_id = ids.value ORDER BY ids.key";

function renderPlacesMap({ place_ids, title, center }) {
  // What the engine's template substitution produces for params: ['{"ids":{{input.place_ids}}}'].
  const params = [`{"ids":${JSON.stringify(place_ids)}}`];
  const stmt = placeDb().prepare(RENDER_SQL);
  stmt.setReturnArrays?.(true);
  const out = stmt.all(...params);
  const columns = stmt.columns().map((c) => c.name);
  const rows = out.map((r) => (Array.isArray(r) ? r : columns.map((c) => r[c])));
  // wire_query's result, mapped by the manifest's `result`: data for the model and the view...
  const data = { presentation: "map", columns, rows, rowCount: rows.length, truncated: false };
  // ...and `result._meta`, which Wire returns as the MCP result's `_meta.view`: the view reads it,
  // the model never does.
  const view = { ...(title ? { title } : {}), ...(center ? { center } : {}) };
  return { data, view };
}

async function buildServer() {
  const server = new McpServer({ name: "someday-dev", version: "0.0.0" });
  // Wire serves a view at a HASHED URI, ui://<app id>/<name>-<sha256(html)[0..8]> (usewire/wire#129),
  // so a host that caches views by URI never renders an old one after an upgrade.
  const html0 = await readFile(path.join(dist, "places-map.html"), "utf8");
  const RESOURCE_URI = `${RESOURCE_BASE}-${createHash("sha256").update(html0).digest("hex").slice(0, 8)}`;

  registerAppTool(
    server,
    "render_places_map",
    {
      title: "Show places on a map",
      description:
        "Show saved places on a map for the user. Pass the ids of places you already found (search_places, get_place); nothing is searched.",
      inputSchema: z.object({
        place_ids: z.array(z.string().min(1)).min(1).max(50).default(SAMPLE_PLACES.slice(0, 4).map((p) => p.id)),
        title: z.string().max(80).optional().describe('A short heading for the map, e.g. "Coffee near you".'),
        center: z.object({ lat: z.number(), lng: z.number() }).optional().describe("The point the places were found around, if any."),
      }),
      annotations: { title: "Show places on a map", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async (args) => {
      const { data, view } = renderPlacesMap(args);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
        ...(Object.keys(view).length ? { _meta: { view } } : {}),
      };
    },
  );

  registerAppTool(
    server,
    "search_places",
    {
      title: "Search places",
      description:
        'Find saved places near a point, optionally matching a query. Results carry presentation "map": pin each match (coordinates are at the end of its content) around center.',
      inputSchema: z.object({
        query: z.string().max(500).optional().describe("What to look for; also matched against the user's notes and visits. Omit to list the nearest saved places."),
        lat: z.number().min(-90).max(90).default(40.7359).describe("Latitude of the point to search around."),
        lng: z.number().min(-180).max(180).default(-73.9911).describe("Longitude of the point to search around."),
        radius_km: z.number().positive().max(20000).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async (args) => {
      const data = searchPlaces(args);
      // The Wire engine's tools/call shape: pretty JSON text plus the same object as structuredContent.
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
    },
  );

  registerAppResource(server, "Places map", RESOURCE_URI, { mimeType: RESOURCE_MIME_TYPE, description: "Saved places on an interactive map" }, async () => {
    const csp = JSON.parse(await readFile(path.join(dist, "csp.json"), "utf8"));
    return { contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html0, _meta: { ui: { csp } } }] };
  });

  return server;
}

const httpServer = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  if (!req.url?.startsWith("/mcp")) return void res.writeHead(404).end("not found");

  let body;
  if (req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
    } catch {
      return void res.writeHead(400).end("invalid JSON");
    }
  }
  // Stateless: a fresh server + transport per request, as in the ext-apps examples.
  const server = await buildServer();
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error("MCP error:", e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
  }
});

httpServer.listen(PORT, () => console.log(`someday-dev MCP server: http://localhost:${PORT}/mcp (search_places, render_places_map -> ${RESOURCE_BASE}-<hash>)`));
