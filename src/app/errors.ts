/**
 * Errors thrown by the agent side (`@usewire/sdk/agent`, also `@usewire/sdk/app`).
 */
import { WireSdkError } from '../types.js';

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
  /** `aud` is not this agent's id. */
  | 'INVALID_AUDIENCE'
  /** `exp` has passed (beyond the clock tolerance). */
  | 'TOKEN_EXPIRED'
  /** A required claim is missing or malformed, `iat` is in the future, or the lifetime is too long. */
  | 'INVALID_CLAIMS'
  /** The token was minted for a different action than the one this endpoint serves. */
  | 'ACTION_MISMATCH'
  /** The token's `wire_url` is not the URL this endpoint serves. */
  | 'URL_MISMATCH'
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
 * body, 503 when the agent itself could not check (JWKS or replay store down).
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

/** Why a Wire webhook request was not accepted. */
export type WireWebhookErrorCode =
  /** No `Authorization: Bearer <jwt>` header. */
  | 'MISSING_TOKEN'
  /** The bearer is not a well-formed JWS compact token, or its `typ` is not `wire-webhook+jwt`. */
  | 'MALFORMED_TOKEN'
  /** The header `alg` is not EdDSA. */
  | 'UNSUPPORTED_ALGORITHM'
  /** The header has no `kid`, or the `kid` is not in Wire's JWKS even after a refetch. */
  | 'UNKNOWN_KEY'
  /** Wire's JWKS could not be fetched or parsed. Answer 503: Wire retries. */
  | 'JWKS_UNAVAILABLE'
  /** The signature does not verify against Wire's key. */
  | 'BAD_SIGNATURE'
  /** `iss` is not "wire". */
  | 'INVALID_ISSUER'
  /** `aud` is not this agent's id. */
  | 'INVALID_AUDIENCE'
  /** `exp` has passed (beyond the clock tolerance). */
  | 'TOKEN_EXPIRED'
  /** A required claim is missing or malformed, `iat` is in the future, or the lifetime is too long. */
  | 'INVALID_CLAIMS'
  /** The token's `wire_url` is not the URL this endpoint serves. */
  | 'URL_MISMATCH'
  /** The request body does not hash to the token's `wire_body_sha256`. */
  | 'BODY_MISMATCH'
  /** The request body is larger than `maxBodyBytes`. */
  | 'BODY_TOO_LARGE'
  /**
   * The token's `wire_event`, the `X-Wire-Event-Id` header and the body's `id`
   * disagree (or the body's `type` and `X-Wire-Event-Type` do).
   */
  | 'EVENT_MISMATCH'
  /** The signed body is not a webhook event (not JSON, or missing `id`, `type`, `createdAt` or `install`). */
  | 'INVALID_EVENT'
  /** This `jti` has been seen before: a captured request replayed. */
  | 'REPLAYED'
  /** The replay store could not record the `jti` or event id. Answer 503: Wire retries. */
  | 'REPLAY_STORE_UNAVAILABLE'
  /**
   * A genuine event this agent has already received (Wire delivers at least
   * once). Not a failure: `status` is 200, so answering with it tells Wire the
   * event is handled and stops its retries.
   */
  | 'DUPLICATE_EVENT';

function webhookStatus(code: WireWebhookErrorCode): number {
  switch (code) {
    case 'DUPLICATE_EVENT':
      return 200;
    case 'INVALID_EVENT':
      return 400;
    case 'BODY_TOO_LARGE':
      return 413;
    case 'JWKS_UNAVAILABLE':
    case 'REPLAY_STORE_UNAVAILABLE':
      return 503;
    default:
      return 401;
  }
}

/**
 * A Wire webhook request was not accepted. `status` is the HTTP status to
 * answer with: 401 for a request that is not a genuine Wire webhook, 413 for
 * an oversized body, 400 for a signed body that is not an event, 503 when the
 * app could not check (JWKS or replay store down, so Wire retries), and 200
 * for DUPLICATE_EVENT, an event already received, which must be acknowledged.
 */
export class WireWebhookError extends Error {
  readonly code: WireWebhookErrorCode;
  readonly status: number;

  constructor(code: WireWebhookErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'WireWebhookError';
    this.code = code;
    this.status = webhookStatus(code);
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/**
 * A call to Wire's agent API (WireAgentClient) failed. `code` is Wire's error code
 * (`NOT_FOUND`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `REPLAY_DETECTED`,
 * `CREDENTIAL_REVOKED`, `RUNTIME_KEY_REQUIRED`, `UNKNOWN_AGENT`,
 * `AGENT_DISABLED`, `CONTAINER_UNAVAILABLE`, `UNAVAILABLE`, ...), or
 * `NETWORK_ERROR` / `HTTP_<status>` / `INVALID_RESPONSE` when Wire's answer
 * never arrived or was not the API's envelope. `status` is the HTTP status,
 * when there was one.
 *
 * `retryable` is true when the same call may succeed if made again: a network
 * error, 429, 502 (for `revokeInstall`: the agent's connections were revoked but
 * the container could not finish the uninstall yet), 503 or 504. Each call
 * signs a fresh token, so retrying is calling the method again.
 */
export class WireAgentApiError extends WireSdkError {
  readonly retryable: boolean;

  constructor(code: string, message: string, status?: number, details?: unknown, options?: { cause?: unknown }) {
    super(code, message, status, details);
    this.name = 'WireAgentApiError';
    this.retryable = code === 'NETWORK_ERROR' || (status !== undefined && RETRYABLE_STATUSES.has(status));
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * @deprecated Use `WireAgentApiError`. The same class: `instanceof` either name
 * matches the errors WireAgentClient throws.
 */
export const WireAppApiError = WireAgentApiError;
/** @deprecated Use `WireAgentApiError`. */
export type WireAppApiError = WireAgentApiError;
