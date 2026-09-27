import type { ToolDef } from "../tools/tool-def.js";
import { type BaseToolLookup, type CustomToolDataFlow, type CustomToolDefinition, type ToolCapability, type ValidationError } from "../tools/custom.js";
import { type GeoFields } from "../geo-fields.js";
export declare const MANIFEST_FORMAT_VERSION = 1;
export declare const MANIFEST_MAX_BYTES: number;
export declare const APP_NAME_MAX = 200;
export declare const APP_VERSION_RE: RegExp;
export declare const MAX_MANIFEST_OBJECTS = 50;
export declare const MAX_MANIFEST_FIELDS_PER_OBJECT = 500;
export declare const MAX_MANIFEST_ACTIONS = 32;
export declare const MAX_MANIFEST_TOOLS = 100;
export declare const MAX_MANIFEST_BASE_TOOLS = 32;
export declare const INSTRUCTIONS_MAX = 16000;
export declare const SKILL_MAX = 64000;
export declare const ACTION_NAME_RE: RegExp;
export declare const ACTION_NAME_MAX = 64;
export declare const ACTION_DESCRIPTION_MAX = 2000;
export declare const ACTION_URL_MAX = 2048;
/** An action's timeout ceiling, and its default. */
export declare const ACTION_TIMEOUT_MAX_MS = 8000;
/** Largest action response the container reads. */
export declare const ACTION_RESPONSE_MAX_BYTES: number;
/** Largest body the container sends an action. A mapping that would send more (a whole base
 *  result passed through, say) fails the call rather than shipping it. */
export declare const ACTION_REQUEST_MAX_BYTES: number;
/** Field names in a declared object: identifier-ish; the `_` namespace is the system's. */
export declare const FIELD_NAME_RE: RegExp;
export declare const FIELD_TYPES: readonly ["text", "number", "integer", "boolean", "date", "json"];
export type ManifestFieldType = (typeof FIELD_TYPES)[number];
/** App ids that can never be taken. */
export declare const RESERVED_APP_IDS: Set<string>;
export interface ManifestObjectField {
    name: string;
    type: ManifestFieldType;
    label?: string;
}
export interface ManifestObject {
    name: string;
    label?: string;
    /** Always "declared": an app's objects are pinned profiles. Optional in the document. */
    mode: "declared";
    geo?: GeoFields;
    fields: ManifestObjectField[];
}
export interface ManifestAction {
    name: string;
    /** What the action does and what it receives, in plain words. Required: it is consent copy. */
    description: string;
    /** https only. The container calls exactly this URL. */
    url: string;
    method: "POST";
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    /** Defaults to, and may not exceed, ACTION_TIMEOUT_MAX_MS. */
    timeout_ms: number;
}
/** Which transports an app tool is on after install (SUP-954). Each defaults to true. */
export interface ManifestToolTransports {
    mcp?: boolean;
    rest?: boolean;
}
/** A tool as the manifest carries it: a custom tool definition, plus the install policy for its
 *  visibility (SUP-954). `enabled` and `transports` are present in the normalized manifest only
 *  when the document gave them, and are never part of the stored definition. */
export type ManifestTool = CustomToolDefinition & {
    /** Is the tool on after install? Default true. */
    enabled?: boolean;
    /** On which transports. Each defaults to true. */
    transports?: ManifestToolTransports;
};
/** The analysis graphs an app needs (SUP-954). Each defaults to false. */
export interface ManifestAnalysis {
    /** The provenance graph (corroborates / elaborates / supersedes / contradicts). */
    provenance?: boolean;
    /** The entity graph (canonical entities, mentions, related_via). */
    entity?: boolean;
}
/** `analysis`, normalized: both keys, booleans. What apply returns as `requestedAnalysis`. */
export interface RequestedAnalysis {
    provenance: boolean;
    entity: boolean;
}
/** An app tool's visibility, as the tools table holds it. */
export interface ToolVisibility {
    enabled: boolean;
    mcpEnabled: boolean;
    restEnabled: boolean;
}
/** A built-in tool's visibility as a manifest states it (SUP-957): the same shape as an app
 *  tool's install policy, with the same defaults (on, both transports). */
