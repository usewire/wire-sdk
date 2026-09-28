/**
 * WireAgentClient: an agent's server reads and uninstalls ITS OWN installs
 * (SUP-958), holding no user's API key.
 *
 *   GET    /api/v1/agents/{agentId}/installs/{installId}           getInstall
 *   GET    /api/v1/agents/{agentId}/users/{agentUserId}/installs   listInstalls
 *   DELETE /api/v1/agents/{agentId}/installs/{installId}           revokeInstall (uninstalls)
 *
 * Every request carries a fresh EdDSA JWT signed with one of the agent's
 * RUNTIME keys (registered with `purpose: "runtime"`; a publish key is refused
 * here, and a runtime key is refused for manifest registration):
 *
 *   header       { alg: "EdDSA", kid: <runtime key id> }
 *   iss          the agent id
 *   aud          "wire-agent-api" (Wire also accepts the pre-0.10 "wire-app-api")
 *   iat, exp     exp = iat + 60
 *   jti          random, single use
 *   body_sha256  DELETE only: base64url SHA-256 of the exact body (empty here)
 *
 * Before 0.10 this was WireAppClient, calling `/api/v1/apps/{appId}/...` with
 * `aud: "wire-app-api"`. Wire still answers those paths (marked deprecated), so
 * an older SDK keeps working; `apiVersion: 'apps'` selects them here too, for a
 * Wire deployment that predates the agent paths. Runs anywhere with Web
 * Crypto and fetch: Cloudflare Workers, Node 18+, Bun, Deno.
 */
import { importJWK, SignJWT } from 'jose';
import { generateDeviceKey, randomJti } from '../crypto.js';
import { WireAgentApiError } from './errors.js';
import { InstallShapeError, installFromWire, type WireInstall } from './installs.js';
import { sha256Base64Url } from './verify.js';

/** The `aud` of an agent API token. */
export const AGENT_API_AUDIENCE = 'wire-agent-api';
/** Lifetime of an agent API token, seconds (Wire accepts at most 60). */
export const AGENT_API_TOKEN_LIFETIME_SEC = 60;
/** The body-hash claim on a DELETE. */
export const AGENT_API_BODY_HASH_CLAIM = 'body_sha256';

/** @deprecated The pre-0.10 audience, still accepted by Wire. The client signs `AGENT_API_AUDIENCE` unless `apiVersion: 'apps'`. */
export const APP_API_AUDIENCE = 'wire-app-api';
/** @deprecated Use `AGENT_API_TOKEN_LIFETIME_SEC`. */
export const APP_API_TOKEN_LIFETIME_SEC = AGENT_API_TOKEN_LIFETIME_SEC;
/** @deprecated Use `AGENT_API_BODY_HASH_CLAIM`. */
export const APP_API_BODY_HASH_CLAIM = AGENT_API_BODY_HASH_CLAIM;

const DEFAULT_BASE_URL = 'https://app.usewire.io';
const AGENT_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A runtime key: the private half, and the key id (`pk_…`) Wire assigned when it was registered. */
export interface WireRuntimeKey {
  /** Ed25519 private key as a JWK (`{ kty: "OKP", crv: "Ed25519", d, x }`), or that JWK as a JSON string. */
  privateJwk: JsonWebKey | string;
  /** The key id Wire returned when the public half was registered with `purpose: "runtime"`. */
  keyId: string;
}

export interface WireAgentClientOptions {
  /**
   * Your agent id (`someday`, `geo-app`). The manifest form (`geo_app`) is
   * accepted and mapped to the agent id. Required unless the deprecated
   * `appId` is set.
   */
  agentId?: string;
  /** @deprecated Use `agentId`. */
  appId?: string;
  /** The runtime key this server signs with. Keep the private half a server secret. */
  runtimeKey: WireRuntimeKey;
  /** Wire's origin. Defaults to https://app.usewire.io (preview: https://preview.app.usewire.io). */
  baseUrl?: string;
  /** A fetch implementation, for tests or instrumentation. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /**
   * Which of Wire's paths to call. `agents` (the default) is
   * `/api/v1/agents/...` with `aud: "wire-agent-api"`. `apps` is the
   * deprecated `/api/v1/apps/...` with `aud: "wire-app-api"`, only for a Wire
   * deployment that predates the agent paths.
   */
  apiVersion?: 'agents' | 'apps';
}

