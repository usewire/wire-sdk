/**
 * An agent's manifest (SUP-946): the container configuration an agent
 * installs when a user connects it — declared objects, custom tools, the
 * actions those tools call before or after their base tool, instructions and
 * a skill. No secrets.
 *
 * THE ENGINE OWNS THE FORMAT AND ITS VALIDATION. defineManifest() runs the
 * engine's own `validateManifest` (usewire/wire `src/connect/manifest.ts`),
 * vendored under src/vendor/manifest at the commit pinned in MANIFEST_REF: the
 * same code the control plane runs on registration and the container runs on
 * apply. The input types below are the authoring shape (defaults optional);
 * the vendored `ConnectManifest` type is the normalized result.
 */
import {
  ACTION_TIMEOUT_MAX_MS,
  MANIFEST_FORMAT_VERSION,
  validateManifest,
} from '../vendor/manifest/manifest.js';
import { WireManifestError } from './errors.js';
import type { JsonSchema } from './schema.js';

/** The manifest format version this SDK understands. */
export const MANIFEST_VERSION = MANIFEST_FORMAT_VERSION as 1;
/** Wire's hard ceiling on an action's timeout, and its default. */
export const MAX_ACTION_TIMEOUT_MS: number = ACTION_TIMEOUT_MAX_MS;

export interface ManifestApp {
  /** The manifest id (lowercase): your agent id with `-` as `_`. Also the `aud` of every action call. */
  id: string;
  name: string;
  /** Your manifest version. Re-registering an identical document is a no-op. */
  version: string;
}

export type ManifestFieldType = 'text' | 'number' | 'integer' | 'boolean' | 'date' | 'json';

export interface ManifestObjectField {
  name: string;
  type: ManifestFieldType;
  label?: string;
}

export interface ManifestObject {
  name: string;
  label?: string;
  /** Always "declared": an agent's objects are pinned profiles. */
  mode?: 'declared';
  /** Which fields hold coordinates, for a spatial object. */
  geo?: { lat: string; lng: string };
  fields: ManifestObjectField[];
}

export interface ManifestAction {
  /** Referenced by custom tools' `before` / `after`. Never visible to agents. */
  name: string;
  /** Required: shown on the consent screen. Say plainly what the action receives and keeps. */
  description: string;
  method?: 'POST';
  /** Your HTTPS endpoint. Wire calls exactly this URL and signs it into every call (`wire_url`). */
  url: string;
  /** JSON Schema for what Wire sends. */
  input: JsonSchema;
  /** JSON Schema for what you answer. Wire validates it too. */
  output: JsonSchema;
  /** How long Wire waits. Defaults to, and may not exceed, 8000 ms. */
  timeout_ms?: number;
}

export interface ManifestActionStep {
  action: string;
  args: Record<string, unknown>;
}

/** A custom tool: a use-case tool that maps onto exactly one base tool. */
export interface ManifestTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  before?: ManifestActionStep;
  tool: { name: string; args: Record<string, unknown> };
  after?: ManifestActionStep;
  result?: Record<string, unknown>;
  /**
   * The interactive view that renders this tool's result in hosts that support
   * MCP Apps (SUP-953): `resource` names an entry of the manifest's `ui`. The
   * tool is listed with `_meta.ui.resourceUri` = `ui://<app id>/<resource>`; a
   * host without MCP Apps shows the tool's normal result, so keep that result
   * complete on its own.
   */
  ui?: ManifestToolUi;
}

/** A tool's view: which `ui` entry renders its result, and who may call the tool. */
export interface ManifestToolUi {
  /** The `name` of one of the manifest's `ui` entries. */
  resource: string;
  /** Who may call the tool: the model, the rendered view (`app`), or both (the default). */
  visibility?: ('model' | 'app')[];
}

/** Origins a view may reach, per CSP list. Each entry is an https origin (`https://host[:port]`,
 *  one leading `*.` label at most), never Wire's own domain. */
