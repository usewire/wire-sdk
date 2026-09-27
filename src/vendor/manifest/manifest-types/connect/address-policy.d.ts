/** Parse a dotted-quad IPv4 address. Strict: four decimal octets, no leading zeros beyond "0". */
export declare function parseIPv4(s: string): number[] | null;
/** Parse an IPv6 address (no zone id) into eight 16-bit groups. Accepts `::` compression and a
 *  trailing dotted quad. Null when it is not one. */
export declare function parseIPv6(s: string): number[] | null;
/** Why an address may not be reached by an action call, or null when it may (public unicast).
 *  Accepts an IPv4 dotted quad or an IPv6 address, with or without [brackets]. Anything that is
 *  not an address at all is refused. */
export declare function addressProblem(address: string): string | null;
/** Is this string an IP literal (so it names an address, not a hostname)? */
export declare function isIpLiteral(host: string): boolean;
/** Refused on every host, whatever is configured. */
export declare const ALWAYS_DENIED_HOSTS: readonly string[];
/** A hostname in its comparable form: lowercase, no trailing dot, no IPv6 brackets. */
export declare function normalizeHost(host: string): string;
/** Parse a deny-list: comma- or whitespace-separated entries, normalized, empties dropped. */
export declare function parseDenyHosts(raw: string | readonly string[] | undefined | null): string[];
/** The deny-list entry that refuses this host, or null. Always includes ALWAYS_DENIED_HOSTS. */
export declare function deniedHostEntry(host: string, denyHosts?: readonly string[]): string | null;
