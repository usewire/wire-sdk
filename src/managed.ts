/**
 * Agent-managed containers.
 *
 * When an agent's manifest is installed on a container, the manifest sets the
 * container's tools and analysis, and the container is MANAGED by that agent
 * until it is uninstalled. Changing what the manifest owns (a tool's
 * visibility, a custom tool, an API key's own tool list, the analysis
 * switches) is then refused with HTTP 409 and the code
 * `container_agent_managed`, naming the agent in `managedBy`.
 *
 * Wire answered `container_app_managed` (and `CONTAINER_APP_MANAGED`) and
 * `managedBy.appId` before the agent rename. These helpers accept both, so the
 * same check works against either server.
 */

/** The refusal code while an agent manages a container. */
export const CONTAINER_AGENT_MANAGED = 'container_agent_managed';
/** @deprecated The pre-rename spelling of `CONTAINER_AGENT_MANAGED`, still recognized. */
export const CONTAINER_APP_MANAGED = 'container_app_managed';

const MANAGED_CODES: ReadonlySet<string> = new Set([
  CONTAINER_AGENT_MANAGED,
  CONTAINER_APP_MANAGED,
  'CONTAINER_AGENT_MANAGED',
  'CONTAINER_APP_MANAGED',
]);

/** The agent that manages a container. */
export interface WireManagedBy {
  /** The agent id. */
  agentId: string;
  /** The agent's name, as its manifest states it. */
  name: string;
  /** The installed manifest version. */
  version: string;
  /** `disconnected` still manages the container until the agent is uninstalled. */
  status: 'active' | 'disconnected';
  /** Wire's install id for the agent on this container (`app:<id>`). */
  installer: string | null;
}

/** Is this code the managed-container refusal (either spelling, either case)? */
export function isAgentManagedCode(code: unknown): boolean {
  return typeof code === 'string' && MANAGED_CODES.has(code);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse a `managedBy` value: `agentId`, or `appId` from an older server (the
 * manifest form `geo_app` is mapped to the agent id `geo-app`). Null for
 * anything that is not one.
 */
export function readManagedBy(v: unknown): WireManagedBy | null {
  if (!isRecord(v)) return null;
  const installer = typeof v.installer === 'string' && v.installer ? v.installer : null;
  const raw =
    (typeof v.agentId === 'string' && v.agentId) ||
    (typeof v.appId === 'string' && v.appId) ||
    (installer?.startsWith('app:') ? installer.slice(4) : '');
  if (!raw) return null;
  const agentId = raw.replace(/_/g, '-');
  return {
    agentId,
    name: typeof v.name === 'string' && v.name ? v.name : agentId,
    version: typeof v.version === 'string' ? v.version : '',
    status: v.status === 'disconnected' ? 'disconnected' : 'active',
    installer,
  };
}

/**
 * Is this error (a WireSdkError, or any `{ code }` / `{ error: { code } }`
 * body) the refusal because an agent manages the container?
 */
export function isAgentManagedError(err: unknown): boolean {
  if (!isRecord(err) && !(err instanceof Error)) return false;
  const e = err as Record<string, unknown>;
  if (isAgentManagedCode(e.code)) return true;
  return isRecord(e.error) && isAgentManagedCode(e.error.code);
}

/**
 * The agent named by a managed-container refusal: from `managedBy` at the top
 * level, or in `details` / `error.details`. Null when the error is not that
 * refusal or names no agent.
 */
export function managedByFromError(err: unknown): WireManagedBy | null {
  if (!isAgentManagedError(err)) return null;
  const e = err as Record<string, unknown>;
  const nested = isRecord(e.error) ? e.error : null;
  const candidates = [
    e.managedBy,
    isRecord(e.details) ? e.details.managedBy : undefined,
    nested?.managedBy,
    nested && isRecord(nested.details) ? nested.details.managedBy : undefined,
  ];
  for (const c of candidates) {
    const m = readManagedBy(c);
    if (m) return m;
  }
  return null;
}
