// A local stand-in for Someday on Wire, for testing the places map in an MCP Apps host (e.g. the
// ext-apps basic-host). It exposes one tool, `search_places`, that answers the way Someday's
// custom tool does on a Wire container (a `wire_search` over object "place", wrapped as
// { presentation: "map", center, matches }, returned as text JSON AND structuredContent like the
// engine's tools/call), and serves dist/places-map.html as ui://someday/places-map with the CSP
// from dist/csp.json.
//
//   npm run build && npm run dev:server        # http://localhost:3001/mcp  (PORT to change)

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { SAMPLE_PLACES } from "./sample-places.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");
const PORT = Number(process.env.PORT ?? 3001);
// Wire serves an app's UI at ui://<app id>/<name> (the engine's uiUri).
const RESOURCE_URI = "ui://someday/places-map";

const toRad = (d) => (d * Math.PI) / 180;
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

/** What wire_search returns for one place record: the engine's match shape, verbatim. The record's
 *  fields are NOT on the match; content is what Someday's save_place wrote. */
function toMatch(p, center, score) {
  const distance = haversineKm(center, p.fields);
  return {
    id: p.id,
    score: Number(score.toFixed(4)),
    content: `${p.fields.name}\n${p.fields.address}\n${[p.fields.locality, p.fields.region, p.fields.country].join(", ")}\nlat ${p.fields.lat}, lng ${p.fields.lng}`,
    source: "someday",
    distance_km: Number(distance.toFixed(3)),
    provenance: { source: "someday", ingestedAt: p.ingestedAt, tags: p.tags, contentType: "text/plain" },
    _meta: { wire: { navigate: { entryId: p.id, relationships: 0 } } },
  };
}

function searchPlaces({ query, lat, lng, radius_km, limit = 10 }) {
  const center = { lat, lng };
  const q = (query ?? "").trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const scored = SAMPLE_PLACES.map((p) => {
    const hay = `${p.fields.name} ${p.fields.address} ${p.tags.join(" ")}`.toLowerCase();
    const hits = terms.filter((t) => hay.includes(t)).length;
    return { p, hits, km: haversineKm(center, p.fields) };
  })
    .filter((s) => (terms.length ? s.hits > 0 : true))
    .filter((s) => (radius_km ? s.km <= radius_km : true))
    .sort((a, b) => b.hits - a.hits || a.km - b.km)
    .slice(0, limit);
  return {
    presentation: "map",
    center,
    matches: scored.map((s, i) => toMatch(s.p, center, 1 / (1 + i * 0.15 + s.km / 50))),
  };
}

function buildServer() {
  const server = new McpServer({ name: "someday-dev", version: "0.0.0" });

  registerAppTool(
    server,
    "search_places",
    {
      title: "Search places",
      description:
        'Find saved places near a point, optionally matching a query. Results carry presentation "map": pin each match (coordinates are at the end of its content) around center.',
      inputSchema: z.object({
        query: z.string().max(500).optional().describe("What to look for. Omit to list the nearest saved places."),
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
    // Read on every request so a rebuild shows up without restarting.
    const [html, csp] = await Promise.all([
      readFile(path.join(dist, "places-map.html"), "utf8"),
      readFile(path.join(dist, "csp.json"), "utf8").then(JSON.parse),
    ]);
    return { contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: { csp } } }] };
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
  const server = buildServer();
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

httpServer.listen(PORT, () => console.log(`someday-dev MCP server: http://localhost:${PORT}/mcp (search_places -> ${RESOURCE_URI})`));
