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
// THE OTHER SHAPE, the data/render split (usewire/wire#129): a `render_places_map` tool over
// wire_query, whose result is `{ columns: [...], rows: [[...], ...], rowCount, truncated }` (rows
// are arrays, one value per column), optionally wrapped with `presentation`, plus view-only
// `_meta.view` ({ title?, center? }) the model never sees. Rows are zipped with `columns` into
// records and read exactly like matches (`id` or `_entry_id`, lat, lng, name, address, ...).
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
  /** The linked records this place was found through (wire_search `matchLinked`, usewire/wire#128),
   *  best first. Empty when it matched on its own. */
  matchedVia: MatchedVia[];
}

/** One entry of a match's `matchedVia`: a linked record (a note, a visit, an event) whose own
 *  match lifted this place into the results. */
export interface MatchedVia {
  id: string | null;
  /** The linked record's object ("note", "visit", "event"), when it is a record. */
  object: string | null;
  /** The link's type ("about", "visited", "held_at"). */
  type: string | null;
  content: string;
  fields: Record<string, unknown> | null;
}

export interface PlacesView {
  places: Place[];
  center: { lat: number; lng: number } | null;
  query: string | null;
  /** Matches that had no usable coordinates. */
  skipped: number;
  /** True when the result named `presentation: "map"`. */
  presentationMap: boolean;
  /** A heading the tool passed for the view only (`_meta.view.title`), if any. */
  title: string | null;
  /** The producer cut the rows short (wire_query's `truncated`). */
  truncated: boolean;
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
  const entryId = str(m.id) ?? str(m.entryId) ?? str(m.entry_id) ?? str(m._entry_id) ?? str(m.place_id) ?? str(place?.id);
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
    matchedVia: readMatchedVia(m.matchedVia),
  };
}

function readMatchedVia(raw: unknown): MatchedVia[] {
  if (!Array.isArray(raw)) return [];
  const out: MatchedVia[] = [];
  for (const v of raw) {
    if (!isObj(v)) continue;
    const fields = isObj(v.fields) ? v.fields : null;
    const content = str(v.content) ?? "";
    if (!content && !fields) continue;
    out.push({ id: str(v.id), object: str(v.object)?.toLowerCase() ?? null, type: str(v.type), content, fields });
  }
  return out;
}

const QUOTE_MAX = 90;
const quote = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return `“${t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX - 1).trimEnd()}…` : t}”`;
};

/** Why a place is in the results when it was found through a linked record, in words, for the
 *  first (best) `matchedVia` entry: "Matched your note: “best cortado in town”". `more` counts
 *  the rest. Null when the place matched on its own. Wording follows Someday's objects (note,
 *  visit, event) and falls back to the object or link type for anything else. */
export function matchReason(place: Place): { text: string; more: number } | null {
  const [first, ...rest] = place.matchedVia;
  if (!first) return null;
  const f = first.fields ?? {};
  const kind = first.object ?? first.type ?? "";
  let text: string;
  if (kind === "note" || first.type === "about") {
    // Someday writes a note's content as "Note on <place>: <text>"; the text field is the note itself.
    const body = str(f.text) ?? first.content.replace(/^Note on [^:]*:\s*/i, "");
    text = `Matched your note: ${quote(body)}`;
  } else if (kind === "visit" || first.type === "visited") {
    const on = str(f.visited_on);
    text = on ? `Matched your visit on ${on}` : `Matched your visit: ${quote(first.content)}`;
  } else if (kind === "event" || first.type === "held_at") {
    const title = str(f.title);
    const when = str(f.starts_at);
    text = title ? `Matched the event ${quote(title)}${when ? `, ${when.replace("T", " ")}` : ""}` : `Matched an event: ${quote(first.content)}`;
  } else {
    text = `Matched a linked ${kind || "record"}: ${quote(first.content)}`;
  }
  return { text, more: rest.length };
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

/** wire_query's rows are arrays, one value per `columns` entry; turn them into objects so a row
 *  reads like any other record. Rows that are already objects pass through. */
function rowObjects(rows: unknown[], columns: unknown): unknown[] {
  if (!Array.isArray(columns) || !columns.every((c) => typeof c === "string")) return rows;
  return rows.map((r) => (Array.isArray(r) ? Object.fromEntries((columns as string[]).map((c, i) => [c, r[i]])) : r));
}

/** The view-only data a Wire custom tool mapped under `result._meta` (usewire/wire#129): the MCP
 *  result's `_meta.view`, which the model never sees. */
function viewMetaOf(result: unknown): Obj | null {
  if (!isObj(result) || !isObj(result._meta)) return null;
  return isObj(result._meta.view) ? result._meta.view : null;
}

function readCenter(c: unknown): { lat: number; lng: number } | null {
  if (!isObj(c)) return null;
  const lat = num(c.lat ?? c.latitude);
  const lng = num(c.lng ?? c.lon ?? c.longitude);
  return validLat(lat) && validLng(lng) ? { lat, lng } : null;
}

export function readPlaces(result: unknown): PlacesView {
  const payload = payloadOf(result);
  const found = rowsOf(payload);
  const env = found.env;
  const rows = rowObjects(found.rows, env?.columns);
  const view = viewMetaOf(result);
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
  const top = isObj(payload) ? payload : null;
  return {
    places,
    center: readCenter(view?.center) ?? readCenter(env?.center),
    query: str(env?.query) ?? str(top?.query),
    skipped,
    presentationMap: (env?.presentation ?? top?.presentation) === "map",
    title: str(view?.title),
    truncated: env?.truncated === true || top?.truncated === true,
  };
}
