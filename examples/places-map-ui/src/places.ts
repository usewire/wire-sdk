// Reading places out of a tool result, defensively.
//
// THE SHAPE THIS IS BUILT FOR: Someday's `search_places` is a Wire custom tool over
// `wire_search` (object "place", `near` the given point). Its result is
//
//   { "presentation": "map", "center": { "lat", "lng" }, "matches": [ <wire_search match> ] }
//
// and a wire_search match (engine usewire/wire#126 and later) is
//
//   { id, score, content, source, distance_km?,
//     fields?: { lat, lng, name, address, locality, ... },   // declared-object records; coordinates
//     fields_truncated?: true,                               // first, trimmed to <= 4 KB
//     provenance: { tags?, ingestedAt?, ... }, _meta }
//
// `match.fields` is read FIRST, for everything (coordinates, name, address, area). Tags come from
// top-level `tags`, then `provenance.tags`. Then, for other producers: `object.fields`, `_fields`,
// `properties._fields`, a JSON object `content`, and top-level / nested `place` lat/lng (rows like
// whats_on's). Last resort, for engines before #126: the content text Someday's save_place writes,
//
//   "<name>\n<address>\n<area>\nlat <lat>, lng <lng>"
//
// A match without usable coordinates is skipped and counted, never placed at (0, 0).
//
// The result may arrive as `structuredContent` or as JSON in a text content block; both are
// read. Nothing here trusts a string to be HTML: every value is rendered as text by React.

export interface Place {
  /** Wire entry id when the match has one, else a positional key. */
  id: string;
  entryId: string | null;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  /** City / region / country, or the content's area line. */
  area: string | null;
  tags: string[];
  distanceKm: number | null;
}

export interface PlacesView {
  places: Place[];
  center: { lat: number; lng: number } | null;
  query: string | null;
  /** Matches that had no usable coordinates. */
  skipped: number;
  /** True when the result named `presentation: "map"`. */
  presentationMap: boolean;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter((s): s is string => !!s);
  const s = str(v);
  return s ? s.split(",").map((t) => t.trim()).filter(Boolean) : [];
}

const validLat = (n: number | null): n is number => n !== null && n >= -90 && n <= 90;
const validLng = (n: number | null): n is number => n !== null && n >= -180 && n <= 180;

function parseJsonObject(text: string): Obj | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v: unknown = JSON.parse(t);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** The `lat X, lng Y` line Someday ends a place's content with (the last one wins). */
const COORD_LINE = /\blat(?:itude)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)\s*[,;]?\s*(?:lng|lon|long|longitude)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/gi;

function coordsFromText(text: string): { lat: number; lng: number } | null {
  let found: { lat: number; lng: number } | null = null;
  for (const m of text.matchAll(COORD_LINE)) {
    const lat = num(m[1]);
    const lng = num(m[2]);
    if (validLat(lat) && validLng(lng)) found = { lat, lng };
  }
  return found;
}

const isCoordLine = (line: string) => new RegExp(COORD_LINE.source, "i").test(line);

function firstOf(sources: Obj[], keys: string[]): unknown {
  for (const s of sources) for (const k of keys) if (s[k] !== undefined && s[k] !== null && s[k] !== "") return s[k];
  return undefined;
}

