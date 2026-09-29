import type { ValidationError } from "../tools/custom.js";
/** The MCP Apps extension's identifier, as a server declares it in its capabilities. */
export declare const UI_EXTENSION = "io.modelcontextprotocol/ui";
/** The media type a UI resource is served as (the only one the 2026-01-26 spec defines). */
export declare const UI_MIME_TYPE = "text/html;profile=mcp-app";
/** The URI scheme UI resources are served under. */
export declare const UI_URI_SCHEME = "ui://";
/** A UI resource's name: the skill-name grammar (1-64 lowercase ASCII letters and digits in
 *  hyphen-separated runs), so it is always a valid URI path segment. */
export declare const UI_NAME_RE: RegExp;
export declare const UI_NAME_MAX = 64;
export declare const UI_TITLE_MAX = 120;
/** Largest `html`, in UTF-8 bytes. */
export declare const UI_HTML_MAX_BYTES: number;
/** Largest total of every resource's `html`, in UTF-8 bytes. */
export declare const UI_TOTAL_HTML_MAX_BYTES: number;
export declare const UI_MAX_RESOURCES = 8;
/** Entries per CSP list. */
export declare const UI_CSP_DOMAINS_MAX = 32;
/** The CSP lists a resource may declare, in the order the normalized manifest keeps them. */
export declare const UI_CSP_KEYS: readonly ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"];
/** The iframe permissions a resource may request, in the order the normalized manifest keeps them. */
export declare const UI_PERMISSION_KEYS: readonly ["camera", "microphone", "geolocation", "clipboardWrite"];
/** Who may call a tool with a UI: the model (the agent), the app (the rendered view), or both. */
export declare const UI_VISIBILITY_VALUES: readonly ["model", "app"];
export type UiCspKey = (typeof UI_CSP_KEYS)[number];
export type UiPermission = (typeof UI_PERMISSION_KEYS)[number];
export type UiVisibility = (typeof UI_VISIBILITY_VALUES)[number];
export type UiCsp = Partial<Record<UiCspKey, string[]>>;
/** Each requested permission is an empty object, as the spec shapes it. */
export type UiPermissions = Partial<Record<UiPermission, Record<string, never>>>;
/** One UI resource as a manifest carries it (normalized: keys present only when the document gave
 *  them, in a fixed order). */
export interface UiResource {
    name: string;
    title?: string;
    html: string;
    csp?: UiCsp;
    permissions?: UiPermissions;
    prefersBorder?: boolean;
}
/** A manifest tool's `ui`: which resource renders its result, and who may call it. */
export interface ManifestToolUi {
    resource: string;
    /** Present only when the document gave it; deduplicated, in the order "model", "app". */
    visibility?: UiVisibility[];
}
/** What a tool's `tools/list` entry carries as `_meta.ui`. */
export interface ToolUiMeta {
    resourceUri: string;
    visibility?: UiVisibility[];
}
/** What a UI resource carries as `_meta.ui`, on its `resources/list` entry and its
 *  `resources/read` content alike. */
export interface UiResourceMeta {
    csp?: UiCsp;
    permissions?: UiPermissions;
    prefersBorder?: boolean;
}
/** `ui://<app id>/<name>`: the URI a resource is served at. Namespaced by the app, so a container's
 *  UI can later hold resources from more than one source without a name ever meaning two things. */
export declare function uiUri(appId: string, name: string): string;
/** Read a `ui://<app id>/<name>` URI into its parts, or null when it is not one this engine could
 *  serve (exactly two segments, each in its grammar; a query, fragment, percent-escape, backslash,
 *  whitespace or trailing slash is refused rather than normalized). */
export declare function parseUiUri(uri: unknown): {
    appId: string;
    name: string;
} | null;
/**
 * Why a CSP entry is refused, or null when it is allowed. THE rule for every `csp` list, in the
 * engine, the control plane and the SDK alike:
 *
 *   * an https origin: `https://host` or `https://host:port`, and nothing after it (no path, not
 *     even `/`, no query, fragment or credentials);
 *   * the host is a DNS name of at least two labels, not an IP literal, not `localhost`;
 *   * one leading `*.` label at most, over a name of at least two labels (`https://*.example.com`,
 *     never `*`, `https://*`, `https://*.com` or a `*` anywhere else);
 *   * never Wire's own domain, `usewire.io` or any name under it, in any case, wildcard or not: an
 *     app's view must not be able to reach the platform it is installed on as its user.
 */
