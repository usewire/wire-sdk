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
 *
 * WIRE ACCEPTS EXACTLY WHAT `validateWireManifest` ACCEPTS. Wire's registration
 * runs the engine's validator with one extra base tool a custom tool may wrap
 * (`wire_claim`, which the hosted container registers), and then two rules of
 * its own that the engine does not have:
 *
 *   - `wire_claim` is wrapped by a tool of your own, never listed in
 *     `base_tools`, and the tool that wraps it runs no action and renders no
 *     view;
 *   - `app.privacy_policy_url` is your own page, never one on usewire.io.
 *
 * `validateWireManifest` (and so `defineManifest`) does the same, in the same
 * order, with the same messages. ONE rule cannot be checked here, because it
 * depends on a setting of your agent and not on the document: an agent that
 * lets people connect WITHOUT AN ACCOUNT must map the claim in exactly one
 * usable tool. `claimMapping(manifest)` answers that for a manifest; Wire
 * enforces it when you register a manifest for such an agent, and when you
 * turn that setting on.
 */
import {
  ACTION_TIMEOUT_MAX_MS,
  MANIFEST_FORMAT_VERSION,
  builtinToolLookup,
  validateManifest,
} from '../vendor/manifest/manifest.js';
import type { ConnectManifest, ManifestWarning, ValidatedAccess } from '../vendor/manifest/manifest.js';
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
  /**
   * Your privacy policy, shown as a link on the screen where a person signs in
   * to your agent. An `https` address on your own domain: Wire refuses one on
   * usewire.io.
   */
  privacy_policy_url?: string;
}

/** How far your own app may reach into a person's container on their behalf. */
export type ManifestAccessLevel = 'none' | 'read' | 'write';
/** Identity your app may ask for beside the per-agent user id it always gets. */
export type ManifestAccessIdentity = 'email' | 'profile';

/**
 * What your agent asks for when a person signs in to YOUR OWN APP with their
 * Wire account ("Sign in with Wire"). Declaring it changes how your app
 * connects: see `WireSignIn`. Without it, nobody signs in to your app with
 * Wire, and `connectInBrowser()` works as before.
 *
 * The person sees this on the sign-in screen, in your words, under your name.
 * A new version that raises `level` or adds an `identity` field is shown to
 * them again before it applies.
 */
export interface ManifestAccess {
  /**
   * `none`: your app learns who the person is and nothing in their container.
   * `read`: your app may call your tools that do not change a record.
   * `write`: your app may call all of your tools.
   * A manifest whose tools send container records to your server (an `after`
   * action) may not say `none`.
   */
  level: ManifestAccessLevel;
  /** What reading is for: one line of plain text (at most 200 characters). Only with `read` or `write`. */
  read?: string;
  /** What writing is for: one line of plain text (at most 200 characters). Only with `write`. */
  write?: string;
  /** Ask for the person's email address, their name and picture, or both. */
  identity?: ManifestAccessIdentity[];
}

/** Which transports a tool is on after install. Each defaults to true. */
export interface ManifestToolTransports {
  mcp?: boolean;
  rest?: boolean;
}

/** One of Wire's built-in tools as your manifest sets it: on or off, and on which transports. */
export interface ManifestBuiltinTool {
  enabled?: boolean;
  transports?: ManifestToolTransports;
}

/** The analysis graphs your agent needs. Each defaults to false, and an install sets both. */
export interface ManifestAnalysis {
  /** The provenance graph (corroborates / elaborates / supersedes / contradicts). 1 credit per entry written. */
  provenance?: boolean;
  /** The entity graph (canonical entities and their relations). 1 credit per entry written. */
  entity?: boolean;
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
  /** Is the tool on after install? Default true. */
  enabled?: boolean;
  /** On which transports. Each defaults to true. */
  transports?: ManifestToolTransports;
  before?: ManifestActionStep;
  /**
   * The base tool this tool maps onto. One name is special: `wire_claim`, the
   * tool that gives a person on a trial the link to keep their container. It
   * is never listed by its own name (not in `base_tools`): wrap it in one tool
   * of your own, with your name and description, no `before` / `after` action
   * and no `ui`. See `claimMapping`.
   */
  tool: { name: string; args: Record<string, unknown> };
  after?: ManifestActionStep;
  /**
   * The result mapping (a JSON object template). Absent: the base tool's result,
   * unchanged. A top-level `_meta` key (`VIEW_META_KEY`) maps VIEW-ONLY data:
   * it goes to the MCP result's `_meta.view`, where an MCP Apps view reads it,
   * and never into `structuredContent` or `content`, so the model never sees it.
   */
  result?: Record<string, unknown> & { _meta?: Record<string, unknown> };
  /**
   * JSON Schema of the tool's result data, checked on every call and listed as
   * the tool's `outputSchema`. Absent: the base tool's, when the tool hands the
   * base result back unchanged (no `result` mapping, no action); else none.
   */
  outputSchema?: JsonSchema;
  /**
   * Overrides of the MCP annotations the tool is listed with. The rest are
   * inherited from the base tool (and `openWorldHint` is true when the tool
   * calls an action). An override may only make the tool look MORE cautious:
   * `readOnlyHint: true` is refused on a tool that writes, and
   * `destructiveHint: false` on one that deletes.
   */
  annotations?: ManifestToolAnnotations;
  /**
   * The interactive view that renders this tool's result in hosts that support
   * MCP Apps (SUP-953): `resource` names an entry of the manifest's `ui`. The
   * tool is listed with `_meta.ui.resourceUri` =
   * `ui://<app id>/<resource>-<hash>` (see `uiUri`); a host without MCP Apps
   * shows the tool's normal result, so keep that result complete on its own.
   */
  ui?: ManifestToolUi;
}

