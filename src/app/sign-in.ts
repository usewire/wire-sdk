/**
 * Sign in with Wire, for an agent whose manifest declares `access`.
 *
 * A person signs in to YOUR app with their Wire account. Your app gets:
 *
 *   - an ID token saying who they are TO YOUR AGENT: `sub` is their per-agent
 *     id (`au_…`), the same id your install webhooks and `WireAgentClient`
 *     use. It is never their Wire user id, and another agent gets a different
 *     id for the same person. With `identity` in your manifest, also their
 *     email, or name and picture;
 *   - an access token your server presents to YOUR AGENT'S ENDPOINT to call
 *     your tools as that person (`WireAgentEndpoint`), held to the `level`
 *     your manifest declares;
 *   - a refresh token, when you ask for `offline_access`.
 *
 * THIS RUNS ON YOUR SERVER. An agent that declares `access` has a client
 * secret (created on the agent's page in Wire, shown once). The code exchange
 * and every refresh are authenticated with it, so they cannot run in a
 * browser, a mobile app or anything else a person can read. That is also why
 * `WireClient.connectInBrowser()` does not work for such an agent: it
 * exchanges its code in the browser, with no secret. `connectInBrowser()` is
 * for agents that do NOT declare `access`.
 *
 * The flow is a standard authorization code flow with PKCE:
 *
 *   1. `createAuthorizeRequest()` gives you a URL, a `state` and a
 *      `codeVerifier`. Keep the last two in the person's server-side session
 *      and send their browser to the URL.
 *   2. Wire sends the browser back to your `redirectUri` with `code` and
 *      `state`. Check `state` is the one you kept.
 *   3. `exchangeCode({ code, codeVerifier })` answers the tokens, with the ID
 *      token already verified.
 *   4. Later, `refresh(refreshToken)` answers new ones. The refresh token
 *      changes each time, and THE OLD ONE IS SPENT THE MOMENT WIRE ANSWERS:
 *      store the new one before anything else. For ten seconds a spent one
 *      sent again gets the same new tokens (so a retry after a lost answer is
 *      safe); after that Wire treats it as stolen and signs the person out of
 *      your agent (every token it holds for them stops working). See
 *      `refresh`.
 *
 * The request never names a `resource`. Wire refuses one from this client.
 *
 * Runs anywhere with Web Crypto and fetch: Node 18+, Cloudflare Workers, Bun, Deno.
 */
