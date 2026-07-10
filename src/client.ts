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
  type BrowserConnectOptions,
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

// Browser connect (OAuth Authorization Code + PKCE)
const OAUTH_AUTHORIZE_PATH = '/api/auth/oauth2/authorize';
const OAUTH_TOKEN_PATH = '/api/auth/oauth2/token';
const OAUTH_SCOPE = 'containers:read containers:write';
const BROWSER_CONNECT_STORAGE_KEY = 'wire-sdk:browser-connect';
const BROWSER_CONNECT_MESSAGE_TYPE = 'wire-sdk:browser-connect-result';

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

    return connectionFromWireData(data, {
      deviceKey: pending.deviceKey,
      label: pending.label,
    });
  }

  /**
   * Browser-native connect (OAuth Authorization Code + PKCE). For agents
   * that run in the user's browser: no code to type, no second device.
   *
   * Redirect mode (default): navigates the current tab to the Wire
   * authorization screen; the user picks a container and lands back on
   * `redirectUri`, where your page calls completeConnectInBrowser() to
   * finish. The returned promise never resolves (the page navigates).
   *
   * Popup mode (`popup: true`): opens the authorization screen in a
   * popup; `redirectUri` must still be one of your registered URIs, and
   * that page still calls completeConnectInBrowser(), which relays the
   * result to this window. Resolves with the Connection.
   */
  async connectInBrowser(options: BrowserConnectOptions): Promise<Connection> {
    requireBrowser('connectInBrowser');
    if (!options?.redirectUri) {
      throw new WireSdkError('BAD_OPTIONS', 'redirectUri is required');
    }

    const verifier = generateRandomUrlSafe(48);
    const state = generateRandomUrlSafe(24);
    const challenge = await s256(verifier);

    const authorizeUrl = new URL(`${API_BASE}${OAUTH_AUTHORIZE_PATH}`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', this.agentId);
    authorizeUrl.searchParams.set('redirect_uri', options.redirectUri);
    authorizeUrl.searchParams.set('scope', OAUTH_SCOPE);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    if (!options.popup) {
      sessionStorage.setItem(
        BROWSER_CONNECT_STORAGE_KEY,
        JSON.stringify({ verifier, state, redirectUri: options.redirectUri, agentId: this.agentId })
      );
      location.assign(authorizeUrl.toString());
      // The page is navigating away; hold forever so callers can `await`.
      return new Promise<never>(() => {});
    }

    // Popup mode: the verifier stays in this window's memory; the popup's
    // callback page posts the code back via postMessage.
    const popup = window.open(authorizeUrl.toString(), 'wire-connect', 'width=480,height=720');
    if (!popup) {
      throw new WireSdkError('POPUP_BLOCKED', 'The browser blocked the connect popup');
    }

    const timeoutMs = options.timeoutMs ?? POLL_TIMEOUT_MS;
    const result = await new Promise<{ code: string }>((resolve, reject) => {
      const cleanup = () => {
        window.removeEventListener('message', onMessage);
        clearInterval(closedPoll);
        clearTimeout(timer);
      };
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== location.origin) return;
        const data = event.data as
          | { type?: string; code?: string; state?: string; error?: string }
          | undefined;
        if (data?.type !== BROWSER_CONNECT_MESSAGE_TYPE) return;
        cleanup();
        if (data.error) {
          reject(new WireSdkError('OAUTH_ERROR', data.error));
        } else if (data.state !== state || !data.code) {
          reject(new WireSdkError('STATE_MISMATCH', 'OAuth state did not match'));
        } else {
          resolve({ code: data.code });
        }
      };
      const closedPoll = setInterval(() => {
        if (popup.closed) {
          cleanup();
          reject(new WireSdkError('POPUP_CLOSED', 'The connect popup was closed'));
        }
      }, 500);
      const timer = setTimeout(() => {
        cleanup();
        popup.close();
        reject(new WireSdkError('POLL_TIMEOUT', 'Connect timed out. Please try again.'));
      }, timeoutMs);
      window.addEventListener('message', onMessage);
    });

    return this.exchangeBrowserCode(result.code, options.redirectUri, verifier);
  }

  /**
   * Finish a browser connect on your redirect page. Safe to call
   * unconditionally on page load:
   *
   * - Redirect mode: exchanges the code and returns the Connection
   *   (also scrubs code/state from the URL).
   * - Popup mode: relays the result to the opener window and closes the
   *   popup; returns null.
   * - No OAuth params in the URL: returns null.
   *
   * Throws OAUTH_ERROR if the user denied access.
   */
  async completeConnectInBrowser(): Promise<Connection | null> {
    requireBrowser('completeConnectInBrowser');
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    const state = params.get('state');
    const oauthError = params.get('error');
    if (!code && !oauthError) return null;

    const stashRaw = sessionStorage.getItem(BROWSER_CONNECT_STORAGE_KEY);

    // Popup child: no stash here (it lives in the opener) — relay and close.
    if (!stashRaw && window.opener) {
      (window.opener as Window).postMessage(
        {
          type: BROWSER_CONNECT_MESSAGE_TYPE,
          code,
          state,
          error: oauthError
            ? params.get('error_description') ?? oauthError
            : undefined,
        },
        location.origin
      );
      window.close();
      return null;
    }

    if (oauthError) {
      sessionStorage.removeItem(BROWSER_CONNECT_STORAGE_KEY);
      scrubOAuthParams();
      throw new WireSdkError(
        'OAUTH_ERROR',
        params.get('error_description') ?? oauthError
      );
    }
    if (!stashRaw) return null;

    const stash = JSON.parse(stashRaw) as {
      verifier: string;
      state: string;
      redirectUri: string;
      agentId: string;
    };
    if (stash.state !== state) {
      throw new WireSdkError('STATE_MISMATCH', 'OAuth state did not match');
    }

    const connection = await this.exchangeBrowserCode(
      code!,
      stash.redirectUri,
      stash.verifier
    );
    sessionStorage.removeItem(BROWSER_CONNECT_STORAGE_KEY);
    scrubOAuthParams();
    return connection;
  }

  private async exchangeBrowserCode(
    code: string,
    redirectUri: string,
    codeVerifier: string
  ): Promise<Connection> {
    const res = await fetch(`${API_BASE}${OAUTH_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.agentId,
        code_verifier: codeVerifier,
      }),
    });
    const json = (await res.json()) as {
      error?: string;
      error_description?: string;
      connection?: {
        container_id: string;
        container_name: string;
        mcp_endpoint: string;
        api_endpoint: string;
        api_key: string;
        is_ephemeral: boolean;
        created_at: string | null;
        app_id: string;
        credential_id: string;
      };
    };
    if (!res.ok || json.error) {
      throw new WireSdkError(
        'OAUTH_ERROR',
        json.error_description ?? json.error ?? `Token exchange failed: ${res.status}`,
        res.status
      );
    }
    if (!json.connection) {
      throw new WireSdkError(
        'NO_CONNECTION',
        'Token exchange succeeded but no connection was returned. Is this agent registered for browser connects?'
      );
    }
    return connectionFromWireData(json.connection, {});
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

/** Map the server's snake_case connection payload to a Connection. */
function connectionFromWireData(
  data: {
    container_id: string;
    container_name: string;
    mcp_endpoint: string;
    api_endpoint: string;
    api_key: string;
    is_ephemeral: boolean;
    created_at: string | null;
    app_id: string;
    credential_id: string;
  },
  extras: { deviceKey?: DeviceKey; label?: string }
): Connection {
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
    deviceKey: extras.deviceKey,
    connectedAt: new Date(),
    label: extras.label,
  };
}

function requireBrowser(method: string): void {
  if (typeof window === 'undefined' || typeof location === 'undefined') {
    throw new WireSdkError(
      'NOT_BROWSER',
      `${method}() only works in a browser. Use connect() elsewhere.`
    );
  }
}

/** Random base64url string of `bytes` random bytes (RFC 7636 verifier-safe). */
function generateRandomUrlSafe(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** S256 PKCE challenge, base64url. */
async function s256(verifier: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  );
  return btoa(String.fromCharCode(...hash))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Remove OAuth params from the current URL without a reload. */
function scrubOAuthParams(): void {
  try {
    const url = new URL(location.href);
    for (const p of ['code', 'state', 'error', 'error_description', 'iss']) {
      url.searchParams.delete(p);
    }
    history.replaceState(null, '', url.toString());
  } catch {
    // Cosmetic only.
  }
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
