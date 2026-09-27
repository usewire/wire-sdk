/** Row cap. The agent's context is the real constraint, not the database. */
export declare const MAX_QUERY_ROWS = 200;
/** Response byte cap — a wide SELECT * can blow a context window well under the row cap. */
export declare const MAX_QUERY_BYTES = 256000;
/** Bound on bound values: a radius query needs three, a generous IN-list a few dozen. */
export declare const MAX_QUERY_PARAMS = 64;
/** Per-string bound. A bound value is a filter operand, not a payload. */
export declare const MAX_PARAM_STRING_BYTES = 4096;
export declare const QUERY_DESCRIPTION: string;
/** The tool's input schema — real JSON Schema, sent to MCP clients verbatim. */
export declare const QUERY_INPUT_SCHEMA: Record<string, unknown>;
