import { type ToolAnnotations, type ToolDef } from "./tool-def.js";
/** Name rule: the object-name rule (identifier-ish, starts with a letter), capped at 64 — the
 *  longest tool name every major model API accepts. */
export declare const CUSTOM_TOOL_NAME_RE: RegExp;
export declare const CUSTOM_TOOL_NAME_MAX = 64;
export declare const CUSTOM_TOOL_DESCRIPTION_MAX = 8000;
/** Serialized definition ceiling. A definition is configuration, not content. */
export declare const CUSTOM_TOOL_DEFINITION_MAX_BYTES: number;
/** Per-container cardinality guard — a tool list is read by a model on every session. */
export declare const MAX_CUSTOM_TOOLS_PER_CONTAINER = 100;
/** Substitutions per definition (args + result). Bounds the fan-out of one caller value. */
export declare const MAX_SUBSTITUTIONS = 128;
/** Nesting depth for schemas and templates. */
export declare const MAX_DEPTH = 16;
/** Ceiling on the characters one call's substitution may produce (args, then result). A template
 *  that embeds one caller value many times would otherwise multiply a large input. */
export declare const SUBSTITUTION_OUTPUT_MAX_CHARS: number;
/** Serialized size ceiling on one call's caller arguments. Checking them is synchronous work on the
 *  container's loop, and a custom tool may be callable by viewers — so the input is bounded before
 *  a byte of it is validated. Generous for a note or a document passed through to wire_write. */
export declare const CALLER_ARGS_MAX_BYTES: number;
/** Work budget for checking one call's arguments: (value, schema) visits plus enum comparisons.
 *  Validation is schema-branches x input-items; this bounds the product, not either factor. */
export declare const VALIDATION_WORK_BUDGET = 200000;
/** Errors reported for one call — the first few name the problem; a thousand add nothing. */
export declare const MAX_REPORTED_ERRORS = 20;
/** Per-keyword breadth caps at save, so a definition cannot make each visit expensive. */
export declare const MAX_ENUM_VALUES = 1000;
export declare const MAX_SCHEMA_BRANCHES = 32;
/** The installer of everything an owner defines directly. Identity is (installer, name). */
export declare const OWNER_INSTALLER = "owner";
/** App installers are `app:<app id>` (SUP-946). */
export declare const APP_INSTALLER_PREFIX = "app:";
/** Connect app ids: identifier-ish and lowercase, because an app id becomes a tool-name prefix
 *  (`<appid>_<name>`) and a source label (`app:<appid>`). */
export declare const APP_ID_RE: RegExp;
export declare const APP_ID_MAX = 32;
export declare function appInstaller(appId: string): string;
/** The app id an installer names, or null for the owner (or anything that is not an app installer). */
export declare function installerAppId(installer: string): string | null;
/** The `source` label an app's records carry — and the key its declared object profiles live
 *  under. The same string as the installer id, on purpose: one name for "belongs to this app". */
export declare const appSourceLabel: (appId: string) => string;
/** The base-tool argument the container fills for an app tool (with the app's source label), and
 *  that an app's mapping may therefore not set. */
export declare const APP_SOURCE_ARG = "source";
/** The name an app tool is exposed under where a plain name would collide: `<appid>_<name>`. */
export declare const qualifiedToolName: (appId: string, name: string) => string;
/** One action step: which of the installer's actions to call, and the template its body is built
 *  from. The action receives exactly what `args` builds. */
