/**
 * WireAgentEndpoint: your server calls YOUR AGENT'S TOOLS as a signed-in
 * person, over plain HTTPS.
 *
 * Every agent has one endpoint, on its own hostname
 * (`https://{agent-id}.agent.usewire.io`). Besides `/mcp`, which AI clients
 * use, it serves two REST paths:
 *
 *   GET  /tools           the tools this person's sign-in may call   listTools
 *   POST /tools/{name}    call one                                   callTool
 *
 * Nothing else is served there, and your app never needs a container URL or id:
 * Wire finds the person's container from the access token.
 *
 * The access token is the one `WireSignIn` handed you for that person. What it
 * may do is the `access.level` of your manifest: at `read`, only your tools
 * that do not change a record are listed and callable; at `write`, all of
 * them; at `none`, none.
 *
 * THIS RUNS ON YOUR SERVER, where the access token is. Do not send an access
 * token to a browser to call these paths from there.
 *
 * A tool call is billed like the same call over MCP.
 */
import { WireSdkError } from '../types.js';

const AGENT_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** One tool as the endpoint lists it: the same fields an MCP `tools/list` carries. */
export interface WireEndpointTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; [k: string]: unknown };
  /** The MCP Apps view that renders the tool's result, when it has one. */
  ui?: Record<string, unknown>;
}

export type WireEndpointErrorCode =
  /** A constructor or call argument is missing or malformed. */
  | 'INVALID_ARGUMENT'
  /** The access token is not accepted (expired, revoked, or the person disconnected). Refresh it, or sign the person in again. */
  | 'UNAUTHORIZED'
  /** The endpoint has no such path or tool name shape. */
  | 'NOT_FOUND'
  /** The tool refused the call: unknown tool, not allowed at your access level, bad arguments. `message` says which. Not retryable as is. */
  | 'TOOL_REFUSED'
  /** The payer has no credits for this call. */
  | 'INSUFFICIENT_CREDITS'
  /** Wire could not serve the call right now (5xx, 429, a container starting). Try again. */
  | 'UNAVAILABLE'
  /** Wire's answer was not the shape this client reads. */
  | 'UNEXPECTED_RESPONSE'
  /** The request did not reach Wire. */
  | 'NETWORK_ERROR';

