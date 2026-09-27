/**
 * Errors thrown by the app side (`@usewire/sdk/app`).
 */

/** Why a Wire action call failed verification. */
export type WireActionAuthErrorCode =
  /** No `Authorization: Bearer <jwt>` header. */
  | 'MISSING_TOKEN'
  /** The bearer is not a well-formed JWS compact token. */
  | 'MALFORMED_TOKEN'
  /** The header `alg` is not EdDSA (algorithm confusion guard). */
  | 'UNSUPPORTED_ALGORITHM'
  /** The header has no `kid`, or the `kid` is not in Wire's JWKS even after a refetch. */
  | 'UNKNOWN_KEY'
  /** Wire's JWKS could not be fetched or parsed. Not the caller's fault: answer 503. */
  | 'JWKS_UNAVAILABLE'
  /** The signature does not verify against Wire's key. */
  | 'BAD_SIGNATURE'
  /** `iss` is not "wire". */
  | 'INVALID_ISSUER'
  /** `aud` is not this app's id. */
  | 'INVALID_AUDIENCE'
  /** `exp` has passed (beyond the clock tolerance). */
  | 'TOKEN_EXPIRED'
  /** A required claim is missing or malformed, `iat` is in the future, or the lifetime is too long. */
  | 'INVALID_CLAIMS'
  /** The token was minted for a different action than the one this endpoint serves. */
  | 'ACTION_MISMATCH'
  /** The request body does not hash to the token's body hash. */
  | 'BODY_MISMATCH'
  /** The request body is larger than `maxBodyBytes`. */
  | 'BODY_TOO_LARGE'
  /** This `jti` has been seen before. */
  | 'REPLAYED'
  /** The replay store refused to record the `jti` (full, or unreachable). Fails closed: answer 503. */
  | 'REPLAY_STORE_UNAVAILABLE';

const SERVER_SIDE_CODES: ReadonlySet<WireActionAuthErrorCode> = new Set([
  'JWKS_UNAVAILABLE',
  'REPLAY_STORE_UNAVAILABLE',
]);

/**
 * A Wire action call failed verification. `status` is the HTTP status to
 * answer with: 401 for anything the caller got wrong, 413 for an oversized
 * body, 503 when the app itself could not check (JWKS or replay store down).
 */
export class WireActionAuthError extends Error {
  readonly code: WireActionAuthErrorCode;
  readonly status: number;

  constructor(code: WireActionAuthErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'WireActionAuthError';
    this.code = code;
    this.status = SERVER_SIDE_CODES.has(code) ? 503 : code === 'BODY_TOO_LARGE' ? 413 : 401;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Throw this from an action handler to answer with a deliberate error the
 * agent will see (for example "address not found"). Anything else thrown
 * from a handler becomes a generic 500 with no details, so internals never
 * leak to the agent.
 */
export class WireActionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = 'WireActionError';
    this.code = code;
    this.status = status;
  }
}

/** A manifest failed local validation in defineManifest(). */
export class WireManifestError extends Error {
  readonly issues: ReadonlyArray<{ path: string; message: string }>;

  constructor(issues: ReadonlyArray<{ path: string; message: string }>) {
    super(
      `Invalid Wire manifest:\n${issues.map((i) => `  - ${i.path || '(root)'}: ${i.message}`).join('\n')}`
    );
    this.name = 'WireManifestError';
    this.issues = issues;
  }
}