interface Envelope {
  success?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
}

export class WireAgentClient {
  /** The agent id this client signs as and reads the installs of. */
  readonly agentId: string;
  private readonly apiVersion: 'agents' | 'apps';
  private readonly base: string;
  private readonly keyId: string;
  private readonly jwk: JsonWebKey;
  private readonly fetchImpl: typeof fetch;
  private key: Promise<CryptoKey | Uint8Array> | undefined;

  constructor(options: WireAgentClientOptions) {
    const given = options?.agentId ?? options?.appId;
    if (!given) throw new TypeError('WireAgentClient: agentId is required');
    const agentId = given.replace(/_/g, '-');
    if (!AGENT_ID_RE.test(agentId)) throw new TypeError(`WireAgentClient: "${given}" is not an agent id`);
    this.agentId = agentId;
    const v = options.apiVersion ?? 'agents';
    if (v !== 'agents' && v !== 'apps') throw new TypeError('WireAgentClient: apiVersion must be "agents" or "apps"');
    this.apiVersion = v;

    const rk = options.runtimeKey;
    if (!rk?.keyId || typeof rk.keyId !== 'string') {
      throw new TypeError('WireAgentClient: runtimeKey.keyId is required (the id Wire assigned the runtime key)');
    }
    let jwk: unknown = rk.privateJwk;
    if (typeof jwk === 'string') {
      try {
        jwk = JSON.parse(jwk);
      } catch {
        throw new TypeError('WireAgentClient: runtimeKey.privateJwk is not a JWK or JSON');
      }
    }
    const j = jwk as JsonWebKey | null;
    if (!j || j.kty !== 'OKP' || j.crv !== 'Ed25519' || typeof j.d !== 'string' || typeof j.x !== 'string') {
      throw new TypeError('WireAgentClient: runtimeKey.privateJwk must be an Ed25519 private JWK (kty OKP, crv Ed25519, d, x)');
    }
    this.jwk = j;
    this.keyId = rk.keyId;
    this.base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') throw new TypeError('WireAgentClient: no fetch available; pass options.fetch');
    this.fetchImpl = f;
  }

  /** @deprecated Use `agentId` (the same value). */
  get appId(): string {
    return this.agentId;
  }