export interface ActionStep {
    action: string;
    args: Record<string, unknown>;
}
export interface CustomToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    tool: {
        name: string;
        args: Record<string, unknown>;
    };
    /** Optional result mapping (a JSON object template). Absent = the base result, unchanged. A
     *  top-level `_meta` key maps VIEW-ONLY data (SUP-953): see VIEW_META_KEY. */
    result?: Record<string, unknown>;
    /** Optional JSON Schema of the tool's result data (SUP-953), checked on every call. Absent: the
     *  base tool's, when the tool passes the base result through unchanged (customToolOutputSchema). */
    outputSchema?: Record<string, unknown>;
    /** App tools only (SUP-946): an action run before the base tool. Its output is `{{before.x}}`. */
    before?: ActionStep;
    /** App tools only (SUP-946): an action run after the base tool. Its output is `{{after.x}}`. */
    after?: ActionStep;
}
/** What validation needs to know about one of the installer's actions: its declared schemas. */
export interface ActionSchemas {
    input: Record<string, unknown>;
    output: Record<string, unknown>;
}
export interface CustomToolValidationOptions {
    /** Who is installing the definition: `owner` (the default) or `app:<id>`. Only an app installer
     *  may use `before` / `after`, and only with its own actions. */
    installer?: string;
    /** The installer's actions, by name. */
    actions?: (name: string) => ActionSchemas | undefined;
}
/** One action's place in a tool's data flow, derived from the mapping (never declared). */
export interface ActionDataFlow {
    phase: "before" | "after";
    action: string;
    /** Every value the action's body is built from, as substitution paths: `input.address`,
     *  `tool.entryId`, `before.lat`. The action receives these and nothing else. */
    receives: string[];
    /** The caller inputs among them (`input.*`). */
    receivesInput: string[];
    /** Base tool output reaches the action (`{{tool.x}}` in an after action's args): data read out
     *  of the container leaves it. Always false for a before action. */
    receivesBaseOutput: boolean;
    /** Where the action's output goes. */
    outputTo: {
        /** Into the base tool's arguments. */
        baseArgs: boolean;
        /** Into the base tool's arguments AND the base tool writes: the action shapes stored data. */
        write: boolean;
        /** Into the result the agent sees. */
        result: boolean;
        /** Into the after action's body (before actions only). */
        afterAction: boolean;
    };
}
/** A tool's computed data flow. Empty `actions` for a tool with no before/after. */
export interface CustomToolDataFlow {
    actions: ActionDataFlow[];
}
export interface ValidationError {
    /** Where in the definition, dotted: `tool.args.content`, `inputSchema.properties.limit`, `name`. */
    path: string;
    message: string;
}
/** What validation needs to know about the world: the base registry and the custom names. */
export interface BaseToolLookup {
    /** A base (registry) tool by full name, or undefined. */
    base(name: string): ToolDef | undefined;
    /** Is `name` a custom tool in this container? */
    isCustom(name: string): boolean;
}
/** Validate a value against a schema from the supported subset. Errors carry `path` rooted at the
 *  caller's own name for the value (e.g. `input.near.lat`), at most MAX_REPORTED_ERRORS of them.
 *  Bounded work: past VALIDATION_WORK_BUDGET the value is refused as too complex rather than
 *  checked for as long as it takes. Assumes the schema passed checkSchema. */
export declare function validateValue(value: unknown, schema: unknown, path: string): ValidationError[];
/** Fill schema `default`s into a copy of `value` wherever a property is absent. Recurses into
 *  present object properties; never invents a parent object to hold a default. */
export declare function applyDefaults(value: unknown, schema: unknown, depth?: number): unknown;
/** A base argument that is CODE, not data, takes only a fixed value — a caller's text spliced into
 *  it would be injection, and the custom tool would hand the caller exactly the open-ended power
 *  its owner meant to fix. A base tool marks such an argument `"x-wire-literal": true` in its input
 *  schema; a top-level argument named `sql` is treated the same way whether marked or not (belt and
 *  braces for query tools, whose caller values travel as bound parameters, never in the statement). */
export declare const LITERAL_ARG_KEYWORD = "x-wire-literal";
/** Validate a custom tool definition. Returns the normalized definition and its computed data flow,
 *  or every error found (each naming its path). Never throws on bad input.
 *
 *  `opts.installer` is who installs it: `owner` (the default — the SUP-945 admin API) or
 *  `app:<id>`. Only an app installer may use `before` / `after`, only with its own actions
 *  (`opts.actions`), and an app tool may not set its base tool's `source` argument: the container
 *  labels an app's records with the app's source itself. */
export declare function validateCustomToolDefinition(raw: unknown, lookup: BaseToolLookup, opts?: CustomToolValidationOptions): {
    ok: true;
    definition: CustomToolDefinition;
    baseTool: ToolDef;
    dataFlow: CustomToolDataFlow;
} | {
    ok: false;
    errors: ValidationError[];
};
/** The top-level `result` key whose mapped object is VIEW-ONLY data: it goes to the MCP result's
 *  `_meta.view` (an MCP Apps host hands the whole result, `_meta` included, to the tool's view)
 *  and never into `structuredContent` or `content`, so the model never reads it. */
