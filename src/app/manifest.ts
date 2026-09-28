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
}

export interface WireManifest {
  manifest: typeof MANIFEST_VERSION;
  app: ManifestApp;
  objects?: ManifestObject[];
  actions?: ManifestAction[];
  tools?: ManifestTool[];
  /** Base tools (e.g. "wire_search") to keep visible to the agent's grant beside its own tools. */
  base_tools?: string[];
  /** Server instructions shown to the connecting agent. */
  instructions?: string;
  /** Skill contents (SKILL.md). */
  skill?: string;
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