export interface ManifestBuiltinTool {
    enabled?: boolean;
    transports?: ManifestToolTransports;
}
export type ToolTransport = "mcp" | "rest";
/** What an install does to one built-in tool (SUP-957), for a consent screen. */
export interface ValidatedBuiltinTool {
    name: string;
    /** Did the manifest name this built-in? One it leaves out gets its engine default. */
    stated: boolean;
    /** What the built-in reaches, in the same vocabulary as an app tool's capabilities. */
    capabilities: ToolCapability[];
    /** The visibility an install sets: the manifest's, defaults filled, or the engine default. */
    visibility: ToolVisibility;
    /** The engine default: what a container that no app manages has. */
    defaultVisibility: ToolVisibility;
    /** Transports the built-in is listed on by default and not after install. */
    hides: ToolTransport[];
    /** Transports the built-in is not listed on by default and is after install. */
    shows: ToolTransport[];
}
export interface ConnectManifest {
    manifest: typeof MANIFEST_FORMAT_VERSION;
    app: {
        id: string;
        name: string;
        version: string;
    };
    objects: ManifestObject[];
    actions: ManifestAction[];
    tools: ManifestTool[];
    base_tools: string[];
    builtin_tools?: Record<string, ManifestBuiltinTool>;
    analysis?: ManifestAnalysis;
    instructions?: string;
    skill?: string;
}
/** One validated tool, with what the validator derived about it. */
export interface ValidatedManifestTool {
    /** The definition as stored: without `enabled` / `transports`. */
    definition: CustomToolDefinition;
    baseTool: string;
    mutates: boolean;
    dataFlow: CustomToolDataFlow;
    /** What the tool uses, for consent copy (see TOOL_CAPABILITIES in tools/custom.ts). */
    capabilities: ToolCapability[];
    /** The visibility the manifest asks for, defaults filled (SUP-954). */
    visibility: ToolVisibility;
}
/** A manifest's `analysis`, with both keys filled (absent = false). */
export declare function requestedAnalysis(m: Pick<ConnectManifest, "analysis"> | null | undefined): RequestedAnalysis;
/** A manifest tool's requested visibility, defaults filled: on, on both transports. */
export declare function manifestToolVisibility(t: Pick<ManifestTool, "enabled" | "transports">): ToolVisibility;
/** The built-in tools a manifest manages (SUP-957): every tool the engine itself defines. Tools a
 *  host registers on top are not a manifest's to set. */
export declare const MANIFEST_BUILTIN_TOOL_NAMES: readonly string[];
/** A built-in's engine default visibility: on, on the transports its definition lists it on. */
export declare function builtinDefaultVisibility(name: string): ToolVisibility | null;
/** The transports a visibility lists a tool on. */
export declare function listedOn(v: ToolVisibility): ToolTransport[];
/** What going from one visibility to another does, per transport: listed before and not after
 *  (`hides`), or the other way round (`shows`). A consent screen can compare against the
 *  container's current visibility with this, not only against the engine default. */
export declare function visibilityChange(from: ToolVisibility, to: ToolVisibility): {
    hides: ToolTransport[];
    shows: ToolTransport[];
};
/** Every built-in's visibility under a manifest (SUP-957): the manifest's where it names the
 *  built-in (defaults filled as for an app tool), the engine default where it does not. In the
 *  engine's order. `null` (no managing manifest) gives every engine default. */
export declare function manifestBuiltinVisibility(m: Pick<ConnectManifest, "builtin_tools"> | null | undefined): Array<{
    name: string;
    stated: boolean;
    visibility: ToolVisibility;
}>;
export type ManifestValidation = {
    ok: true;
    manifest: ConnectManifest;
    tools: ValidatedManifestTool[];
    builtinTools: ValidatedBuiltinTool[];
} | {
    ok: false;
    errors: ValidationError[];
};
/** The base tools every Wire container registers, as a lookup. The default for validation away
 *  from a container; a container validates against the tools its host actually registers. */
export declare function builtinToolLookup(extra?: ToolDef[]): BaseToolLookup;
/** Why an action URL is refused, or null. https only; no credentials, no fragment; not a
 *  loopback / private / link-local literal address or a `localhost` name. (Names that RESOLVE to
 *  such addresses are refused by the container at call time.) */
export declare function actionUrlProblem(raw: unknown): string | null;
/** Deterministic JSON: object keys sorted at every level. What a manifest hash is computed over. */
export declare function canonicalJson(v: unknown): string;
/** The manifest hash: lowercase hex SHA-256 of `canonicalJson(manifest)` (of the NORMALIZED
 *  manifest `validateManifest` returns). WebCrypto, so it runs anywhere. */
export declare function manifestSha256(manifest: ConnectManifest): Promise<string>;
/** Validate a Connect manifest. Returns the normalized manifest (defaults filled: empty arrays,
 *  `mode: "declared"`, `method: "POST"`, `timeout_ms`) and each tool's derived facts, or every
 *  error found, each naming its path (`actions.0.url`, `tools.2.tool.args.limit`). Never throws.
 *
 *  `lookup` is the base tool registry to check tool mappings against; by default, the tools every
 *  Wire container registers. */
export declare function validateManifest(raw: unknown, lookup?: BaseToolLookup): ManifestValidation;
/** What an install of this manifest does to each built-in tool (SUP-957), in the engine's order:
 *  every built-in, since an install sets them all. `hides` / `shows` compare with the engine
 *  default; compare with a container's current visibility with `visibilityChange`. */
export declare function validatedBuiltinTools(m: Pick<ConnectManifest, "builtin_tools">): ValidatedBuiltinTool[];
