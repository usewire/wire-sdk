/**
 * Verify that an HTTP request is a genuine Wire action call.
 *
 * Wire signs every action call with its own Ed25519 key (SUP-946): a short
 * EdDSA JWT in `Authorization: Bearer`, verified against Wire's public JWKS.
 * The app holds no secret. What a valid call proves:
 *
 *   - Wire sent it (signature against a key in Wire's JWKS, looked up by `kid`);
 *   - for THIS app (`aud` is exactly the app id);
 *   - just now (`iat`/`exp`, at most 60 seconds apart, small clock tolerance);
 *   - once (`jti` recorded in a replay store);
 *   - with THIS body (SHA-256 of the raw body bytes equals the signed hash);
 *   - on behalf of a connection and container (`sub`, the container claim),
 *     for a named action.
 *
 * Only the JWKS URL configured here is trusted. Token headers that point at
 * keys (`jku`, `jwk`, `x5u`, `x5c`) are never consulted, and only EdDSA is
 * accepted, so there is no algorithm to confuse.
 */
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { WireActionAuthError } from './errors.js';
import { defaultReplayStore, type ReplayStore } from './replay.js';

// ─── The wire format ────────────────────────────────────────────────────────
// The ENGINE owns these (usewire/wire `src/connect/action-claims.ts`, exported
// on `@usewire/container/manifest`). Mirrored here, not imported, until that
// subpath is published as a package the SDK can depend on; every name the SDK
// reads is in this block, so a change is a one-place edit.

/** `iss` on every action call. */
export const WIRE_ACTION_ISSUER = 'wire';
/** The JWT header `typ` of an action call (explicit typing, RFC 8725 §3.11). */
export const WIRE_ACTION_JWT_TYP = 'wire-action+jwt';
/** Header carrying the id of the tool call an action is part of. NOT signed: correlation only. */
export const WIRE_REQUEST_ID_HEADER = 'X-Wire-Request-Id';

/**
 * Wire's public JWKS for action signing keys, served by the control plane on
 * the API origin (wire-platform SUP-946). Override with `jwksUrl` for preview
 * (`https://api-preview.usewire.io/.well-known/wire-actions-jwks.json`) or a
 * self-hosted control plane.
 */
export const DEFAULT_WIRE_JWKS_URL = 'https://api.usewire.io/.well-known/wire-actions-jwks.json';

/** Claim names of an action-call JWT. */
export const WIRE_ACTION_CLAIMS = {
  /** The connection the call is made under (standard `sub`). */
  connectionId: 'sub',
  /** The container the call comes from. */
  containerId: 'wire_container',
  /** The manifest action being called. */
  action: 'wire_action',
  /** base64url (no padding) SHA-256 of the exact request body bytes. */
  bodyHash: 'wire_body_sha256',
} as const;

/** Longest `exp - iat` accepted. Wire mints 60-second tokens. */
export const MAX_TOKEN_LIFETIME_SEC = 60;
/** Default tolerance for clock skew between Wire and the app (the engine's recommended value). */
export const DEFAULT_CLOCK_TOLERANCE_SEC = 30;
/** Default ceiling on the request body read for hashing. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

const MAX_CLOCK_TOLERANCE_SEC = 60;
const MAX_TOKEN_CHARS = 8 * 1024;
const MAX_ID_CHARS = 256;
const SHA256_B64URL_RE = /^[A-Za-z0-9_-]{43}$/;
const BEARER_RE = /^Bearer[ ]+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

/** The payload of a verified action call. */
export interface WireActionClaims extends JWTPayload {
  iss: string;
  aud: string | string[];
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  wire_container: string;
  wire_action: string;
  wire_body_sha256: string;
}

export interface VerifyWireActionOptions {
  /** Your app id: the `aud` Wire signs for. The agent id you registered. */
  appId: string;
  /** Wire's JWKS URL. https only (http allowed for localhost). Defaults to DEFAULT_WIRE_JWKS_URL. */
  jwksUrl?: string;
  /** The current time, for tests. A Date or a function returning one. */
  now?: Date | (() => Date);
  /**
   * Where used `jti`s are recorded. Defaults to a process-wide in-memory
   * store, which only protects a single instance: multi-instance apps
   * (including Cloudflare Workers) should pass a shared, atomic store.
   */
  replayStore?: ReplayStore;
  /**
   * The action this endpoint serves. Set it: without it, a token Wire minted
   * for another of your actions verifies here too (the request path is not
   * signed). Mismatches fail ACTION_MISMATCH. defineAction() always sets it.
   */
  action?: string;
  /** Clock skew tolerance in seconds. Default 30 (what Wire assumes), capped at 60. */
  clockToleranceSec?: number;
  /** Largest body read for hashing. Default 1 MiB; larger bodies fail BODY_TOO_LARGE. */
  maxBodyBytes?: number;
}

