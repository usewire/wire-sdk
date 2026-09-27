/**
 * Names an object can never take: the query view names plus anything
 * leading-underscore (the system namespace — `_composite`, `_instance`, …).
 * Compared case-insensitively.
 */
export declare const RESERVED_OBJECT_NAMES: Set<string>;
/** Identifier-ish rule — an object name has to survive being a column/table label. */
export declare const OBJECT_NAME_RE: RegExp;
export declare const MAX_OBJECT_NAME_LENGTH = 80;
/** Validate a caller-declared object name. Returns an error message, or null when valid. */
export declare function validateObjectName(name: unknown): string | null;
