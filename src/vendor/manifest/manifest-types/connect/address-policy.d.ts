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