import { createRemoteJWKSet, customFetch, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { WireSdkError } from '../types.js';

const DEFAULT_BASE_URL = 'https://app.usewire.io';
const AUTHORIZE_PATH = '/api/auth/oauth2/authorize';
const TOKEN_PATH = '/api/auth/oauth2/token';
const USERINFO_PATH = '/api/auth/oauth2/userinfo';
const DISCOVERY_PATH = '/.well-known/openid-configuration';
const AGENT_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A person's id as your agent knows them. Wire's own pattern for it, copied: keep the two the same. */
export const AGENT_USER_ID_PATTERN = /^au_[0-9a-z]{16,48}$/;

/** What a sign-in may ask for. `openid` is always sent. */
export type WireSignInScope = 'openid' | 'email' | 'profile' | 'offline_access';

export type WireSignInErrorCode =
  /** A constructor or call argument is missing or malformed. Your code's to fix. */
  | 'INVALID_ARGUMENT'
  /** Wire refused the code, the verifier or the refresh token. The person signs in again. */
  | 'INVALID_GRANT'
  /** Wire refused the client secret, or the agent has none. Create one on the agent's page. */
  | 'INVALID_CLIENT'
  /** Wire refused the request for another stated reason (`error` from the answer is in `details`). */
  | 'OAUTH_ERROR'
  /** The ID token did not verify (signature, issuer, audience, expiry, subject, nonce). Do not sign the person in. */
  | 'INVALID_ID_TOKEN'
  /** Wire's answer was not the shape this client reads. */
  | 'UNEXPECTED_RESPONSE'
  /** Wire could not answer right now (5xx, 429, a blip). Try again; the code or refresh token is still good unless Wire said otherwise. */
  | 'UNAVAILABLE'
  /** The request did not reach Wire. */
  | 'NETWORK_ERROR';

/**
 * A sign-in call failed. `retryable`: the SAME call may succeed later.
 *
 * `tokens`, on an error from `refresh()` only: Wire HAD ALREADY ANSWERED with
 * new tokens when something after that failed (the ID token it sent did not
 * verify). The refresh token you sent is spent. STORE `tokens.refreshToken`
 * and `tokens.accessToken` in place of the old ones before you do anything
 * else, then treat the error as you would otherwise. When `tokens` is set,
 * `retryable` is false: the call must not be repeated with the old token.
 */
export class WireSignInError extends WireSdkError {
  readonly retryable: boolean;
  readonly tokens?: WireSignInTokens;
  constructor(code: WireSignInErrorCode, message: string, status?: number, details?: unknown, options?: { cause?: unknown; tokens?: WireSignInTokens }) {
    super(code, message, status, details);
    this.name = 'WireSignInError';
    this.retryable = !options?.tokens && (code === 'UNAVAILABLE' || code === 'NETWORK_ERROR');
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    // Not enumerable: tokens are not something to find in a log of the error.
    if (options?.tokens) Object.defineProperty(this, 'tokens', { value: options.tokens, enumerable: false });
  }
}

export interface WireSignInOptions {
  /** Your agent's id. It is also the OAuth client id. */
  agentId: string;
  /**
   * The client secret from your agent's page in Wire. SERVER ONLY: never ship
   * it to a browser or an app. Read it from your server's secret store.
   */
  clientSecret: string;
  /** Where Wire sends the browser back. One of the redirect addresses registered for your agent, exactly. */
  redirectUri: string;
  /** Wire's origin. Defaults to https://app.usewire.io (preview: https://preview.app.usewire.io). */
  baseUrl?: string;
  /** A fetch to use instead of the global one. */
  fetch?: typeof fetch;
  /** Seconds of clock difference to allow when checking an ID token. Default 60. */
  clockToleranceSec?: number;
  /**
   * Milliseconds `refresh()` waits before the one retry it makes when Wire
   * answers `INVALID_GRANT`. Default 300.
   */
  refreshRetryDelayMs?: number;
}

/** The verified claims of an ID token. */
export interface WireIdentity {
  /** The person's id for YOUR agent (`au_…`). Stable for that person and your agent; meaningless to any other agent. */
  agentUserId: string;
  /** With `identity: ["email"]` and the `email` scope. */
  email?: string;
  emailVerified?: boolean;
  /** With `identity: ["profile"]` and the `profile` scope. */
  name?: string;
  picture?: string;
  /** Every claim of the token, as verified. */
  claims: JWTPayload;
}

export interface WireSignInTokens {
  /** Present this to your agent's endpoint (`WireAgentEndpoint`). Opaque: do not parse it. Keep it on your server. */
  accessToken: string;
  /** When the access token stops working. */
  expiresAt: Date;
  /** Only when you asked for `offline_access`. It changes on every refresh. Keep it on your server. */
  refreshToken: string | null;
  /** The ID token as Wire sent it. Always present after `exchangeCode`; null after a `refresh` that came back without one. */
  idToken: string | null;
  /**
   * Who signed in, from the verified ID token. Always present after
   * `exchangeCode`. NULL after a `refresh` whose answer carried no ID token
   * (Wire may leave it out of a refresh): the person is who they were, so keep
   * the identity you stored at sign-in.
   */
  identity: WireIdentity | null;
  /** The scopes Wire granted. */
  scope: string[];
}

export interface WireAuthorizeRequest {
  /** Send the person's browser here. */
  url: string;
  /** Keep in the person's session; compare with the `state` Wire sends back. */
  state: string;
  /** Keep in the person's session; pass to `exchangeCode`. Never send it to the browser's address bar. */
  codeVerifier: string;
  /** Keep in the person's session when you want replay protection on the ID token; pass to `exchangeCode`. */
  nonce: string;
}

interface Discovery {
  issuer: string;
  jwksUri: string;
}

const base64Url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const randomUrlSafe = (bytes: number): string => base64Url(crypto.getRandomValues(new Uint8Array(bytes)));

/** The PKCE challenge (S256) for a verifier. */
export async function pkceChallenge(codeVerifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))));
}

