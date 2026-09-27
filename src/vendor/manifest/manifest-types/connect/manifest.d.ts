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
export type ManifestValidation = {
    ok: true;
    manifest: ConnectManifest;
    tools: ValidatedManifestTool[];
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
