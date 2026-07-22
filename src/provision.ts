/**
 * Provision mode (SUP-842).
 *
 * A different principal from WireClient: no end user, no device identity, no
 * consent handshake. Your backend holds a long-lived ORG API key (generated on
 * a provision-mode agent in the Wire dashboard) and manages containers in your
 * own organization. The same key authenticates the agent on each provisioned
 * container's MCP endpoint, so there is no second credential to mint.
 *
 * const wire = new WireProvisionClient({ apiKey: process.env.WIRE_PROVISION_KEY });
 * const container = await wire.containers.create({ name: 'customer-1234' });
 * // container.mcpUrl + the same apiKey go to your agent's MCP client
 *
 * Cases (SUP-546): isolated scopes under a container for repeatable work —
 * one case per return, ticket, or claim, all sharing the container's context.
 *
 * const kase = container.case('return-4821');
 * await kase.write({ content: { request: 'refund', daysSinceDelivery: 45 } });
 * const hits = await kase.search({ query: 'refund window policy' });
 * const open = await container.cases.list({ status: 'active' });
 */
import { WireSdkError } from './types.js';

const API_BASE = 'https://app.usewire.io';

export interface WireProvisionClientOptions {
  /** Org API key from a provision-mode agent (shown once at generation). */
  apiKey: string;
  /** Override the API origin (self-hosted / preview). Defaults to app.usewire.io. */
  baseUrl?: string;
}

/** A container provisioned by this agent. */
export interface ProvisionedContainer {
  id: string;
  name: string;
  description: string | null;
  /** MCP endpoint — authenticate with the same org API key. */
  mcpUrl: string;
  /** REST endpoint root for this container. */
  apiUrl: string;
  createdAt: Date | null;
}

/** Registry metadata for one case on a provisioned container (SUP-546). */
export interface CaseSummary {
  id: string;
  status: string;
  entryCount: number;
  sizeBytes: number;
  createdAt: Date | null;
  lastActiveAt: Date | null;
  closedAt: Date | null;
  retentionClass: string;
}

export interface CaseListResult {
  cases: CaseSummary[];
  total: number;
  counts: { active: number; closed: number; all: number };
}

/** The result of a tool call on a case — the tool's JSON payload as returned
 *  by the container. Shapes are documented per tool at docs.usewire.io. */
export type CaseToolResult = Record<string, unknown>;

export interface ProvisionIdentity {
  organizationId: string;
  agentId: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface ContainerWire {
  id: string;
  name: string;
  description?: string | null;
  mcp_endpoint?: string;
  api_endpoint?: string;
  created_at?: string;
}

interface CaseWire {
  id: string;
  status: string;
  entry_count: number;
  size_bytes: number;
  created_at: number | null;
  last_active_at: number | null;
  closed_at: number | null;
  retention_class: string;
}

function toCaseSummary(data: CaseWire): CaseSummary {
  return {
    id: data.id,
    status: data.status,
    entryCount: data.entry_count,
    sizeBytes: data.size_bytes,
    createdAt: data.created_at ? new Date(data.created_at) : null,
    lastActiveAt: data.last_active_at ? new Date(data.last_active_at) : null,
    closedAt: data.closed_at ? new Date(data.closed_at) : null,
    retentionClass: data.retention_class,
  };
}

// Mirrors the platform's case-id gate so a bad id fails here with a clear
// message instead of as a 400 from the API.
const SAFE_CASE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const assertCaseId = (id: string): void => {
  if (!SAFE_CASE_ID.test(id) || id === '.' || id === '..') {
    throw new WireSdkError(
      'INVALID_CASE_ID',
      'Case ids are 1-128 characters of letters, digits, ".", "_" or "-"'
    );
  }
};

/**
 * A handle on one case of a provisioned container. Cases are isolated scopes
 * under the container: reads merge the container's shared context with the
 * case's own entries; writes land in the case only. The case auto-creates on
 * first write (inheriting the container's retention default) — there is no
 * separate create step.
 */
export class WireCase {
  constructor(
    /** Case id — your unit of work's natural key (ticket, return, claim id). */
    readonly id: string,
    private readonly apiUrl: string,
    private readonly apiKey: string
  ) {}