export interface VerifiedWireAction {
  /** The connection (install of your app on a container) making the call. */
  connectionId: string;
  /** The container the call comes from. */
  containerId: string;
  /** The manifest action being called. */
  action: string;
  /**
   * The id of the tool call this action is part of, from X-Wire-Request-Id.
   * Not covered by the signature: use it to correlate logs, never to decide.
   */
  requestId: string | null;
  /** Every verified claim, for logging or audit. */
  claims: WireActionClaims;
}

/**
 * Verify a Wire action call. Returns who is calling, or throws
 * WireActionAuthError (its `status` is the HTTP status to answer with).
 *
 * Reads the body from a clone, so `request` stays readable afterwards. The
 * body is hashed exactly as received: parse it only after this resolves, and
 * never hash a re-serialized copy.
 */
export async function verifyWireAction(
  request: Request,
  options: VerifyWireActionOptions
): Promise<VerifiedWireAction> {
  const { verified } = await verifyWireActionRequest(request.clone(), options);
  return verified;
}

/**
 * The same verification, consuming `request`'s body and returning the bytes
 * that were verified. defineAction() uses this so the body is read once and
 * the handler sees exactly the bytes whose hash was signed.
 */
export async function verifyWireActionRequest(
  request: Request,
  options: VerifyWireActionOptions
): Promise<{ verified: VerifiedWireAction; body: Uint8Array<ArrayBuffer> }> {
  if (!options?.appId) throw new TypeError('verifyWireAction: appId is required');
  const tolerance = Math.min(
    Math.max(0, options.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC),
    MAX_CLOCK_TOLERANCE_SEC
  );
  const jwks = remoteJwks(options.jwksUrl ?? DEFAULT_WIRE_JWKS_URL);
  const currentDate = resolveNow(options.now);

  // 1. The bearer.
  const auth = request.headers.get('authorization');
  if (!auth) throw new WireActionAuthError('MISSING_TOKEN', 'Authorization: Bearer <token> required');
  const match = BEARER_RE.exec(auth.trim());
  if (!match || match[1].length > MAX_TOKEN_CHARS) {
    throw new WireActionAuthError('MALFORMED_TOKEN', 'Authorization must be "Bearer <jwt>"');
  }
  const token = match[1];

  // 2. The header, before any key lookup: EdDSA only, typed as an action
  //    call, and a kid is required so a rotation never makes the verifier
  //    guess between keys.
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new WireActionAuthError('MALFORMED_TOKEN', 'Malformed JWT header');
  }
  if (header.alg !== 'EdDSA') {
    throw new WireActionAuthError('UNSUPPORTED_ALGORITHM', 'JWT alg must be EdDSA');
  }
  if (header.typ !== WIRE_ACTION_JWT_TYP) {
    throw new WireActionAuthError('MALFORMED_TOKEN', `JWT typ must be ${WIRE_ACTION_JWT_TYP}`);
  }
  if (typeof header.kid !== 'string' || !header.kid) {
    throw new WireActionAuthError('UNKNOWN_KEY', 'JWT header has no kid');
  }

  // 3. Signature and registered claims.
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      algorithms: ['EdDSA'],
      typ: WIRE_ACTION_JWT_TYP,
      issuer: WIRE_ACTION_ISSUER,
      audience: options.appId,
      currentDate,
      clockTolerance: tolerance,
      maxTokenAge: MAX_TOKEN_LIFETIME_SEC + tolerance,
      requiredClaims: [
        'iss',
        'aud',
        'sub',
        'jti',
        'iat',
        'exp',
        WIRE_ACTION_CLAIMS.containerId,
        WIRE_ACTION_CLAIMS.action,
        WIRE_ACTION_CLAIMS.bodyHash,
      ],
    }));
  } catch (err) {
    throw mapJoseError(err);
  }

  // 4. Shape of the claims jose does not check.
  const claims = checkClaims(payload, options.appId);
  if (options.action !== undefined && claims.wire_action !== options.action) {
    throw new WireActionAuthError(
      'ACTION_MISMATCH',
      `Token is for action "${claims.wire_action}", not "${options.action}"`
    );
  }

  // 5. The body: the exact bytes received, hashed and compared in constant time.
  const body = await readBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  const digest = await sha256Base64Url(body);
  if (!timingSafeEqual(digest, claims.wire_body_sha256)) {
    throw new WireActionAuthError('BODY_MISMATCH', 'Request body does not match the signed hash');
  }

  // 6. Replay, last: only a call that is otherwise fully valid spends its jti.
  const replayStore = options.replayStore ?? defaultReplayStoreWithWarning();
  let fresh: boolean;
  try {
    // A constant TTL covering the longest time any instance could still
    // accept this token (lifetime plus skew either side), so a shared store
    // stays correct across instances whose clocks disagree.
    fresh = await replayStore.markUsed(
      `${claims.iss}|${options.appId}|${claims.jti}`,
      MAX_TOKEN_LIFETIME_SEC + 2 * MAX_CLOCK_TOLERANCE_SEC + 1
    );
  } catch (err) {
    throw new WireActionAuthError('REPLAY_STORE_UNAVAILABLE', 'Replay store unavailable', { cause: err });
  }
  if (!fresh) throw new WireActionAuthError('REPLAYED', 'This call has already been received (jti reused)');

  return {
    verified: {
      connectionId: claims.sub,
      containerId: claims.wire_container,
      action: claims.wire_action,
      requestId: request.headers.get(WIRE_REQUEST_ID_HEADER)?.slice(0, MAX_ID_CHARS) || null,
      claims,
    },
    body,
  };
}