/** Is this the library saying it could not GET the key set (as opposed to: the token is bad)? */
function keysUnavailable(e: unknown): boolean {
  if (e instanceof joseErrors.JWKSTimeout) return true;
  if (e instanceof joseErrors.JWKSNoMatchingKey || e instanceof joseErrors.JWKSMultipleMatchingKeys) return false;
  // Its plain error for a key-set answer that was not 200, or not a key set.
  if (e instanceof joseErrors.JOSEError) return /JSON Web Key Set/i.test(e.message) && !(e instanceof joseErrors.JWTInvalid) && !(e instanceof joseErrors.JWSInvalid);
  // Anything that is not the library's own is the fetch failing.
  return !(e instanceof joseErrors.JOSEError);
}

function requireServer(): void {
  // A window with a document is a browser page. A secret used there is a secret given away.
  // A GUARD AGAINST THE COMMON MISTAKE, NOT A GUARANTEE: a web worker or a mobile app has no such
  // pair and is not refused here. Nothing a person can read may hold the client secret.
  const g = globalThis as { window?: unknown; document?: unknown };
  if (typeof g.window !== 'undefined' && typeof g.document !== 'undefined') {
    throw new WireSignInError(
      'INVALID_ARGUMENT',
      'WireSignIn runs on a server: it holds your client secret. In a browser, send the person to your server, which starts the sign-in.',
    );
  }
}

/**
 * Sign in with Wire, on your server. One instance per agent; it holds no
 * person's state.
 */
export class WireSignIn {
  readonly agentId: string;
  readonly redirectUri: string;
  private readonly base: string;
  // A true private field: not enumerable, so it is never in JSON.stringify, a spread or a log of this object.
  readonly #secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tolerance: number;
  private readonly refreshRetryDelayMs: number;
  private discovery: Promise<Discovery> | null = null;
  private keys: JWTVerifyGetKey | null = null;

