/**
 * WireClient — stateless connection manager for /api/v1/sdk/*.
 *
 * Two layers:
 *
 * Blocking conveniences (prompt the user, wait for them to finish):
 *   - connect()    — open the connect screen, wait for the user to pick
 *                    a container, return the Connection. SDK does NOT
 *                    persist anything; caller keeps what they want.
 *   - claim()      — upgrade an ephemeral container to permanent: mint a
 *                    claim URL, surface it to the user, poll until the
 *                    sign-up completes.
 *
 * Non-blocking primitives (for turn-based agents that can't hold a
 * promise open while the user acts — persist the handle, check later):
 *   - beginConnect()    — start the handshake, return the code + URL +
 *                         a PendingConnection handle.
 *   - checkConnection() — single poll of a pending handshake; Connection
 *                         when ready, null while pending.
 *   - getClaimUrl()     — mint the claim link, nothing else. Detect
 *                         completion via getStatus().container.isEphemeral.
 *
 * Single-shot:
 *   - getStatus()  — live snapshot of the active connection.
 *   - disconnect() — revoke the connection.
 *
 * To reuse the same install identity across connects, persist
 * Connection.deviceKey and pass it back via `new WireClient({ deviceKey })`.
 */
import { generateDeviceKey, signConnectJwt } from './crypto.js';
import {
  type ClaimLink,
  type ClaimOptions,
  type ClaimResult,
  type Connection,
  type ConnectOptions,
  type DeviceKey,
  type PendingConnection,
  type StatusSnapshot,
  WireSdkError,
} from './types.js';

// Hardcoded — consumers never need a knob for this. For preview/dev loops,
// edit this constant in your local checkout and rebuild.
const API_BASE = 'https://app.usewire.io';
const DEFAULT_CONSENT_PATH = '/sdk/connect';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

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
   *
   * Convenience wrapper over beginConnect() + checkConnection(); use
   * those directly if you can't block while the user acts.
   */
  async connect(options: ConnectOptions = {}): Promise<Connection> {
    const pending = await this.beginConnect(options);

    if (options.onUserPrompt) {
      await options.onUserPrompt({ code: pending.userCode, url: pending.url });
    } else {
      await defaultUserPrompt(pending.userCode, pending.url);
    }

    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      try {
        const connection = await this.checkConnection(pending);
        if (connection) return connection;
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

  /**
   * Start a connect handshake without blocking: registers the device
   * (bootstrap) or reuses the install identity, and returns the code +
   * URL to put in front of the user plus a PendingConnection handle.
   * Persist the handle and call checkConnection() until it resolves —
   * or just use connect(), which does the waiting for you.
   */
  async beginConnect(options: ConnectOptions = {}): Promise<PendingConnection> {
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

    return {
      userCode: connectData.user_code,
      url: `${API_BASE}${DEFAULT_CONSENT_PATH}`,
      nonce: connectData.nonce,
      // Bake the assigned credentialId into the device key so it's
      // persistable from the handle (and reusable in a future ctor call).
      deviceKey: { ...deviceKey, credentialId: connectData.credential_id },
      expiresAt: new Date(Date.now() + connectData.expires_in * 1000),
      label: options.label,
    };
  }

  /**
   * Single non-blocking poll of a pending handshake. Returns the
   * Connection once the user has picked a container, null while they
   * haven't yet, and throws NONCE_EXPIRED once the handshake lapses.
   */
  async checkConnection(pending: PendingConnection): Promise<Connection | null> {
    const res = await fetch(
      `${API_BASE}/api/v1/sdk/poll?nonce=${encodeURIComponent(pending.nonce)}`
    );
    const data = (await res.json()) as PollResponse;
    if (data.status === 'pending') return null;
    if (data.status === 'expired') {
      throw new WireSdkError(
        'NONCE_EXPIRED',
        'Connection session expired. Please try again.'
      );
    }

    return {
      mcpUrl: data.mcp_endpoint,
      apiUrl: data.api_endpoint,
      apiKey: data.api_key,
      containerId: data.container_id,
      containerName: data.container_name,
      orgSlug: deriveOrgSlug(data.mcp_endpoint),
      expiresAt:
        data.is_ephemeral && data.created_at
          ? new Date(new Date(data.created_at).getTime() + 7 * 24 * 60 * 60 * 1000)
          : null,
      agentId: data.app_id,
      credentialId: data.credential_id,
      deviceKey: pending.deviceKey,
      connectedAt: new Date(),
      label: pending.label,
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
   * Upgrade an ephemeral container to permanent. Mints a claim URL, hands
   * it to the user (via onUserPrompt or the default print + browser-open),
   * then polls getStatus() until the container stops being ephemeral.
   *
   * Idempotent: if the container is already claimed, resolves immediately
   * with the current snapshot. On timeout the claim URL stays valid for
   * 30 minutes — the user can still finish in the browser, and a later
   * getStatus() will reflect it.
   */
  async claim(apiKey: string, options: ClaimOptions = {}): Promise<ClaimResult> {
    let link: ClaimLink;
    try {
      link = await this.getClaimUrl(apiKey);
    } catch (err) {
      if (err instanceof WireSdkError && err.code === 'ALREADY_CLAIMED') {
        const snapshot = await this.getStatus(apiKey);
        return { ...snapshot, expiresAt: snapshot.container.ephemeralExpiresAt };
      }
      throw err;
    }

    if (options.onUserPrompt) {
      await options.onUserPrompt({ url: link.url });
    } else {
      console.log(`\nSign up to keep your container: ${link.url}\n`);
      await openInOsBrowser(link.url);
    }

    const timeoutMs = options.timeoutMs ?? CLAIM_TIMEOUT_MS;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const snapshot = await this.getStatus(apiKey);
        if (!snapshot.container.isEphemeral) {
          return { ...snapshot, expiresAt: null };
        }
      } catch (err) {
        if (err instanceof WireSdkError && err.status === 401) throw err;
        // transient — fall through to retry
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new WireSdkError(
      'CLAIM_TIMEOUT',
      `Claim not completed within ${Math.round(timeoutMs / 60000)} minutes. ` +
        'The claim link stays valid for 30 minutes — once the user finishes ' +
        'sign-up, getStatus() will show the container as permanent.'
    );
  }

  /**
   * Mint a claim link for this connection's ephemeral container, nothing
   * else — no prompt, no waiting. Put the URL in front of the user
   * however fits your surface; detect completion on your own schedule
   * via getStatus().container.isEphemeral flipping false. Throws
   * ALREADY_CLAIMED if the container is already permanent.
   */
  async getClaimUrl(apiKey: string): Promise<ClaimLink> {
    if (!apiKey) throw new WireSdkError('NOT_CONNECTED', 'apiKey is required');
    const res = await fetch(`${API_BASE}/api/v1/sdk/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await unwrap<{ claim_url: string; expires_in_seconds: number }>(res);
    return {
      url: data.claim_url,
      expiresAt: new Date(Date.now() + data.expires_in_seconds * 1000),
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
  await openInOsBrowser(url);
}

/**
 * Best-effort OS browser open on Node; no-op elsewhere. Detects Node
 * without statically importing node:* (browser bundlers stay clean).
 */
async function openInOsBrowser(url: string): Promise<void> {
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