// ─── JWKS ───────────────────────────────────────────────────────────────────

/**
 * One cached key set per URL, per process/isolate.
 *
 *   - Cached for 5 minutes: the max-age Wire's key rotation waits out before
 *     it signs with a new key.
 *   - Refetched on an unknown kid at most once per 30 seconds, so random kids
 *     cannot turn into a fetch per request.
 *   - jose never follows a redirect for it and refuses non-public keys.
 *   - OUTAGE: after a failed fetch, no new fetch for 10 seconds (a failing
 *     JWKS must not become one 3-second fetch per request), and meanwhile the
 *     last set that loaded keeps verifying for up to an hour. Past that the
 *     call is refused with 503 rather than trusting keys Wire may have retired.
 */
const JWKS_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const JWKS_COOLDOWN_MS = 30 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 3000;
const JWKS_FAILURE_BACKOFF_MS = 10 * 1000;
const JWKS_STALE_MAX_MS = 60 * 60 * 1000;

const jwksCache = new Map<string, JWTVerifyGetKey>();

/** Check a JWKS URL (throws TypeError). Exported for defineAction's definition-time check. */
export function checkJwksUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError('jwksUrl is not a valid URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new TypeError(`jwksUrl must be https (got ${parsed.protocol}//${parsed.host})`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('jwksUrl must not carry credentials');
  }
  return parsed;
}

function isNoKey(err: unknown): boolean {
  return err instanceof joseErrors.JWKSNoMatchingKey || err instanceof joseErrors.JWKSMultipleMatchingKeys;
}

const UNKNOWN_KID = () => new WireActionAuthError('UNKNOWN_KEY', 'No Wire key matches the token kid');

function remoteJwks(url: string): JWTVerifyGetKey {
  const cached = jwksCache.get(url);
  if (cached) return cached;

  const remote = createRemoteJWKSet(checkJwksUrl(url), {
    timeoutDuration: JWKS_FETCH_TIMEOUT_MS,
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
  });
  let lastGood: { getKey: JWTVerifyGetKey; at: number } | undefined;
  let failedAt = 0;

  const fromLastGood: JWTVerifyGetKey = async (header, token) => {
    if (!lastGood || Date.now() - lastGood.at > JWKS_STALE_MAX_MS) {
      throw new WireActionAuthError('JWKS_UNAVAILABLE', "Could not load Wire's JWKS");
    }
    try {
      return await lastGood.getKey(header, token);
    } catch (err) {
      if (isNoKey(err)) throw UNKNOWN_KID();
      throw new WireActionAuthError('JWKS_UNAVAILABLE', "Could not load Wire's JWKS", { cause: err });
    }
  };

  const getKey: JWTVerifyGetKey = async (header, token) => {
    if (failedAt && Date.now() - failedAt < JWKS_FAILURE_BACKOFF_MS) return fromLastGood(header, token);
    try {
      const key = await remote(header, token);
      // Snapshot the loaded set now and then (not per call: it is a copy).
      if (!lastGood || Date.now() - lastGood.at > JWKS_COOLDOWN_MS) {
        const jwks = remote.jwks();
        if (jwks) lastGood = { getKey: createLocalJWKSet(jwks), at: Date.now() };
      }
      failedAt = 0;
      return key;
    } catch (err) {
      if (isNoKey(err)) throw UNKNOWN_KID();
      failedAt = Date.now();
      return fromLastGood(header, token);
    }
  };
  jwksCache.set(url, getKey);
  return getKey;
}

