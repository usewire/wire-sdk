import type { ToolAnnotations, ToolDef } from "../tools/tool-def.js";
import { type BaseToolLookup, type CustomToolDataFlow, type CustomToolDefinition, type ToolAnnotationsOverride, type ToolCapability, type ValidationError } from "../tools/custom.js";
import { type GeoFields } from "../geo-fields.js";
import { type ManifestToolUi, type UiResource, type UiVisibility } from "./ui.js";
export declare const MANIFEST_FORMAT_VERSION = 1;
/** The manifest without its UI resources' `html`, as JSON bytes: every other field's budget. */
export declare const MANIFEST_MAX_BYTES: number;
/** The whole manifest, UI included, as JSON bytes (SUP-953). */
export declare const MANIFEST_MAX_TOTAL_BYTES: number;
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
    /** Which of the manifest's UI resources renders the tool's result, and who may call it (SUP-953). */
    ui?: ManifestToolUi;
    /** Overrides of the tool's MCP annotations (SUP-953); the rest are inherited (see
     *  customToolAnnotations). An override may only make a hint MORE cautious. */
    annotations?: ToolAnnotationsOverride;
};
/** Annotation override keys, and a title's ceiling. */
export declare const TOOL_ANNOTATION_KEYS: readonly ["title", "readOnlyHint", "destructiveHint", "openWorldHint"];
export declare const TOOL_TITLE_MAX = 120;
/** The analysis graphs an app needs (SUP-954). Each defaults to false. */
export interface ManifestAnalysis {
    /** The provenance graph (corroborates / elaborates / supersedes / contradicts). */
    provenance?: boolean;
    /** The entity graph (canonical entities, mentions, related_via). */
    entity?: boolean;
}
/** How far an app may reach into a person's container on their behalf, in ascending order. */
export declare const ACCESS_LEVELS: readonly ["none", "read", "write"];
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
/** The identity fields an app may ask for beside its per-app user id, in the order they are reported. */
export declare const ACCESS_IDENTITY_FIELDS: readonly ["email", "profile"];
export type AccessIdentityField = (typeof ACCESS_IDENTITY_FIELDS)[number];
/** A level description's ceiling. It is one line of consent copy, not documentation. */
export declare const ACCESS_DESCRIPTION_MAX = 200;
/** What an app asks for when a person signs in to the app itself. Every key but `level` is optional. */
export interface ManifestAccess {
    level: AccessLevel;
    /** What reading is for, in the developer's words. Only with level "read" or "write". */
    read?: string;
    /** What writing is for, in the developer's words. Only with level "write". */
    write?: string;
    /** Identity fields asked for beside the per-app user id. */
    identity?: AccessIdentityField[];
}
/** `access` as a consent screen needs it: every key present, whatever the manifest stated. */
export interface ValidatedAccess {
    /** Does the manifest carry an `access` block at all? */
    declared: boolean;
    level: AccessLevel;
    /** The developer's description of each level the manifest is granted, when it gave one. Never a
     *  description for a level above `level`. Plain text: show it as text, attributed to the app. */
    descriptions: {
        read?: string;
        write?: string;
    };
    /** The identity fields asked for, in `ACCESS_IDENTITY_FIELDS` order, without repeats. */
    identity: AccessIdentityField[];
    /** The tools that send container records to the app's own server (an `after` action receives
     *  the base tool's output). Empty when none does, and when the tools were not given. */
    sendsRecordsToApp: string[];
    /** The manifest states NO level while a tool sends container records to the app: it reads the
     *  container without saying so. Not an error (such manifests predate `access` and still
     *  validate), but a consent screen built from `level` alone would understate it. Never true for a
     *  manifest with an `access` block: there the validator refuses level "none". */
    undeclaredRead: boolean;
}
/** Something a valid manifest should fix. Reported beside the validation, never a refusal. */
export interface ManifestWarning {
    code: "access_undeclared";
    path: string;
    message: string;
}
/** A manifest's `access`, with every key filled. No block means level "none" and no identity
 *  fields: exactly what a manifest written before `access` existed asks for. */
export declare function manifestAccess(m: Pick<ConnectManifest, "access"> | null | undefined, 
/** The manifest's validated tools, when in hand: what `sendsRecordsToApp` is read from. */
tools?: Array<Pick<ValidatedManifestTool, "definition" | "capabilities">>): ValidatedAccess;
/** What moving from one manifest's `access` to another's ADDS: a higher level, and identity fields
 *  not asked for before. A person who approved `from` has not approved either. Lowering the level,
 *  dropping a field, or rewording a description widens nothing. */
export interface AccessChange {
    from: AccessLevel;
    to: AccessLevel;
    /** Is `to` a higher level than `from`? */
    raisesLevel: boolean;
    /** Identity fields `to` asks for and `from` did not. */
    addsIdentity: AccessIdentityField[];
    /** Does anything widen? `raisesLevel` or a non-empty `addsIdentity`. */
    widens: boolean;
}
export declare function accessChange(from: Pick<ConnectManifest, "access"> | null | undefined, to: Pick<ConnectManifest, "access"> | null | undefined): AccessChange;
/** Why a level description is not acceptable, or null. It is shown to a person deciding whether to
 *  trust the app, under the app's name, so it is one line of plain text: no markup, no links, no
 *  control characters. A renderer must still show it as text; this keeps what it shows honest. */
export declare function accessDescriptionProblem(raw: unknown): string | null;
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
        privacy_policy_url?: string;
    };
    objects: ManifestObject[];
    actions: ManifestAction[];
    tools: ManifestTool[];
    base_tools: string[];
    builtin_tools?: Record<string, ManifestBuiltinTool>;
    analysis?: ManifestAnalysis;
    access?: ManifestAccess;
    instructions?: string;
    skill?: string;
    ui?: UiResource[];
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
    /** The UI resource that renders the tool's result (SUP-953): its name, its `ui://` URI, and who
     *  may call the tool, defaults filled (both). Absent for a tool without a UI. */
    ui?: {
        resource: string;
        uri: string;
        visibility: UiVisibility[];
    };
    /** The MCP annotations the tool is listed with (SUP-953): inherited, action-derived, overridden. */
    annotations: ToolAnnotations;
    /** The output schema the tool is listed with (SUP-953), when it has one. */
    outputSchema?: Record<string, unknown>;
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
    /** What the manifest asks for at sign-in, every key filled (`manifestAccess`). */
    access: ValidatedAccess;
    /** Things the manifest should fix that do not make it invalid. Usually empty. */
    warnings: ManifestWarning[];
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
