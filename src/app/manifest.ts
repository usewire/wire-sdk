/**
 * The Connect app manifest (SUP-946): the container configuration an app
 * installs when a user connects it — declared objects, custom tools, the
 * actions those tools call before or after their base tool, instructions and
 * a skill. No secrets.
 *
 * THE ENGINE OWNS THE FORMAT. The types below mirror the engine's
 * `ConnectManifest` (usewire/wire `src/connect/manifest.ts`, SUP-946) and are
 * provisional until that ships. Full validation (tool mappings against base
 * tool schemas, substitution sources, reserved names, URL policy, limits) is
 * the engine's `validateManifest`; it runs on the control plane when you
 * register the manifest. defineManifest() checks locally only
 * what defineAction() depends on, so an action endpoint cannot be built from
 * a manifest it would misread. See the README for why the engine validator is
 * not imported here yet.
 */
import { WireManifestError } from './errors.js';
import { compileSchema, type JsonSchema } from './schema.js';

/** The manifest format version this SDK understands. */
export const MANIFEST_VERSION = 1;
/** Wire's hard ceiling on an action's timeout. */
export const MAX_ACTION_TIMEOUT_MS = 8000;

export interface ManifestApp {
  /** Your app id: the agent id you registered with Wire. Also the `aud` of every action call. */
  id: string;
  name: string;
  /** Your manifest version (semver). Re-registering the same version is a no-op. */
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
  /** Always "declared": an app's objects are pinned profiles. */
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
  /** Your HTTPS endpoint. */
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
  /** Base tools (e.g. "wire_search") to keep visible to the app's grant beside its own tools. */
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

const APP_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ACTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const NAME_MAX = 64;

/**
 * Type and check a manifest. Returns a deep-frozen copy (so an action's schema
 * cannot change after its validator was compiled), or throws
 * WireManifestError listing every problem found. The manifest must be plain
 * JSON data.
 */
export function defineManifest<const M extends WireManifest>(manifest: M): DefinedManifest<M> {
  assertManifest(manifest);
  const defined = deepFreeze(structuredClone(manifest));
  checked.add(defined);
  return defined as DefinedManifest<M>;
}

const checked = new WeakSet<object>();

/** Throw WireManifestError unless the manifest passes the local checks. */
export function assertManifest(manifest: unknown): void {
  if (typeof manifest === 'object' && manifest !== null && checked.has(manifest)) return;
  const issues = checkManifest(manifest);
  if (issues.length) throw new WireManifestError(issues);
}

type Issue = { path: string; message: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkManifest(m: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(m)) return [{ path: '', message: 'manifest must be an object' }];

  if (m.manifest !== MANIFEST_VERSION) {
    issues.push({ path: 'manifest', message: `must be ${MANIFEST_VERSION}` });
  }

  const app = m.app;
  if (!isObject(app)) {
    issues.push({ path: 'app', message: 'required' });
  } else {
    if (typeof app.id !== 'string' || !APP_ID_RE.test(app.id) || app.id.length > NAME_MAX) {
      issues.push({ path: 'app.id', message: 'must be identifier-like (letters, digits, _ or -), starting with a letter' });
    }
    if (typeof app.name !== 'string' || !app.name.trim()) issues.push({ path: 'app.name', message: 'required' });
    if (typeof app.version !== 'string' || !app.version.trim()) {
      issues.push({ path: 'app.version', message: 'required' });
    }
  }

  for (const key of ['objects', 'actions', 'tools', 'base_tools'] as const) {
    if (m[key] !== undefined && !Array.isArray(m[key])) issues.push({ path: key, message: 'must be an array' });
  }

  const actions = Array.isArray(m.actions) ? m.actions : [];
  const seen = new Set<string>();
  actions.forEach((a: unknown, i: number) => {
    const at = `actions[${i}]`;
    if (!isObject(a)) {
      issues.push({ path: at, message: 'must be an object' });
      return;
    }
    if (typeof a.name !== 'string' || !ACTION_NAME_RE.test(a.name) || a.name.length > NAME_MAX) {
      issues.push({ path: `${at}.name`, message: 'must be identifier-like, starting with a letter' });
    } else if (seen.has(a.name)) {
      issues.push({ path: `${at}.name`, message: `duplicate action "${a.name}"` });
    } else {
      seen.add(a.name);
    }
    if (typeof a.description !== 'string' || !a.description.trim()) {
      issues.push({ path: `${at}.description`, message: 'required: the consent screen shows it' });
    }
    if (a.method !== undefined && a.method !== 'POST') {
      issues.push({ path: `${at}.method`, message: 'must be POST' });
    }
    if (typeof a.url !== 'string' || !isHttpsUrl(a.url)) {
      issues.push({ path: `${at}.url`, message: 'must be an https URL' });
    }
    if (
      a.timeout_ms !== undefined &&
      (typeof a.timeout_ms !== 'number' ||
        !Number.isInteger(a.timeout_ms) ||
        a.timeout_ms <= 0 ||
        a.timeout_ms > MAX_ACTION_TIMEOUT_MS)
    ) {
      issues.push({ path: `${at}.timeout_ms`, message: `must be an integer from 1 to ${MAX_ACTION_TIMEOUT_MS}` });
    }
    for (const key of ['input', 'output'] as const) {
      const schema = a[key];
      if (!isObject(schema)) {
        issues.push({ path: `${at}.${key}`, message: 'must be a JSON Schema object' });
        continue;
      }
      const inherited = inheritedNames(schema);
      if (inherited) {
        issues.push({ path: `${at}.${key}`, message: `property "${inherited}" shadows a built-in object member` });
        continue;
      }
      try {
        compileSchema(schema);
      } catch (err) {
        issues.push({ path: `${at}.${key}`, message: `not a usable JSON Schema: ${(err as Error).message}` });
      }
    }
  });

  // Tools reference actions by name; a dangling reference would install a
  // tool that can never run. (The rest of the tool mapping is the engine's.)
  const tools = Array.isArray(m.tools) ? m.tools : [];
  tools.forEach((t: unknown, i: number) => {
    if (!isObject(t)) {
      issues.push({ path: `tools[${i}]`, message: 'must be an object' });
      return;
    }
    for (const step of ['before', 'after'] as const) {
      const s = t[step];
      if (s === undefined) continue;
      if (!isObject(s) || typeof s.action !== 'string') {
        issues.push({ path: `tools[${i}].${step}`, message: 'must be { action, args }' });
      } else if (!seen.has(s.action)) {
        issues.push({ path: `tools[${i}].${step}.action`, message: `no action named "${s.action}"` });
      }
    }
  });

  return issues;
}

/**
 * The validator tests `properties` / `required` with `in`, which sees
 * Object.prototype: a property called "constructor" would be "present" on
 * every object. Refuse such names anywhere in a schema.
 */
function inheritedNames(schema: unknown, depth = 0): string | null {
  if (depth > 32 || typeof schema !== 'object' || schema === null) return null;
  const s = schema as Record<string, unknown>;
  const names = [
    ...(isObject(s.properties) ? Object.keys(s.properties) : []),
    ...(Array.isArray(s.required) ? s.required.filter((n): n is string => typeof n === 'string') : []),
  ];
  const hit = names.find((n) => n in Object.prototype);
  if (hit) return hit;
  for (const v of Object.values(s)) {
    const found = Array.isArray(v)
      ? v.map((x) => inheritedNames(x, depth + 1)).find(Boolean) ?? null
      : inheritedNames(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function isHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