// ─── helpers ────────────────────────────────────────────────────────────────

let warnedDefaultStore = false;

/**
 * The in-memory default only protects one isolate, and a Worker under real
 * traffic runs many. Say so once, where the app author will see it.
 */
function defaultReplayStoreWithWarning(): ReplayStore {
  if (!warnedDefaultStore) {
    warnedDefaultStore = true;
    const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
    if (ua === 'Cloudflare-Workers') {
      console.warn(
        '[wire] verifyWireAction is using the in-memory replay store, which protects one isolate only. ' +
          'Pass a shared, atomic replayStore (for example a Durable Object) so a captured call cannot be replayed against another isolate.'
      );
    }
  }
  return defaultReplayStore();
}

function resolveNow(now: VerifyWireActionOptions['now']): Date | undefined {
  if (now === undefined) return undefined;
  return typeof now === 'function' ? now() : now;
}

function mapJoseError(err: unknown): WireActionAuthError {
  if (err instanceof WireActionAuthError) return err;
  if (err instanceof joseErrors.JWTExpired) {
    return new WireActionAuthError('TOKEN_EXPIRED', 'Token expired');
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'typ') return new WireActionAuthError('MALFORMED_TOKEN', `JWT typ must be ${WIRE_ACTION_JWT_TYP}`);
    if (err.claim === 'iss') return new WireActionAuthError('INVALID_ISSUER', 'Token issuer is not Wire');
    if (err.claim === 'aud') return new WireActionAuthError('INVALID_AUDIENCE', 'Token is not for this app');
    return new WireActionAuthError('INVALID_CLAIMS', `Claim check failed: ${err.claim} (${err.reason})`);
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return new WireActionAuthError('BAD_SIGNATURE', 'Signature verification failed');
  }
  if (err instanceof joseErrors.JOSEAlgNotAllowed) {
    return new WireActionAuthError('UNSUPPORTED_ALGORITHM', 'JWT alg must be EdDSA');
  }
  return new WireActionAuthError('MALFORMED_TOKEN', 'Malformed token', { cause: err });
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_CHARS;
}

function checkClaims(payload: JWTPayload, appId: string): WireActionClaims {
  // jose accepts an aud ARRAY containing appId among others; an action token
  // has exactly one audience (a one-element array is the same thing, as the
  // engine's validateActionClaims also allows).
  const aud = payload.aud;
  if (!(aud === appId || (Array.isArray(aud) && aud.length === 1 && aud[0] === appId))) {
    throw new WireActionAuthError('INVALID_AUDIENCE', 'Token is not for this app');
  }
  const p = payload as Record<string, unknown>;
  const iat = payload.iat;
  const exp = payload.exp;
  if (typeof iat !== 'number' || typeof exp !== 'number' || exp - iat > MAX_TOKEN_LIFETIME_SEC || exp <= iat) {
    throw new WireActionAuthError('INVALID_CLAIMS', `Token lifetime must be at most ${MAX_TOKEN_LIFETIME_SEC}s`);
  }
  if (!isId(payload.sub)) throw new WireActionAuthError('INVALID_CLAIMS', 'Missing connection id (sub)');
  if (!isId(payload.jti) || payload.jti.length < 8) {
    throw new WireActionAuthError('INVALID_CLAIMS', 'Missing or short jti');
  }
  if (!isId(p[WIRE_ACTION_CLAIMS.containerId])) {
    throw new WireActionAuthError('INVALID_CLAIMS', 'Missing container id');
  }
  if (!isId(p[WIRE_ACTION_CLAIMS.action])) throw new WireActionAuthError('INVALID_CLAIMS', 'Missing action');
  const hash = p[WIRE_ACTION_CLAIMS.bodyHash];
  if (typeof hash !== 'string' || !SHA256_B64URL_RE.test(hash)) {
    throw new WireActionAuthError('INVALID_CLAIMS', 'Missing or malformed body hash');
  }
  return payload as WireActionClaims;
}

async function readBody(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw new WireActionAuthError('BODY_TOO_LARGE', `Body exceeds ${maxBytes} bytes`);
  }
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Not awaited: on a tee (request.clone()) cancel settles only when both
      // branches are cancelled.
      void reader.cancel().catch(() => {});
      throw new WireActionAuthError('BODY_TOO_LARGE', `Body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** base64url (no padding) SHA-256 — the body hash encoding. */
export async function sha256Base64Url(bytes: Uint8Array | string): Promise<string> {
  const input = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  let bin = '';
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
