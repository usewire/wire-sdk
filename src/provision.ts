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

function toContainer(data: ContainerWire): ProvisionedContainer {
  return {
    id: data.id,
    name: data.name,
    description: data.description ?? null,
    mcpUrl: data.mcp_endpoint ?? '',
    apiUrl: data.api_endpoint ?? '',
    createdAt: data.created_at ? new Date(data.created_at) : null,
  };
}

export class WireProvisionClient {
  private readonly apiKey: string;
  private readonly base: string;

  /** Manage this agent's provisioned containers. */
  readonly containers: {
    create(options?: { name?: string; description?: string }): Promise<ProvisionedContainer>;
    list(): Promise<ProvisionedContainer[]>;
    update(
      id: string,
      changes: { name?: string; description?: string | null }
    ): Promise<ProvisionedContainer>;
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

  private async createContainer(options: {
    name?: string;
    description?: string;
  }): Promise<ProvisionedContainer> {
    const data = await this.request<ContainerWire>(
      'POST',
      '/api/v1/agent/provision/containers',
      options
    );
    return toContainer(data);
  }

  private async listContainers(): Promise<ProvisionedContainer[]> {
    const data = await this.request<ContainerWire[]>('GET', '/api/v1/agent/provision/containers');
    return data.map(toContainer);
  }

  private async updateContainer(
    id: string,
    changes: { name?: string; description?: string | null }
  ): Promise<ProvisionedContainer> {
    const data = await this.request<ContainerWire>(
      'PATCH',
      `/api/v1/agent/provision/containers/${encodeURIComponent(id)}`,
      changes
    );
    // PATCH returns a summary without endpoints — refetch via containers.list()
    // if you need mcpUrl/apiUrl on the updated container.
    return toContainer(data);
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
