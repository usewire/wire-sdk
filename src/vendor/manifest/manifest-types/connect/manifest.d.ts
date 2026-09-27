import type { ToolDef } from "../tools/tool-def.js";
import { type BaseToolLookup, type CustomToolDataFlow, type CustomToolDefinition, type ValidationError } from "../tools/custom.js";
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
export interface ConnectManifest {
    manifest: typeof MANIFEST_FORMAT_VERSION;
    app: {
        id: string;
        name: string;
        version: string;
    };
    objects: ManifestObject[];
    actions: ManifestAction[];
    tools: CustomToolDefinition[];
    base_tools: string[];
    instructions?: string;
    skill?: string;
}
/** One validated tool, with what the validator derived about it. */
export interface ValidatedManifestTool {
    definition: CustomToolDefinition;
    baseTool: string;
    mutates: boolean;
    dataFlow: CustomToolDataFlow;
}
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
