/** Field names the profiler reads as a latitude / longitude when it has to infer the pair.
 *  Deliberately a closed list: a profile that calls `y` a latitude on a guess would put a whole
 *  object on a map it doesn't belong on. A source that knows better declares the pair. */
export declare const LAT_FIELD_RE: RegExp;
export declare const LNG_FIELD_RE: RegExp;
export interface GeoFields {
    /** The `_fields` key holding latitude. */
    lat: string;
    /** The `_fields` key holding longitude. */
    lng: string;
}
/** Read a `geo` marker off an untrusted profile blob. Null unless both names are safe identifiers
 *  and distinct — a profile is caller-reachable data (a declared profile is whatever its writer
 *  sent), so nothing reads `geo` without coming through here. */
export declare function validGeoFields(v: unknown): GeoFields | null;
