/**
 * Public types exported by @usewire/sdk.
 *
 * Wire format mirrors the server's /api/v1/sdk/* responses. Keep these in
 * sync with the OpenAPI spec, which is the canonical contract.
 */

export interface DeviceKey {
  /** Identifier for this install, assigned on first connect. */
  credentialId: string;
  /** Ed25519 public key, base64url-encoded raw 32 bytes. */
  publicKey: string;
  /** Ed25519 private key as JWK (kty='OKP', crv='Ed25519', d, x). */
  privateJwk: JsonWebKey;
}

/**
 * Result of a successful connect(). The SDK does not persist anything;
 * the caller decides which fields to keep, where, for how long.
 *
 * For typical agent use, the only fields you need at runtime are
 * `mcpUrl` and `apiKey`. Persist `deviceKey` if you want a future
 * connect() to reuse the same install identity.
 */
export interface Connection {
  /** MCP endpoint for the chosen container. Bearer auth with apiKey. */
  mcpUrl: string;
  /** REST API base for the chosen container. Same auth as mcpUrl. */
  apiUrl: string;
  /** Better Auth API key scoped to this container. */
  apiKey: string;

  containerId: string;
  containerName: string;
  /** Org slug, derived from mcpUrl host. */
  orgSlug: string | null;
  /**
   * For ephemeral (non-claimed) orgs, the date the org expires. Null for
   * claimed/permanent containers.
   */
  expiresAt: Date | null;

  /** App id this connection was made under. */
  appId: string;
  /** Identifier for this install, useful for audit. */
  credentialId: string;
  /**
   * Device key used for this connect. Persist this if you want a future
   * connect() to reuse the same install identity, then pass it back via
   * `new WireClient({ deviceKey })`.
   */
  deviceKey: DeviceKey;

  connectedAt: Date;
  label?: string;
}

export interface ConnectOptions {
  /** Optional device label, e.g. "Jitpal's MacBook". */
  label?: string;
  /**
   * Called with the prompt the user needs to act on:
   * - `code`: the short code (e.g. "BFXR-9243") the user types into the
   *   connect screen. This is what binds this connect flow to the device
   *   the user is actually on.
   * - `url`: the connect-screen URL.
   *
   * If omitted, the SDK prints both to stdout and tries to spawn the OS
   * browser opener (Node only). Web/Worker consumers should provide their
   * own handler.
   */
  onUserPrompt?: (params: { code: string; url: string }) => void | Promise<void>;
}

export interface StatusSnapshot {
  container: {
    id: string;
    name: string;
    mcpEndpoint: string;
    organizationSlug: string;
    isEphemeral: boolean;
    createdAt: Date;
    ephemeralExpiresAt: Date | null;
  };
  connection: {
    id: string;
    connectedAt: Date;
    lastUsedAt: Date | null;
    label: string | null;
  };
  app: {
    id: string;
    name: string;
    verified: boolean;
  };
}

export class WireSdkError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number
  ) {
    super(message);
    this.name = 'WireSdkError';
  }
}