  /**
   * One install of this agent. Null when this agent has no such install: an id
   * of another agent's, a made-up one, or an install whose container was
   * permanently deleted or expired. A revoked install is still returned, with
   * `connection.status: "revoked"` and a `reason`.
   */
  async getInstall(installId: string): Promise<WireInstall | null> {
    requireId(installId, 'installId');
    try {
      const data = await this.call('GET', `/installs/${encodeURIComponent(installId)}`);
      return toInstall(data);
    } catch (err) {
      if (err instanceof WireAgentApiError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Every install one of this agent's users has, newest connection first. An
   * agentUserId this agent does not know (someone else's, or made up) has
   * none: [].
   */
  async listInstalls(agentUserId: string): Promise<WireInstall[]> {
    requireId(agentUserId, 'agentUserId');
    let data: unknown;
    try {
      data = await this.call('GET', `/users/${encodeURIComponent(agentUserId)}/installs`);
    } catch (err) {
      if (err instanceof WireAgentApiError && err.status === 404) return [];
      throw err;
    }
    const installs = (data as { installs?: unknown } | null)?.installs;
    if (!Array.isArray(installs)) throw new WireAgentApiError('INVALID_RESPONSE', 'Wire answered without installs', 200);
    return installs.map(toInstall);
  }

  /**
   * UNINSTALL this agent from the install's container: what the container
   * owner's Uninstall button does. The agent's connections to that container end
   * (every user's, not only this install's), the container is released (Wire's
   * built-in tools and the analysis graphs back to their defaults), and the
   * data stays. Resolves with the install as it now reads (revoked,
   * `uninstalled`), or null if Wire could not read it back.
   *
   * Throws WireAgentApiError: NOT_FOUND (404) for an install this agent does not
   * have or whose container is gone, and CONTAINER_UNAVAILABLE (502,
   * `retryable`) when the connections were ended but the container could not
   * finish the uninstall yet: call it again.
   */
  async revokeInstall(installId: string): Promise<WireInstall | null> {
    requireId(installId, 'installId');
    const data = await this.call('DELETE', `/installs/${encodeURIComponent(installId)}`, { allowNullData: true });
    return data === null || data === undefined ? null : toInstall(data);
  }

  /** Sign the agent API token for one request. Exposed for tests and custom transports. */
  async signRequestToken(method: string, body = ''): Promise<string> {
    this.key ??= importJWK({ ...this.jwk, alg: 'EdDSA' }, 'EdDSA');
    let key: CryptoKey | Uint8Array;
    try {
      key = await this.key;
    } catch (err) {
      this.key = undefined;
      throw new TypeError('WireAgentClient: runtimeKey.privateJwk could not be imported', { cause: err });
    }
    const claims: Record<string, unknown> = {};
    if (method.toUpperCase() === 'DELETE') claims[AGENT_API_BODY_HASH_CLAIM] = await sha256Base64Url(body);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: this.keyId })
      .setIssuer(this.agentId)
      .setAudience(this.apiVersion === 'apps' ? APP_API_AUDIENCE : AGENT_API_AUDIENCE)
      .setJti(randomJti())
      .setIssuedAt(now)
      .setExpirationTime(now + AGENT_API_TOKEN_LIFETIME_SEC)
      .sign(key);
  }

  private async call(method: 'GET' | 'DELETE', path: string, opts: { allowNullData?: boolean } = {}): Promise<unknown> {
    const url = `${this.base}/api/v1/${this.apiVersion}/${encodeURIComponent(this.agentId)}${path}`;
    // An empty DELETE body, hashed as the empty string: nothing is sent.
    const token = await this.signRequestToken(method, '');
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
    } catch (err) {
      throw new WireAgentApiError('NETWORK_ERROR', `Could not reach Wire: ${(err as Error)?.message ?? err}`, undefined, undefined, {
        cause: err,
      });
    }

    let json: Envelope | null = null;
    try {
      json = (await res.json()) as Envelope;
    } catch {
      // Not the API's envelope (a proxy's error page, an empty body).
    }
    if (!res.ok || !json || json.success !== true) {
      const code = json?.error?.code ?? `HTTP_${res.status}`;
      const message = json?.error?.message ?? `Wire answered ${res.status}`;
      throw new WireAgentApiError(code, message, res.status, json?.error?.details);
    }
    if (json.data === undefined || (json.data === null && !opts.allowNullData)) {
      throw new WireAgentApiError('INVALID_RESPONSE', 'Wire answered without data', res.status);
    }
    return json.data;
  }
}

/**
 * Generate a runtime key. Register `publicKey` (raw 32 bytes, base64url) with
 * `purpose: "runtime"`:
 *
 *   POST https://app.usewire.io/api/v1/agents/{agentId}/publisher-keys
 *   { "publicKey": "<publicKey>", "label": "production server", "purpose": "runtime" }
 *
 * (a signed-in org member with `organization: update` on the agent's owner org).
 * The answer's `id` is the `keyId`. Keep `privateJwk` a server secret: it is
 * the whole credential. The same Ed25519 key shape as a device key.
 */
export async function generateRuntimeKey(): Promise<{ privateJwk: JsonWebKey; publicKey: string }> {
  const { privateJwk, publicKey } = await generateDeviceKey();
  return { privateJwk, publicKey };
}

function requireId(v: unknown, name: string): void {
  if (typeof v !== 'string' || !v) throw new TypeError(`${name} is required`);
}

function toInstall(raw: unknown): WireInstall {
  try {
    return installFromWire(raw);
  } catch (err) {
    if (err instanceof InstallShapeError) {
      throw new WireAgentApiError('INVALID_RESPONSE', `Wire answered with a malformed install: ${err.message}`, 200);
    }
    throw err;
  }
}

/** @deprecated Use `WireAgentClient`. The same class under its pre-0.10 name. */
export const WireAppClient = WireAgentClient;
/** @deprecated Use `WireAgentClient`. */
export type WireAppClient = WireAgentClient;
/** @deprecated Use `WireAgentClientOptions`. */
export type WireAppClientOptions = WireAgentClientOptions;