  constructor(options: WireSignInOptions) {
    requireServer();
    if (!options || typeof options.agentId !== 'string' || !AGENT_ID_RE.test(options.agentId)) {
      throw new WireSignInError('INVALID_ARGUMENT', 'agentId must be your agent id (lowercase letters, digits and hyphens)');
    }
    if (typeof options.clientSecret !== 'string' || options.clientSecret.length < 16) {
      throw new WireSignInError('INVALID_ARGUMENT', "clientSecret is required: create one on your agent's page in Wire");
    }
    let redirect: URL;
    try {
      redirect = new URL(options.redirectUri);
    } catch {
      throw new WireSignInError('INVALID_ARGUMENT', 'redirectUri must be an absolute URL');
    }
    if (redirect.hash) throw new WireSignInError('INVALID_ARGUMENT', 'redirectUri must not have a fragment');
    let base: URL;
    try {
      base = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    } catch {
      throw new WireSignInError('INVALID_ARGUMENT', 'baseUrl must be an absolute URL');
    }
    const local = base.hostname === 'localhost' || base.hostname === '127.0.0.1';
    if (base.protocol !== 'https:' && !local) throw new WireSignInError('INVALID_ARGUMENT', 'baseUrl must be https');
    this.agentId = options.agentId;
    this.#secret = options.clientSecret;
    this.redirectUri = options.redirectUri;
    this.base = base.origin;
    this.fetchImpl = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.tolerance = options.clockToleranceSec ?? 60;
    const delay = options.refreshRetryDelayMs;
    this.refreshRetryDelayMs = typeof delay === 'number' && Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 5000) : 300;
  }

  /**
   * Step 1. A fresh authorize request: the URL to send the browser to, and the
   * `state`, `codeVerifier` and `nonce` to keep in the person's session.
   *
   * `scope`: `openid` is always included. Add `email` and `profile` only if
   * your manifest's `access.identity` lists them (Wire grants no more than the
   * manifest asks for), and `offline_access` for a refresh token.
   */
  async createAuthorizeRequest(options: { scope?: WireSignInScope[] } = {}): Promise<WireAuthorizeRequest> {
    const state = randomUrlSafe(24);
    const nonce = randomUrlSafe(24);
    const codeVerifier = randomUrlSafe(48);
    const url = this.authorizeUrl({ state, nonce, codeChallenge: await pkceChallenge(codeVerifier), scope: options.scope });
    return { url, state, codeVerifier, nonce };
  }

  /**
   * The authorize URL for a `state` and PKCE challenge you made yourself.
   * `createAuthorizeRequest()` is this with fresh values. Never has a
   * `resource`: signing in to your app names none.
   */
  authorizeUrl(input: { state: string; codeChallenge: string; nonce?: string; scope?: WireSignInScope[] }): string {
    if (!input || typeof input.state !== 'string' || input.state.length < 8) {
      throw new WireSignInError('INVALID_ARGUMENT', 'state is required: an unguessable value you keep in the session');
    }
    if (typeof input.codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
      throw new WireSignInError('INVALID_ARGUMENT', 'codeChallenge must be the S256 challenge of your code verifier');
    }
    const scopes = new Set<string>(['openid', ...(input.scope ?? [])]);
    const url = new URL(this.base + AUTHORIZE_PATH);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.agentId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', [...scopes].join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (input.nonce) url.searchParams.set('nonce', input.nonce);
    return url.toString();
  }

  /**
   * Step 3. Exchange the `code` Wire sent to your redirect address. Check
   * `state` yourself first. The ID token in the answer is verified before this
   * returns, against the `nonce` you kept from `createAuthorizeRequest()`.
   *
   * `nonce` is REQUIRED: it ties the ID token to this sign-in. Pass
   * `nonce: false` only if you built the authorize URL yourself without one.
   *
   * A code works once. If this throws `UNAVAILABLE` or `NETWORK_ERROR` the
   * code may or may not have been used: start the sign-in again.
   */
  async exchangeCode(input: { code: string; codeVerifier: string; nonce: string | false }): Promise<WireSignInTokens & { idToken: string; identity: WireIdentity }> {
    if (!input || typeof input.code !== 'string' || !input.code) throw new WireSignInError('INVALID_ARGUMENT', 'code is required');
    if (typeof input.codeVerifier !== 'string' || !input.codeVerifier) throw new WireSignInError('INVALID_ARGUMENT', 'codeVerifier is required');
    if (input.nonce !== false && (typeof input.nonce !== 'string' || !input.nonce)) {
      throw new WireSignInError('INVALID_ARGUMENT', 'nonce is required: the one createAuthorizeRequest() gave you. Pass `nonce: false` only if your authorize URL had none.');
    }
    // Wire's keys first: a code works once, so nothing that can be found out before spending it
    // is left for after.
    await this.loadKeys();
    const tokens = await this.token(
      { grant_type: 'authorization_code', code: input.code, code_verifier: input.codeVerifier, redirect_uri: this.redirectUri, client_id: this.agentId },
      'exchange',
      input.nonce === false ? undefined : input.nonce,
    );
    return tokens as WireSignInTokens & { idToken: string; identity: WireIdentity };
  }

  /**
   * Step 4. New tokens from a refresh token.
   *
   * THE REFRESH TOKEN YOU SEND IS SPENT AS SOON AS WIRE ANSWERS WITH NEW ONES.
   * Store the new `refreshToken` in place of the old one before anything else.
   * For ten seconds after it is spent, sending it again with the same request
   * gets the same new tokens back, so an immediate retry is safe. After that,
   * sending a spent refresh token is treated by Wire as theft: it ends every
   * token your agent holds for that person, and they sign in again. So:
   *
   *   - Run ONE refresh at a time per person (a lock, or a single worker). Two
   *     at once with the same token is a spent token sent twice.
   *   - On an error WITH `tokens` (`WireSignInError.tokens`): Wire had already
   *     answered. Store those tokens, then handle the error. Do not retry.
   *   - On `UNAVAILABLE` where Wire ANSWERED (a 5xx, a 429), the token is not
   *     spent: Wire decides everything before it replaces one. Retry with the
   *     same token.
   *   - On `NETWORK_ERROR` the request may or may not have arrived. Retry at
   *     once with the same token: inside the ten seconds that is safe either
   *     way. If a later retry answers `INVALID_GRANT`, the first one did
   *     arrive and the window has passed, and the person signs in again.
   *   - `INVALID_GRANT`: the person signs in again (they disconnected your
   *     agent, or the token was spent).
   *
   * ONE RETRY ON `INVALID_GRANT` IS BUILT IN. When two refreshes with the same
   * token reach Wire at the same instant, one gets the new tokens and the
   * other can be answered `invalid_grant` for the moment before the first
   * answer is kept, with nothing ended. So this method waits a moment
   * (`refreshRetryDelayMs`, 300 ms) and sends the same token once more: inside
   * the ten seconds that returns the same new tokens. If the second answer is
   * `INVALID_GRANT` too, that is what is thrown, and it is final. A token that
   * really is no longer good is refused twice instead of once; nothing else
   * changes for it. This does not replace the lock: it covers the collision a
   * lock across several servers can still let through.
   *
   * The answer's `identity` is null when Wire sent no ID token with it, which
   * a refresh may do. Keep the identity you stored at sign-in.
   */
  async refresh(refreshToken: string): Promise<WireSignInTokens> {
    if (typeof refreshToken !== 'string' || !refreshToken) throw new WireSignInError('INVALID_ARGUMENT', 'refreshToken is required');
    // Wire's keys first, so a failure to fetch them costs nothing: the token is not sent.
    await this.loadKeys();
    const send = () => this.token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.agentId }, 'refresh', undefined);
    try {
      return await send();
    } catch (e) {
      // Only a plain refusal: an error that carries tokens means Wire had already answered.
      if (!(e instanceof WireSignInError) || e.code !== 'INVALID_GRANT' || e.tokens) throw e;
      await new Promise((resolve) => setTimeout(resolve, this.refreshRetryDelayMs));
      return send();
    }
  }

  /**
   * Verify an ID token: signed by Wire (EdDSA, against Wire's published keys),
   * issued by Wire, for your agent, not expired, and naming a per-agent user
   * id. `exchangeCode` and `refresh` already do this; call it yourself only
   * for a token you stored.
   */
  async verifyIdToken(idToken: string, options: { nonce?: string } = {}): Promise<WireIdentity> {
    if (typeof idToken !== 'string' || idToken.split('.').length !== 3) {
      throw new WireSignInError('INVALID_ID_TOKEN', 'not an ID token');
    }
    const { issuer, keys } = await this.loadKeys();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, keys, {
        issuer,
        audience: this.agentId,
        algorithms: ['EdDSA'],
        clockTolerance: this.tolerance,
        requiredClaims: ['sub', 'iat', 'exp'],
      }));
    } catch (e) {
      if (keysUnavailable(e)) {
        throw new WireSignInError('UNAVAILABLE', "Wire's signing keys could not be fetched", undefined, undefined, { cause: e });
      }
      // No `cause`: the library's error for a failed claim carries the token's decoded claims
      // (an email, a name), and an error is something people log.
      throw new WireSignInError('INVALID_ID_TOKEN', `the ID token did not verify: ${(e as Error).message}`);
    }
    // For this agent and nobody else: Wire issues an ID token to one audience.
    if (Array.isArray(payload.aud) && payload.aud.length !== 1) {
      throw new WireSignInError('INVALID_ID_TOKEN', 'the ID token names more than one audience');
    }
    if (typeof payload.sub !== 'string' || !AGENT_USER_ID_PATTERN.test(payload.sub)) {
      throw new WireSignInError('INVALID_ID_TOKEN', 'the ID token does not name a per-agent user id');
    }
    if (options.nonce !== undefined && payload.nonce !== options.nonce) {
      throw new WireSignInError('INVALID_ID_TOKEN', 'the ID token is not for this sign-in (nonce mismatch)');
    }
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    return {
      agentUserId: payload.sub,
      ...(str(payload.email) ? { email: str(payload.email) } : {}),
      ...(typeof payload.email_verified === 'boolean' ? { emailVerified: payload.email_verified } : {}),
      ...(str(payload.name) ? { name: str(payload.name) } : {}),
      ...(str(payload.picture) ? { picture: str(payload.picture) } : {}),
      claims: payload,
    };
  }

  /**
   * Ask Wire who an access token is for. Answers the per-agent user id only:
   * identity fields are in the ID token. Null when the token is no longer good.
   */
  async userInfo(accessToken: string): Promise<{ agentUserId: string } | null> {
    if (typeof accessToken !== 'string' || !accessToken) throw new WireSignInError('INVALID_ARGUMENT', 'accessToken is required');
    const res = await this.send(this.base + USERINFO_PATH, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) return null;
    if (res.status >= 500 || res.status === 429) throw new WireSignInError('UNAVAILABLE', 'Wire could not answer right now', res.status);
    const json = (await res.json().catch(() => null)) as { sub?: unknown } | null;
    if (!res.ok || !json || typeof json.sub !== 'string' || !AGENT_USER_ID_PATTERN.test(json.sub)) {
      throw new WireSignInError('UNEXPECTED_RESPONSE', "Wire's userinfo answer was not a per-agent user id", res.status);
    }
    return { agentUserId: json.sub };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      // `manual`, not `error`: Cloudflare Workers refuses `error` outright. A redirect is never
      // followed, so the client secret and a person's tokens go to Wire's origin and nowhere else.
      res = await this.fetchImpl(url, { ...init, redirect: 'manual' });
    } catch (e) {
      throw new WireSignInError('NETWORK_ERROR', 'the request did not reach Wire', undefined, undefined, { cause: e });
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new WireSignInError('UNEXPECTED_RESPONSE', 'Wire answered with a redirect, which this client does not follow', res.status || undefined);
    }
    return res;
  }

  /**
   * Wire's issuer and its signing keys, fetched and held. Called BEFORE a code or a refresh token
   * is spent, so that "Wire's keys could not be fetched" is found out while it still costs nothing.
   * A failure is `UNAVAILABLE` (retryable) and is not remembered.
   */
  private async loadKeys(): Promise<{ issuer: string; keys: JWTVerifyGetKey }> {
    const { issuer, jwksUri } = await this.discover();
    if (!this.keys) {
      const set = createRemoteJWKSet(new URL(jwksUri), { [customFetch]: this.fetchImpl as never });
      try {
        await set.reload();
      } catch (e) {
        throw new WireSignInError('UNAVAILABLE', "Wire's signing keys could not be fetched", undefined, undefined, { cause: e });
      }
      this.keys = set;
    }
    return { issuer, keys: this.keys };
  }

  private discover(): Promise<Discovery> {
    this.discovery ??= (async (): Promise<Discovery> => {
      const res = await this.send(this.base + DISCOVERY_PATH, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new WireSignInError('UNAVAILABLE', "Wire's sign-in configuration could not be read", res.status);
      const doc = (await res.json().catch(() => null)) as { issuer?: unknown; jwks_uri?: unknown } | null;
      if (!doc || typeof doc.issuer !== 'string' || typeof doc.jwks_uri !== 'string') {
        throw new WireSignInError('UNEXPECTED_RESPONSE', "Wire's sign-in configuration is not the shape this client reads");
      }
      // Both must be Wire's own origin, the one this client was pointed at: a configuration that
      // names somebody else's keys is not followed.
      let issuerOrigin: string;
      let jwksOrigin: string;
      try {
        issuerOrigin = new URL(doc.issuer).origin;
        jwksOrigin = new URL(doc.jwks_uri).origin;
      } catch {
        throw new WireSignInError('UNEXPECTED_RESPONSE', "Wire's sign-in configuration has a malformed address");
      }
      if (issuerOrigin !== this.base || jwksOrigin !== this.base) {
        throw new WireSignInError('UNEXPECTED_RESPONSE', "Wire's sign-in configuration names another origin; refusing to trust it");
      }
      return { issuer: doc.issuer, jwksUri: doc.jwks_uri };
    })().catch((e) => {
      this.discovery = null; // a failure is not remembered
      throw e;
    });
    return this.discovery;
  }

  private async token(form: Record<string, string>, kind: 'exchange' | 'refresh', nonce: string | undefined): Promise<WireSignInTokens> {
    // client_secret_basic: the id and secret, form-encoded, then base64 (RFC 6749 §2.3.1).
    const basic = btoa(`${encodeURIComponent(this.agentId)}:${encodeURIComponent(this.#secret)}`);
    const res = await this.send(this.base + TOKEN_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', authorization: `Basic ${basic}` },
      body: new URLSearchParams(form).toString(),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || (json && typeof json.error === 'string')) {
      const error = json && typeof json.error === 'string' ? json.error : '';
      const description = json && typeof json.error_description === 'string' ? json.error_description : '';
      const message = description || error || `Wire answered ${res.status}`;
      if (res.status >= 500 || res.status === 429 || error === 'temporarily_unavailable' || error === 'server_error') {
        throw new WireSignInError('UNAVAILABLE', message, res.status, { error });
      }
      if (error === 'invalid_client' || res.status === 401) throw new WireSignInError('INVALID_CLIENT', message, res.status, { error });
      if (error === 'invalid_grant') throw new WireSignInError('INVALID_GRANT', message, res.status, { error });
      throw new WireSignInError('OAUTH_ERROR', message, res.status, { error });
    }
    if (!json || typeof json.access_token !== 'string' || !json.access_token) {
      throw new WireSignInError('UNEXPECTED_RESPONSE', "Wire's token answer had no access token", res.status);
    }
    const expiresIn = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 0;
    const issued: WireSignInTokens = {
      accessToken: json.access_token,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null,
      idToken: typeof json.id_token === 'string' && json.id_token ? json.id_token : null,
      identity: null,
      scope: typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean) : [],
    };

    if (kind === 'exchange') {
      // A sign-in with no verified ID token signs nobody in. The code is spent either way; the
      // tokens are not handed over, because there is nobody to hand them to.
      if (!issued.idToken) {
        throw new WireSignInError('UNEXPECTED_RESPONSE', "Wire's token answer had no ID token. Did the request ask for `openid`?", res.status);
      }
      return { ...issued, identity: await this.verifyIdToken(issued.idToken, nonce !== undefined ? { nonce } : {}) };
    }

    // A REFRESH: Wire has replaced the refresh token. From here on NOTHING may lose the new one.
    // No ID token is an answer (Wire may leave it out of a refresh): the tokens, and no identity.
    if (!issued.idToken) return issued;
    try {
      return { ...issued, identity: await this.verifyIdToken(issued.idToken) };
    } catch (e) {
      const cause = e instanceof WireSignInError ? e : new WireSignInError('INVALID_ID_TOKEN', 'the ID token did not verify');
      // The new tokens ride on the error, so the caller can store them before handling it.
      throw new WireSignInError(cause.code as WireSignInErrorCode, `${cause.message} (Wire had already issued new tokens: they are on this error as \`tokens\`; store them)`, cause.status, cause.details, {
        tokens: { ...issued, idToken: null },
      });
    }
  }
}