/** A tool's MCP annotation overrides (hints a host uses to decide when to ask the user first). */
export interface ManifestToolAnnotations {
  /** Display name (at most 120 characters). */
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
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
 * Wire serves it at `ui://<app id>/<name>-<hash>` (`uiUri`) as `text/html;profile=mcp-app`.
 */
export interface ManifestUi {
  /** Lowercase letters, digits and hyphens (1-64); the last segment of the view's `ui://` URI, before its hash. */
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
  /** Base tools (e.g. "wire_search") to keep visible to the agent's grant beside its own tools. Never `wire_claim`. */
  base_tools?: string[];
  /** Wire's built-in tools, by name, as an install sets them. One you leave out keeps Wire's default. */
  builtin_tools?: Record<string, ManifestBuiltinTool>;
  /** The analysis graphs your agent needs. An install sets both; one you leave out is off. */
  analysis?: ManifestAnalysis;
  /** What your agent asks for when a person signs in to your own app (`WireSignIn`). */
  access?: ManifestAccess;
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
  const result = validateWireManifest(structuredClone(manifest));
  if (!result.ok) throw new WireManifestError(result.errors);
  const defined = deepFreeze(result.manifest);
  checked.add(defined);
  return defined as unknown as DefinedManifest<M>;
}

/* ───────────────────────────── what Wire accepts ───────────────────────────── */

/** The tool that gives a person on a trial the link to keep their container. */
export const WIRE_CLAIM_TOOL = 'wire_claim';

// Wire's hosted container registers `wire_claim` beside the engine's own tools, so a custom tool
// may wrap it. This is that tool as the validator needs it; Wire's registration passes the same.
const WIRE_CLAIM_TOOL_DEF = {
  name: WIRE_CLAIM_TOOL,
  description: 'Keep this trial container by creating a free Wire account. Returns a sign-up link.',
  type: 'primitive' as const,
  mcpEnabled: false,
  restEnabled: false,
  mutates: false,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Keep this container', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

const CLAIM_IN_BASE_TOOLS_MESSAGE =
  '"wire_claim" cannot be listed in base_tools. Wrap it in one custom tool of your own instead: a tool whose "tool" is { "name": "wire_claim" }, with your own name and description.';
const CLAIM_WITH_ACTION_MESSAGE =
  'A tool that wraps "wire_claim" is kept simple: it returns the claim link as text and does nothing else, so it cannot run a "before" or "after" action or render a "ui" view. Remove them from this tool.';
const PRIVACY_POLICY_ON_WIRE_MESSAGE =
  "must be your own privacy policy, on your own domain: an address on usewire.io is Wire's, not your app's";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function claimWraps(document: unknown): Array<{ index: number; tool: Record<string, unknown> }> {
  const tools = isObject(document) && Array.isArray(document.tools) ? document.tools : [];
  const out: Array<{ index: number; tool: Record<string, unknown> }> = [];
  tools.forEach((t, index) => {
    if (isObject(t) && isObject(t.tool) && t.tool.name === WIRE_CLAIM_TOOL) out.push({ index, tool: t });
  });
  return out;
}

function claimProblem(document: unknown): { path: string; message: string } | null {
  const base = isObject(document) && Array.isArray(document.base_tools) ? document.base_tools : [];
  if (base.includes(WIRE_CLAIM_TOOL)) return { path: 'base_tools', message: CLAIM_IN_BASE_TOOLS_MESSAGE };
  for (const { index, tool } of claimWraps(document)) {
    if (tool.before !== undefined || tool.after !== undefined || tool.ui !== undefined) {
      return { path: `tools.${index}`, message: CLAIM_WITH_ACTION_MESSAGE };
    }
  }
  return null;
}

function privacyPolicyProblem(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  return host === 'usewire.io' || host.endsWith('.usewire.io') ? PRIVACY_POLICY_ON_WIRE_MESSAGE : null;
}

/** What `validateWireManifest` answers. */
export type WireManifestValidation =
  | {
      ok: true;
      /** The normalized manifest (defaults filled). */
      manifest: ConnectManifest;
      /** What the manifest asks for at sign-in, every key filled. `declared: false` with no `access` block. */
      access: ValidatedAccess;
      /**
       * Things a valid manifest should fix. Wire registers the manifest anyway
       * and shows them on the agent's page. Today: `access_undeclared`, a
       * manifest whose tools send container records to your server while it
       * has no `access` block.
       */
      warnings: ManifestWarning[];
    }
  | { ok: false; errors: Array<{ path: string; message: string }> };

/**
 * Check a manifest exactly as Wire's registration does: the engine's
 * validator (with `wire_claim` as a tool a custom tool may wrap), then Wire's
 * two rules of its own. Never throws. `defineManifest` is this, throwing.
 */
export function validateWireManifest(raw: unknown): WireManifestValidation {
  const v = validateManifest(raw, builtinToolLookup([WIRE_CLAIM_TOOL_DEF as never]));
  if (!v.ok) return { ok: false, errors: v.errors.map((e) => ({ path: e.path, message: e.message })) };
  const claim = claimProblem(v.manifest);
  if (claim) return { ok: false, errors: [claim] };
  const policy = privacyPolicyProblem(v.manifest.app.privacy_policy_url);
  if (policy) return { ok: false, errors: [{ path: 'app.privacy_policy_url', message: policy }] };
  return { ok: true, manifest: v.manifest, access: v.access, warnings: [...v.warnings] };
}

/** The warnings Wire would show for this manifest (see `WireManifestValidation.warnings`). Empty for an invalid one. */
export function manifestWarnings(manifest: unknown): ManifestWarning[] {
  const v = validateWireManifest(manifest);
  return v.ok ? v.warnings : [];
}

const CLAIM_URL_SUBSTITUTION = /\{\{\s*tool\.claim_url\s*\}\}/;
function mentionsClaimUrl(v: unknown): boolean {
  if (typeof v === 'string') return CLAIM_URL_SUBSTITUTION.test(v);
  if (Array.isArray(v)) return v.some(mentionsClaimUrl);
  // `_meta` is view-only data, and the claim tool has no view.
  if (isObject(v)) return Object.entries(v).some(([k, x]) => k !== '_meta' && mentionsClaimUrl(x));
  return false;
}

/** Does a manifest map the claim the way an agent that allows connecting without an account must? */
export type ClaimMapping =
  | { ok: true; /** The tool that wraps `wire_claim`. */ tool: string }
  | { ok: false; reason: 'in_base_tools' | 'none' | 'more_than_one' | 'unusable'; message: string };

const CLAIM_HOW =
  'Add one custom tool whose "tool" is { "name": "wire_claim" }, with your own name and description, so people on a trial can keep what they saved.';

/**
 * THE RULE FOR AN AGENT THAT LETS PEOPLE CONNECT WITHOUT AN ACCOUNT (the
 * setting on your agent's page): the manifest maps the claim in EXACTLY ONE
 * tool, and a person on a trial can use it (it is on, it is on the MCP
 * transport, and if it has a `result` mapping that mapping includes
 * `{{tool.claim_url}}`). Wire refuses to register a manifest that breaks this
 * for such an agent, and refuses to turn the setting on for one that does.
 *
 * An agent without that setting may leave the claim out entirely.
 */
export function claimMapping(manifest: unknown): ClaimMapping {
  const base = isObject(manifest) && Array.isArray(manifest.base_tools) ? manifest.base_tools : [];
  if (base.includes(WIRE_CLAIM_TOOL)) return { ok: false, reason: 'in_base_tools', message: CLAIM_IN_BASE_TOOLS_MESSAGE };
  const wraps = claimWraps(manifest);
  if (wraps.length === 0) {
    return { ok: false, reason: 'none', message: `Connecting without an account needs the manifest to map the claim, and this one does not. ${CLAIM_HOW}` };
  }
  if (wraps.length > 1) {
    const names = wraps.map((w) => String(w.tool.name));
    return { ok: false, reason: 'more_than_one', message: `The manifest maps the claim in ${names.length} tools (${names.join(', ')}). Keep exactly one tool that wraps "wire_claim".` };
  }
  const tool = wraps[0]!.tool;
  const name = typeof tool.name === 'string' ? tool.name : 'the tool';
  const unusable =
    tool.enabled === false
      ? `"${name}" wraps "wire_claim" but is switched off ("enabled": false). Turn it on.`
      : isObject(tool.transports) && tool.transports.mcp === false
        ? `"${name}" wraps "wire_claim" but is not on the MCP transport ("transports.mcp": false). Turn it on.`
        : tool.result !== undefined && !mentionsClaimUrl(tool.result)
          ? `"${name}" wraps "wire_claim" but its "result" leaves out the claim link. Include "{{tool.claim_url}}" in it, or remove "result" to return the answer unchanged.`
          : null;
  if (unusable) return { ok: false, reason: 'unusable', message: `Connecting without an account needs a claim tool people can use. ${unusable}` };
  return { ok: true, tool: name };
}

const checked = new WeakSet<object>();

/** Throw WireManifestError unless the manifest is valid (a defineManifest() result always is). */
export function assertManifest(manifest: unknown): void {
  if (typeof manifest === 'object' && manifest !== null && checked.has(manifest)) return;
  const result = validateWireManifest(manifest);
  if (!result.ok) throw new WireManifestError(result.errors);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