export interface ManifestUiCsp {
  /** fetch / XHR / WebSocket (CSP `connect-src`). */
  connectDomains?: string[];
  /** Scripts, stylesheets, images, fonts, media (CSP `script-src`, `style-src`, `img-src`, ...). */
  resourceDomains?: string[];
  /** Nested iframes (CSP `frame-src`). */
  frameDomains?: string[];
  /** Allowed `<base>` URIs (CSP `base-uri`). */
  baseUriDomains?: string[];
}

/** Browser permissions a view requests; each is `{}` when requested. */
export interface ManifestUiPermissions {
  camera?: Record<string, never>;
  microphone?: Record<string, never>;
  geolocation?: Record<string, never>;
  clipboardWrite?: Record<string, never>;
}

/**
 * An interactive view (MCP Apps, `io.modelcontextprotocol/ui`): one HTML
 * document a host renders in a sandboxed iframe for the tools that name it.
 * Wire serves it at `ui://<app id>/<name>` as `text/html;profile=mcp-app`.
 */
export interface ManifestUi {
  /** Lowercase letters, digits and hyphens (1-64); the last segment of the view's `ui://` URI. */
  name: string;
  title?: string;
  /** The whole HTML document, inline (at most 512 KB). Load heavy libraries from an origin in `csp.resourceDomains`. */
  html: string;
  csp?: ManifestUiCsp;
  permissions?: ManifestUiPermissions;
  /** Ask the host to draw a border around the view. */
  prefersBorder?: boolean;
}

export interface WireManifest {
  manifest: typeof MANIFEST_VERSION;
  app: ManifestApp;
  objects?: ManifestObject[];
  actions?: ManifestAction[];
  tools?: ManifestTool[];
  /** Base tools (e.g. "wire_search") to keep visible to the agent's grant beside its own tools. */
  base_tools?: string[];
  /**
   * The MCP server `instructions` every client connecting to a container your
   * agent manages receives on `initialize` (at most 16,000 characters). The
   * short rules, for clients that never load skills.
   */
  instructions?: string;
  /**
   * The skill: a SKILL.md in the Agent Skills format (at most 64,000
   * characters), the full usage guide. Installed with your agent and served by
   * the container as `skill://<name>/SKILL.md` over MCP's Skills extension.
   * Write it with `defineSkill()` to get frontmatter Wire always accepts. With a
   * skill and no `instructions`, connecting clients are pointed at the skill.
   */
  skill?: string;
  /**
   * Interactive views (MCP Apps, SUP-953): HTML documents hosts that support
   * MCP Apps render for the tools whose `ui.resource` names them. At most 8,
   * names unique, 1 MB of HTML in total. Shown to the user at consent, with
   * every origin each view may reach.
   */
  ui?: ManifestUi[];
}

/** A manifest that passed defineManifest(). */
export type DefinedManifest<M extends WireManifest = WireManifest> = M & {
  readonly __wireManifest: true;
};

/** Action names declared by a manifest, for typed defineAction() calls. */
export type ActionName<M extends WireManifest> = M['actions'] extends ReadonlyArray<infer A>
  ? A extends { name: infer N extends string }
    ? N
    : never
  : never;

/**
 * Validate a manifest with the engine's validator and return the NORMALIZED
 * document (defaults filled: `timeout_ms`, `method`, empty arrays), deep
 * frozen, or throw WireManifestError listing every problem, each with its
 * path (`actions.0.url`, `tools.2.tool.args.limit`). The manifest must be
 * plain JSON data.
 */
export function defineManifest<const M extends WireManifest>(manifest: M): DefinedManifest<M> {
  const result = validateManifest(structuredClone(manifest));
  if (!result.ok) throw new WireManifestError(result.errors);
  const defined = deepFreeze(result.manifest);
  checked.add(defined);
  return defined as unknown as DefinedManifest<M>;
}

const checked = new WeakSet<object>();

/** Throw WireManifestError unless the manifest is valid (a defineManifest() result always is). */
export function assertManifest(manifest: unknown): void {
  if (typeof manifest === 'object' && manifest !== null && checked.has(manifest)) return;
  const result = validateManifest(manifest);
  if (!result.ok) throw new WireManifestError(result.errors);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