/** A call to your agent's endpoint failed. `retryable`: the same call may succeed later. */
export class WireEndpointError extends WireSdkError {
  readonly retryable: boolean;
  /** Seconds Wire asked you to wait, when it said. */
  readonly retryAfterSec: number | null;
  constructor(code: WireEndpointErrorCode, message: string, status?: number, details?: unknown, options?: { cause?: unknown; retryAfterSec?: number | null }) {
    super(code, message, status, details);
    this.name = 'WireEndpointError';
    this.retryable = code === 'UNAVAILABLE' || code === 'NETWORK_ERROR';
    this.retryAfterSec = options?.retryAfterSec ?? null;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export interface WireAgentEndpointOptions {
  /** Your agent's id. The endpoint is `https://{agentId}.agent.usewire.io` unless `endpoint` says otherwise. */
  agentId: string;
  /**
   * The endpoint's origin, when it is not the default: your agent's custom
   * hostname (`https://mcp.yourapp.com`), or preview
   * (`https://{agentId}.agent-preview.usewire.io`). No path.
   */
  endpoint?: string;
  /** A fetch to use instead of the global one. */
  fetch?: typeof fetch;
}

/** A tool call's answer: the tool's result data, as the tool defines it. */
export interface WireToolResult<T = unknown> {
  /** The result. For one of your own tools, its `result` mapping (or the base tool's result when it has none). */
  data: T;
  /** The ids of the entries the call touched, when the tool reports them. */
  resultIds?: string[];
  /** View-only data for an MCP Apps view, when the tool has any. */
  viewMeta?: Record<string, unknown>;
}

export class WireAgentEndpoint {
  readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WireAgentEndpointOptions) {
    if (!options || typeof options.agentId !== 'string' || !AGENT_ID_RE.test(options.agentId)) {
      throw new WireEndpointError('INVALID_ARGUMENT', 'agentId must be your agent id (lowercase letters, digits and hyphens)');
    }
    let origin: URL;
    try {
      origin = new URL(options.endpoint ?? `https://${options.agentId}.agent.usewire.io`);
    } catch {
      throw new WireEndpointError('INVALID_ARGUMENT', 'endpoint must be an absolute URL');
    }
    const local = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1';
    if (origin.protocol !== 'https:' && !local) throw new WireEndpointError('INVALID_ARGUMENT', 'endpoint must be https: it carries an access token');
    if (origin.pathname !== '/' || origin.search || origin.hash) {
      throw new WireEndpointError('INVALID_ARGUMENT', 'endpoint is an origin (https://host), with no path: this client adds /tools');
    }
    this.origin = origin.origin;
    this.fetchImpl = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  /** The tools this person's sign-in may call. Empty at access level `none`. */
  async listTools(accessToken: string): Promise<WireEndpointTool[]> {
    const res = await this.send('GET', '/tools', accessToken);
    const json = await this.read(res);
    const tools = (json as { tools?: unknown } | null)?.tools;
    if (!Array.isArray(tools) || tools.some((t) => !t || typeof t !== 'object' || typeof (t as { name?: unknown }).name !== 'string')) {
      throw new WireEndpointError('UNEXPECTED_RESPONSE', "Wire's tool list was not the shape this client reads", res.status);
    }
    return tools as WireEndpointTool[];
  }

  /**
   * Call one tool as this person. `name` is the tool's name as your manifest
   * (and `listTools`) gives it. `args` is the tool's input.
   *
   * Throws `TOOL_REFUSED` when the tool says no (not allowed at your access
   * level, unknown, bad arguments), with the tool's own message.
   */
  async callTool<T = unknown>(accessToken: string, name: string, args: Record<string, unknown> = {}): Promise<WireToolResult<T>> {
    if (typeof name !== 'string' || !TOOL_NAME_RE.test(name) || name === 'mcp') {
      throw new WireEndpointError('INVALID_ARGUMENT', 'name must be a tool name (letters, digits, "_" and "-")');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new WireEndpointError('INVALID_ARGUMENT', 'args must be an object');
    const res = await this.send('POST', `/tools/${name}`, accessToken, JSON.stringify(args));
    const json = (await this.read(res)) as { ok?: unknown; data?: unknown; resultIds?: unknown; _meta?: { view?: unknown } } | null;
    if (!json || typeof json !== 'object' || json.ok !== true) {
      throw new WireEndpointError('UNEXPECTED_RESPONSE', "Wire's tool answer was not the shape this client reads", res.status);
    }
    const meta = json._meta;
    const view = meta && typeof meta === 'object' && meta.view && typeof meta.view === 'object' ? (meta.view as Record<string, unknown>) : undefined;
    const ids = Array.isArray(json.resultIds) && json.resultIds.every((i) => typeof i === 'string') ? (json.resultIds as string[]) : undefined;
    return { data: json.data as T, ...(ids ? { resultIds: ids } : {}), ...(view ? { viewMeta: view } : {}) };
  }

  private async send(method: 'GET' | 'POST', path: string, accessToken: string, body?: string): Promise<Response> {
    if (typeof accessToken !== 'string' || !accessToken || /\s/.test(accessToken)) {
      throw new WireEndpointError('INVALID_ARGUMENT', 'accessToken is required: the one WireSignIn handed you for this person');
    }
    try {
      return await this.fetchImpl(this.origin + path, {
        method,
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body } : {}),
        redirect: 'error',
      });
    } catch (e) {
      throw new WireEndpointError('NETWORK_ERROR', 'the request did not reach Wire', undefined, undefined, { cause: e });
    }
  }

  /** The JSON of a good answer, or the error a bad one is. */
  private async read(res: Response): Promise<unknown> {
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return json;
    const said = (k: string): string | undefined => (json && typeof json[k] === 'string' && json[k] ? (json[k] as string) : undefined);
    const message = said('message') ?? said('error_description') ?? said('error') ?? `Wire answered ${res.status}`;
    const retryAfter = Number(res.headers.get('retry-after'));
    const retryAfterSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
    if (res.status === 401) throw new WireEndpointError('UNAUTHORIZED', message, 401, json);
    if (res.status === 402) throw new WireEndpointError('INSUFFICIENT_CREDITS', message, 402, json);
    if (res.status === 404) throw new WireEndpointError('NOT_FOUND', message, 404, json);
    if (res.status === 429 || res.status >= 500) throw new WireEndpointError('UNAVAILABLE', message, res.status, json, { retryAfterSec });
    // 400 from a tool call is the tool saying no: { ok: false, error }.
    throw new WireEndpointError('TOOL_REFUSED', message, res.status, json);
  }
}
