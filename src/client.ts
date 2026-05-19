/**
 * WireClient — stateless connection manager for /api/v1/sdk/*.
 *
 * Surface (3 methods):
 *   - connect()    — open the connect screen, wait for the user to pick
 *                    a container, return the Connection. SDK does NOT
 *                    persist anything; caller keeps what they want.
 *   - getStatus()  — live snapshot of the active connection. Caller
 *                    supplies the apiKey from a prior Connection.
 *   - disconnect() — revoke the connection. Caller supplies the apiKey
 *                    from a prior Connection.
 *
 * To reuse the same install identity across connects, persist
 * Connection.deviceKey and pass it back via `new WireClient({ deviceKey })`.
 */
import { generateDeviceKey, signConnectJwt } from './crypto.js';
import {
  type Connection,
  type ConnectOptions,
  type DeviceKey,
  type StatusSnapshot,
  WireSdkError,
} from './types.js';

// Hardcoded — consumers never need a knob for this. For preview/dev loops,
// edit this constant in your local checkout and rebuild.
const API_BASE = 'https://app.usewire.io';
const DEFAULT_CONSENT_PATH = '/sdk/connect';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

export interface WireClientOptions {
  /** Agent id registered with Wire (e.g., 'wire-memory'). Required. */
  agentId: string;
  /**
   * Optional device key from a prior Connection. If provided, connect()
   * reuses this install identity. If omitted, a fresh keypair is
   * generated and returned to you on Connection.deviceKey.
   */
  deviceKey?: DeviceKey;
}

interface ConnectResponseData {
  nonce: string;
  user_code: string;
  expires_in: number;
  credential_id: string;
}

interface PollReadyData {
  status: 'ready';
  container_id: string;
  container_name: string;
  mcp_endpoint: string;
  api_endpoint: string;
  api_key: string;
  is_ephemeral: boolean;
  created_at: string | null;
  app_id: string;
  credential_id: string;
}
interface PollPending {
  status: 'pending';
}
interface PollExpired {
  status: 'expired';
}
type PollResponse = PollReadyData | PollPending | PollExpired;