export declare function uiDomainProblem(entry: unknown): string | null;
/** `uiDomainProblem`, as a boolean. */
export declare const isUiDomain: (entry: unknown) => boolean;
/**
 * Validate a manifest's `ui` list. Errors are paths under `ui` (`ui.0.csp.connectDomains.2`).
 * Returns the normalized resources (only the entries that validated). Never throws.
 */
export declare function parseUiResources(raw: unknown): {
    resources: UiResource[];
    errors: ValidationError[];
};
/**
 * Validate a manifest tool's `ui` against the manifest's resource names. Errors are paths under
 * `<path>` (`tools.2.ui.resource`). Returns the normalized value, or null when it is refused.
 */
export declare function parseToolUi(raw: unknown, path: string, resourceNames: ReadonlySet<string>, err: (path: string, message: string) => void): ManifestToolUi | null;
/** A resource's `_meta.ui`: its CSP, permissions and border preference, only the keys it has. The
 *  same object on its `resources/list` entry and its `resources/read` content. */
export declare function uiResourceMeta(r: UiResource): UiResourceMeta;
/** A tool's `_meta.ui` for `tools/list`: the resource's URI, and `visibility` only when the manifest
 *  stated it (a host defaults it to both). */
export declare function toolUiMeta(appId: string, ui: ManifestToolUi): ToolUiMeta;
/** Every CSP entry of a resource, per list, each list complete (empty when not declared). */
export declare function uiCspLists(r: Pick<UiResource, "csp">): Record<UiCspKey, string[]>;
/** The permissions a resource requests, by name, in the fixed order. */
export declare function uiPermissionList(r: Pick<UiResource, "permissions">): UiPermission[];
/** One UI resource as a consent screen shows it: what it is, its exact bytes' digest, every origin
 *  it may reach, every permission it asks for, and the tools whose results it renders. `html` is the
 *  app's code, verbatim: show it as source text, never render it. */
export interface UiResourceDescription {
    name: string;
    title: string | null;
    uri: string;
    /** UTF-8 bytes of `html`. */
    bytes: number;
    /** Lowercase hex SHA-256 of the UTF-8 bytes of `html`: of exactly what `resources/read` serves. */
    sha256: string;
    html: string;
    /** Every CSP list, complete (empty when not declared). */
    csp: Record<UiCspKey, string[]>;
    permissions: UiPermission[];
    prefersBorder: boolean | null;
    /** The manifest tools that render with this resource, with who may call each. */
    tools: Array<{
        name: string;
        visibility: UiVisibility[];
    }>;
}
/** The manifest's UI resources as a consent screen shows them, in the manifest's order. Pass the
 *  NORMALIZED manifest `validateManifest` returns. WebCrypto for the digest, so it runs anywhere
 *  (and is async, like `manifestSha256`). */
export declare function describeUiResources(m: {
    app: {
        id: string;
    };
    ui?: UiResource[];
    tools: Array<{
        name: string;
        ui?: ManifestToolUi;
    }>;
}): Promise<UiResourceDescription[]>;
/** One UI resource an upgrade changes: what changed, and what it may now reach or ask for that it
 *  could not before (what a consent screen highlights). */
export interface UiResourceChange {
    name: string;
    /** The HTML changed. */
    html: boolean;
    /** Any CSP list changed (an origin added or removed). */
    csp: boolean;
    /** The permissions requested changed. */
    permissions: boolean;
    /** Origins the new version declares that the old one did not, per CSP list (only lists with some). */
    newDomains: Partial<Record<UiCspKey, string[]>>;
    /** Permissions the new version requests that the old one did not. */
    newPermissions: UiPermission[];
}
/** What an upgrade does to the UI resources, by name. A change to `title` or `prefersBorder` alone
 *  is a change with every flag false. */
export interface UiDiff {
    added: string[];
    changed: UiResourceChange[];
    removed: string[];
    unchanged: string[];
}
/** Compare two versions' UI resources (a manifest without `ui` has none). Pure, so a consent screen
 *  can show an upgrade's diff before it is applied; the apply response's `diff.ui` is this. */
export declare function diffUiResources(from: UiResource[] | undefined | null, to: UiResource[] | undefined | null): UiDiff;