/** Read one match (or one row) into a Place, or null when it has no usable coordinates. */
export function readPlace(raw: unknown, index: number): Place | null {
  if (!isObj(raw)) return null;
  const m = raw;
  const content = typeof m.content === "string" ? m.content : null;
  const contentObj = content ? parseJsonObject(content) : isObj(m.content) ? m.content : null;
  const props = isObj(m.properties) ? m.properties : null;
  const object = isObj(m.object) ? m.object : null;
  const provenance = isObj(m.provenance) ? m.provenance : null;
  const place = isObj(m.place) ? m.place : null;

  // Every place a producer might have put the record's fields, most specific first.
  const sources: Obj[] = [
    isObj(m.fields) ? m.fields : null,
    object && isObj(object.fields) ? object.fields : null,
    isObj(m._fields) ? m._fields : null,
    props && isObj(props._fields) ? props._fields : null,
    contentObj && isObj(contentObj.fields) ? contentObj.fields : null,
    contentObj,
    place,
    m,
  ].filter((s): s is Obj => !!s);

  // The coordinate PAIR comes from one source (never lat from one and lng from another), the
  // first that has both; `match.fields` is first.
  let coords: { lat: number; lng: number } | null = null;
  for (const s of sources) {
    const lat = num(firstOf([s], ["lat", "latitude"]));
    const lng = num(firstOf([s], ["lng", "lon", "long", "longitude"]));
    if (validLat(lat) && validLng(lng)) {
      coords = { lat, lng };
      break;
    }
  }
  // Last resort (engines before usewire/wire#126, whose matches carry no fields): scrape the
  // content Someday's save_place writes. Only then are its lines read for name / address / area.
  const scraped = !coords && content ? coordsFromText(content) : null;
  if (!coords && !scraped) return null;
  const { lat, lng } = (coords ?? scraped)!;
  const lines = scraped && !contentObj ? content!.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !isCoordLine(l)) : [];

  const name = str(firstOf(sources, ["name", "title", "place_name"])) ?? lines[0] ?? "Unnamed place";
  const address = str(firstOf(sources, ["address", "formatted_address"])) ?? (lines[1] && lines[1] !== name ? lines[1] : null);
  const areaParts = ["locality", "region", "country"].map((k) => str(firstOf(sources, [k]))).filter((s): s is string => !!s);
  const area = areaParts.length ? [...new Set(areaParts)].join(", ") : (lines[2] ?? null);

  const tagSource = m.tags ?? provenance?.tags ?? firstOf(sources.filter((s) => s !== m), ["tags"]);
  const entryId = str(m.id) ?? str(m.entryId) ?? str(m.entry_id) ?? str(m.place_id) ?? str(place?.id);
  const distanceKm = num(m.distance_km ?? m.distanceKm);

  return {
    id: entryId ?? `place-${index}`,
    entryId,
    name,
    lat,
    lng,
    address,
    area: area && area !== address ? area : null,
    tags: [...new Set(strList(tagSource))],
    distanceKm: distanceKm !== null && distanceKm >= 0 ? distanceKm : null,
  };
}

/** The payload object of a tool result: structuredContent, else the first text block that
 *  parses as JSON. Accepts a bare payload too (for tests and tool input). */
export function payloadOf(result: unknown): unknown {
  if (!isObj(result)) return result;
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (isObj(block) && block.type === "text" && typeof block.text === "string") {
        try {
          return JSON.parse(block.text);
        } catch {
          /* not JSON; try the next block */
        }
      }
    }
    return null;
  }
  return result;
}

/** Find the list of matches / rows inside a payload, unwrapping the envelopes producers use. */
function rowsOf(payload: unknown): { rows: unknown[]; env: Obj | null } {
  if (Array.isArray(payload)) return { rows: payload, env: null };
  if (!isObj(payload)) return { rows: [], env: null };
  for (const key of ["matches", "places", "results", "rows", "items", "events"]) {
    const v = payload[key];
    if (Array.isArray(v)) return { rows: v, env: payload };
  }
  for (const key of ["data", "result", "structuredContent"]) {
    const inner = payload[key];
    if (isObj(inner) || Array.isArray(inner)) {
      const found = rowsOf(inner);
      if (found.rows.length) return { rows: found.rows, env: found.env ?? payload };
    }
  }
  return { rows: [], env: payload };
}

export function readPlaces(result: unknown): PlacesView {
  const payload = payloadOf(result);
  const { rows, env } = rowsOf(payload);
  const places: Place[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  rows.forEach((row, i) => {
    const p = readPlace(row, i);
    if (!p) {
      skipped++;
      return;
    }
    if (seen.has(p.id)) p.id = `${p.id}-${i}`;
    seen.add(p.id);
    places.push(p);
  });
  const c = env && isObj(env.center) ? env.center : null;
  const cLat = c ? num(c.lat ?? c.latitude) : null;
  const cLng = c ? num(c.lng ?? c.lon ?? c.longitude) : null;
  const top = isObj(payload) ? payload : null;
  return {
    places,
    center: validLat(cLat) && validLng(cLng) ? { lat: cLat, lng: cLng } : null,
    query: str(env?.query) ?? str(top?.query),
    skipped,
    presentationMap: (env?.presentation ?? top?.presentation) === "map",
  };
}