interface StatusResponseData {
  container: {
    id: string;
    name: string;
    mcp_endpoint: string;
    organization_slug: string;
    is_ephemeral: boolean;
    created_at: string;
    ephemeral_expires_at: string | null;
  };
  connection: {
    id: string;
    connected_at: string;
    last_used_at: string | null;
    label: string | null;
  };
  app: { id: string; name: string; verified: boolean };
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export class WireClient {
  readonly agentId: string;
  private readonly providedDeviceKey: DeviceKey | null;

  constructor(options: WireClientOptions) {
    if (!options.agentId) throw new Error('WireClient: agentId is required');
    this.agentId = options.agentId;
    this.providedDeviceKey = options.deviceKey ?? null;
  }

  /**
   * Open the connect screen, wait for the user to pick a container,
   * return the Connection. The SDK persists nothing — keep whatever
   * fields you want from the result.
   */
  async connect(options: ConnectOptions = {}): Promise<Connection> {
    let deviceKey = this.providedDeviceKey;
    let isBootstrap = false;
    if (!deviceKey) {
      const fresh = await generateDeviceKey();
      deviceKey = { ...fresh, credentialId: '' };
      isBootstrap = true;
    }

    const nonce = generateNonce();

    const jwt = await signConnectJwt({
      agentId: this.agentId,
      privateJwk: deviceKey.privateJwk,
      credentialId: isBootstrap ? null : deviceKey.credentialId,
    });

    const connectBody: Record<string, unknown> = {
      nonce,
      label: options.label,
    };
    if (isBootstrap) connectBody.public_key = deviceKey.publicKey;

    const connectRes = await fetch(`${API_BASE}/api/v1/sdk/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(connectBody),
    });
    const connectData = await unwrap<ConnectResponseData>(connectRes);

    // Bake the assigned credentialId into the device key so it's
    // returned to the caller (and reusable in a future ctor call).
    deviceKey = { ...deviceKey, credentialId: connectData.credential_id };

    const consentUrl = `${API_BASE}${DEFAULT_CONSENT_PATH}`;
    if (options.onUserPrompt) {
      await options.onUserPrompt({ code: connectData.user_code, url: consentUrl });
    } else {
      await defaultUserPrompt(connectData.user_code, consentUrl);
    }

    const polled = await this.pollForReady(connectData.nonce);

    return {
      mcpUrl: polled.mcp_endpoint,
      apiUrl: polled.api_endpoint,
      apiKey: polled.api_key,
      containerId: polled.container_id,
      containerName: polled.container_name,
      orgSlug: deriveOrgSlug(polled.mcp_endpoint),
      expiresAt:
        polled.is_ephemeral && polled.created_at
          ? new Date(new Date(polled.created_at).getTime() + 7 * 24 * 60 * 60 * 1000)
          : null,
      agentId: polled.app_id,
      credentialId: polled.credential_id,
      deviceKey,
      connectedAt: new Date(),
      label: options.label,
    };
  }

  /** Live container + connection snapshot from /api/v1/sdk/status. */
  async getStatus(apiKey: string): Promise<StatusSnapshot> {
    if (!apiKey) throw new WireSdkError('NOT_CONNECTED', 'apiKey is required');
    const res = await fetch(`${API_BASE}/api/v1/sdk/status`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await unwrap<StatusResponseData>(res);
    return {
      container: {
        id: data.container.id,
        name: data.container.name,
        mcpEndpoint: data.container.mcp_endpoint,
        organizationSlug: data.container.organization_slug,
        isEphemeral: data.container.is_ephemeral,
        createdAt: new Date(data.container.created_at),
        ephemeralExpiresAt: data.container.ephemeral_expires_at
          ? new Date(data.container.ephemeral_expires_at)
          : null,
      },
      connection: {
        id: data.connection.id,
        connectedAt: new Date(data.connection.connected_at),
        lastUsedAt: data.connection.last_used_at
          ? new Date(data.connection.last_used_at)
          : null,
        label: data.connection.label,
      },
      agent: data.app,
    };
  }

  /**
   * Revoke the connection. Idempotent — calling with an already-revoked
   * apiKey is fine.
   */
  async disconnect(apiKey: string): Promise<void> {
    if (!apiKey) return;
    try {
      await fetch(`${API_BASE}/api/v1/sdk/connection`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch {
      // Network failure shouldn't block the caller.
    }
  }

  private async pollForReady(nonce: string): Promise<PollReadyData> {
    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      try {
        const res = await fetch(
          `${API_BASE}/api/v1/sdk/poll?nonce=${encodeURIComponent(nonce)}`
        );
        const data = (await res.json()) as PollResponse;
        if (data.status === 'ready') return data;
        if (data.status === 'expired') {
          throw new WireSdkError(
            'NONCE_EXPIRED',
            'Connection session expired. Please try again.'
          );
        }
      } catch (err) {
        if (err instanceof WireSdkError) throw err;
        // network blip — fall through to retry
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new WireSdkError(
      'POLL_TIMEOUT',
      'Connection timed out after 5 minutes. Please try again.'
    );
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function generateNonce(): string {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function deriveOrgSlug(mcpUrl: string): string | null {
  try {
    const url = new URL(mcpUrl);
    const m = url.host.match(/^([^.]+)\.mcp(?:-preview)?\.usewire\.io$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Default user-prompt handler used when ConnectOptions.onUserPrompt is
 * omitted. Prints the code and URL so they're always recoverable, and on
 * Node also spawns the OS browser opener. On web/Worker, the print is the
 * only behavior — those consumers should pass their own onUserPrompt.
 */
async function defaultUserPrompt(code: string, url: string): Promise<void> {
  console.log(`\nYour code: ${code}`);
  console.log(`Open: ${url}`);
  console.log(`Type the code on the connect screen to authorize this device.\n`);
  // Detect Node without statically importing node:* (browser bundlers stay clean).
  const proc = (
    globalThis as { process?: { versions?: { node?: string }; platform?: string } }
  ).process;
  if (!proc?.versions?.node) return;
  try {
    const { execFile } = await import('node:child_process');
    const cmd =
      proc.platform === 'darwin'
        ? 'open'
        : proc.platform === 'win32'
        ? 'start'
        : 'xdg-open';
    const child = execFile(cmd, [url], () => {
      // Best-effort. URL was already printed.
    });
    child.unref();
  } catch {
    // Best-effort. URL was already printed.
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.success || !json.data) {
    const code = json.error?.code ?? `HTTP_${res.status}`;
    const message = json.error?.message ?? `Request failed: ${res.status}`;
    throw new WireSdkError(code, message, res.status);
  }
  return json.data;
}