  /** Append an entry to this case. Auto-creates the case on first write. */
  write(args: { content: unknown; tags?: string[] } & Record<string, unknown>): Promise<CaseToolResult> {
    return this.tool('write', args);
  }

  /** Chronological/list reads over the case (merged with shared context). */
  explore(args: Record<string, unknown> = {}): Promise<CaseToolResult> {
    return this.tool('explore', args);
  }

  /** Retrieval over the case + the container's shared context. */
  search(args: { query: string } & Record<string, unknown>): Promise<CaseToolResult> {
    return this.tool('search', args);
  }

  /** Relationship traversal from an entry. */
  navigate(args: Record<string, unknown>): Promise<CaseToolResult> {
    return this.tool('navigate', args);
  }

  private async tool(name: string, args: Record<string, unknown>): Promise<CaseToolResult> {
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}/s/${encodeURIComponent(this.id)}/api/tools/${name}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
      });
    } catch (err) {
      throw new WireSdkError(
        'NETWORK_ERROR',
        `Wire container unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    let data: Record<string, unknown> | null = null;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      // non-JSON error body
    }
    if (!res.ok) {
      const message =
        (data && typeof data.error === 'string' && data.error) ||
        `Case ${name} failed (${res.status} ${res.statusText})`;
      throw new WireSdkError('CASE_TOOL_ERROR', message, res.status);
    }
    return data ?? {};
  }
}

/** A provisioned container plus its case surface. Field-compatible with the
 *  plain {@link ProvisionedContainer} shape earlier releases returned. */
export class ProvisionedContainerHandle implements ProvisionedContainer {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly mcpUrl: string;
  readonly apiUrl: string;
  readonly createdAt: Date | null;

  /** Enumerate this container's cases (registry metadata, never content). */
  readonly cases: {
    list(options?: {
      status?: 'active' | 'closed';
      search?: string;
      limit?: number;
      offset?: number;
    }): Promise<CaseListResult>;
    get(caseId: string): Promise<CaseSummary>;
  };

  constructor(
    fields: ProvisionedContainer,
    private readonly apiKey: string,
    private readonly controlRequest: <T>(method: string, path: string) => Promise<T>
  ) {
    this.id = fields.id;
    this.name = fields.name;
    this.description = fields.description;
    this.mcpUrl = fields.mcpUrl;
    this.apiUrl = fields.apiUrl;
    this.createdAt = fields.createdAt;
    this.cases = {
      list: (options = {}) => this.listCases(options),
      get: (caseId) => this.getCase(caseId),
    };
  }

  /** A handle on one case. Data ops hit the container directly; the case
   *  auto-creates on first write. */
  case(caseId: string): WireCase {
    assertCaseId(caseId);
    if (!this.apiUrl) {
      throw new WireSdkError(
        'NO_API_ENDPOINT',
        'This container handle has no API endpoint — refetch it with containers.list()'
      );
    }
    return new WireCase(caseId, this.apiUrl, this.apiKey);
  }

  private async listCases(options: {
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<CaseListResult> {
    const q = new URLSearchParams();
    for (const k of ['status', 'search', 'limit', 'offset'] as const) {
      const v = options[k];
      if (v !== undefined) q.set(k, String(v));
    }
    const data = await this.controlRequest<{
      cases: CaseWire[];
      total: number;
      counts: { active: number; closed: number; all: number };
    }>(
      'GET',
      `/api/v1/agent/provision/containers/${encodeURIComponent(this.id)}/cases${q.size ? `?${q}` : ''}`
    );
    return { cases: data.cases.map(toCaseSummary), total: data.total, counts: data.counts };
  }

  private async getCase(caseId: string): Promise<CaseSummary> {
    assertCaseId(caseId);
    const data = await this.controlRequest<CaseWire>(
      'GET',
      `/api/v1/agent/provision/containers/${encodeURIComponent(this.id)}/cases/${encodeURIComponent(caseId)}`
    );
    return toCaseSummary(data);
  }
}

export class WireProvisionClient {
  private readonly apiKey: string;
  private readonly base: string;

  /** Manage this agent's provisioned containers. */
  readonly containers: {
    create(options?: { name?: string; description?: string }): Promise<ProvisionedContainerHandle>;
    list(): Promise<ProvisionedContainerHandle[]>;
    update(
      id: string,
      changes: { name?: string; description?: string | null }
    ): Promise<ProvisionedContainerHandle>;
    delete(id: string): Promise<void>;
  };

  constructor(options: WireProvisionClientOptions) {
    if (!options.apiKey) throw new Error('WireProvisionClient: apiKey is required');
    this.apiKey = options.apiKey;
    this.base = (options.baseUrl ?? API_BASE).replace(/\/$/, '');

    this.containers = {
      create: (opts = {}) => this.createContainer(opts),
      list: () => this.listContainers(),
      update: (id, changes) => this.updateContainer(id, changes),
      delete: (id) => this.deleteContainer(id),
    };
  }

  /** Verify the key and return the org + agent it acts as. */
  async whoami(): Promise<ProvisionIdentity> {
    const data = await this.request<{ organization_id: string; agent_id: string }>(
      'GET',
      '/api/v1/agent/provision/whoami'
    );
    return { organizationId: data.organization_id, agentId: data.agent_id };
  }

  private toHandle(data: ContainerWire): ProvisionedContainerHandle {
    return new ProvisionedContainerHandle(
      {
        id: data.id,
        name: data.name,
        description: data.description ?? null,
        mcpUrl: data.mcp_endpoint ?? '',
        apiUrl: data.api_endpoint ?? '',
        createdAt: data.created_at ? new Date(data.created_at) : null,
      },
      this.apiKey,
      (method, path) => this.request(method, path)
    );
  }

  private async createContainer(options: {
    name?: string;
    description?: string;
  }): Promise<ProvisionedContainerHandle> {
    const data = await this.request<ContainerWire>(
      'POST',
      '/api/v1/agent/provision/containers',
      options
    );
    return this.toHandle(data);
  }

  private async listContainers(): Promise<ProvisionedContainerHandle[]> {
    const data = await this.request<ContainerWire[]>('GET', '/api/v1/agent/provision/containers');
    return data.map((d) => this.toHandle(d));
  }

  private async updateContainer(
    id: string,
    changes: { name?: string; description?: string | null }
  ): Promise<ProvisionedContainerHandle> {
    const data = await this.request<ContainerWire>(
      'PATCH',
      `/api/v1/agent/provision/containers/${encodeURIComponent(id)}`,
      changes
    );
    // PATCH returns a summary without endpoints — case data ops on this handle
    // need a refetch via containers.list(); cases.list()/get() work regardless.
    return this.toHandle(data);
  }

  private async deleteContainer(id: string): Promise<void> {
    await this.request<unknown>(
      'DELETE',
      `/api/v1/agent/provision/containers/${encodeURIComponent(id)}`
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new WireSdkError(
        'NETWORK_ERROR',
        `Wire API unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    let envelope: ApiEnvelope<T> | null = null;
    try {
      envelope = (await res.json()) as ApiEnvelope<T>;
    } catch {
      // fall through — non-JSON error body
    }

    if (!res.ok || !envelope?.success) {
      const code = envelope?.error?.code ?? (res.status === 401 ? 'UNAUTHORIZED' : 'API_ERROR');
      const message =
        envelope?.error?.message ?? `Wire API request failed (${res.status} ${res.statusText})`;
      throw new WireSdkError(code, message, res.status);
    }
    return envelope.data as T;
  }
}