export declare const VIEW_META_KEY = "_meta";
/** A manifest's annotation overrides for one tool (SUP-953): any of the three hints, and a title. */
export type ToolAnnotationsOverride = Partial<ToolAnnotations>;
/** A custom tool's annotations: its base tool's; open-world when it calls an app's action (an
 *  HTTPS service outside the container); then the manifest's overrides, if any. */
export declare function customToolAnnotations(base: Pick<ToolDef, "annotations" | "mutates">, def: Pick<CustomToolDefinition, "before" | "after">, override?: ToolAnnotationsOverride): ToolAnnotations;
/** The output schema a custom tool declares: its own; else its base tool's when it hands the base
 *  result back unchanged (no `result` mapping, no action); else none. */
export declare function customToolOutputSchema(base: Pick<ToolDef, "outputSchema">, def: Pick<CustomToolDefinition, "outputSchema" | "result" | "before" | "after">): Record<string, unknown> | undefined;
/** Split a mapped result into what the caller (and the model) sees and the view-only `_meta`. */
export declare function splitViewMeta(data: unknown): {
    data: unknown;
    view?: Record<string, unknown>;
};
/** What a custom tool USES, as a closed vocabulary a consent screen can put in plain words
 *  (SUP-954). Derived from the base tool and the computed data flow, never declared by the author,
 *  so a manifest cannot understate it.
 *
 *    read            reads the container's records (wire_explore, wire_navigate, wire_search, ...)
 *    sql_read        runs read-only SQL over the container's structured records (wire_query)
 *    export          reads every entry in bulk (wire_export)
 *    write           creates or changes records (any base tool that mutates)
 *    delete          deletes records (wire_delete; always with `write`)
 *    app_call        calls one of the app's actions: data named by the mapping leaves the container
 *    app_sets_args   an action's output becomes the base tool's arguments: the app decides part of
 *                    what is written, deleted, or queried
 *    records_to_app  base tool output (container data) reaches an after action
 *
 *  A base tool this module does not name is `write` if it mutates, else `read`. The list is in
 *  TOOL_CAPABILITIES order, so equal tools always produce equal lists. `def` (optional) is the
 *  definition the flow was computed from: a tool with a `before` / `after` step is `app_call` even
 *  when its stored flow is missing, so a lost flow can never understate it. */
export declare const TOOL_CAPABILITIES: readonly ["read", "sql_read", "export", "write", "delete", "app_call", "app_sets_args", "records_to_app"];
export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];
export declare function toolCapabilities(base: Pick<ToolDef, "name" | "mutates">, dataFlow: CustomToolDataFlow | null | undefined, def?: Pick<CustomToolDefinition, "before" | "after">): ToolCapability[];
/** Check a JSON Schema against the supported subset (the keywords this module enforces). The
 *  manifest validator uses it for action input and output schemas, which are enforced at call
 *  time by the same `validateValue`. */
export declare function checkSchemaSubset(schema: unknown, path: string): ValidationError[];
/** Validate caller arguments against the custom tool's input schema (defaults already applied).
 *  Paths are rooted at `input`, the name the caller's values go by in the mapping. */
export declare function checkCallerArgs(args: Record<string, unknown>, inputSchema: Record<string, unknown>): ValidationError[];
export declare class SubstitutionLimitError extends Error {
}
/** The values substitution reads: the caller's (defaulted) input, and — where they exist at that
 *  point of the call — the base result (`tool`) and the before / after actions' outputs. A source
 *  that is absent resolves every reference to nothing. */
export interface SubstitutionSources {
    input: unknown;
    tool?: unknown;
    before?: unknown;
    after?: unknown;
}
/** Build a value from a template. `sources` holds `input` and, for result mapping, `tool`. A
 *  whole-value substitution that resolves to nothing returns MISSING, which the containing object
 *  or array drops. One pass: substituted values are never re-scanned. */
export declare function substitute(template: unknown, sources: SubstitutionSources, budget?: {
    left: number;
}): unknown;
