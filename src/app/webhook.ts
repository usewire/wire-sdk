/**
 * Verify and serve Wire's install webhooks (SUP-958).
 *
 * Wire POSTs a signed event to an agent's webhook URL whenever one of its
 * installs changes. The request:
 *
 *   Authorization:      Bearer <JWT>
 *   X-Wire-Event-Id:    the event id (also the JWT's `wire_event` and the body's `id`)
 *   X-Wire-Event-Type:  the event type, e.g. `install.created`
 *   body                { id, type, createdAt, install }
 *
 * The JWT is signed by Wire (EdDSA) with the same published keys as action
 * calls (`/.well-known/wire-actions-jwks.json`), header
 * `{ alg: "EdDSA", typ: "wire-webhook+jwt", kid }`, so an action token is
 * never a webhook and a webhook token is never an action call. What a valid
 * request proves:
 *
 *   - Wire sent it, for THIS agent (`iss` "wire", `aud` the agent id), just now
 *     (60-second lifetime, small clock tolerance);
 *   - at THIS URL (`wire_url`, compared the same way action URLs are);
 *   - with THIS body (`wire_body_sha256` over the raw bytes, checked before
 *     the body is parsed);
 *   - about THIS event (`wire_event` equals `X-Wire-Event-Id` and the body's `id`).
 *
 * DELIVERY IS AT LEAST ONCE. Wire retries anything but a 2xx for about 24
 * hours (410 Gone stops it at once), and an event keeps its id on every retry.
 * The verifier records each event id in the replay store and refuses a second
 * one with DUPLICATE_EVENT (status 200: acknowledge it). If handling fails,
 * `release()` the event before answering 5xx so Wire's retry is processed.
 *
 * The wire contract is wire-platform `packages/plane-contracts/src/webhooks.ts`;
 * the constants below restate it (the engine does not own webhooks, so there
 * is nothing to vendor).
 */
import { decodeProtectedHeader, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { WireActionAuthError, WireWebhookError, type WireWebhookErrorCode } from './errors.js';
import { InstallShapeError, installFromWire, type WireInstall } from './installs.js';
import type { ReplayStore } from './replay.js';
import {
  checkJwksUrl,
  DEFAULT_CLOCK_TOLERANCE_SEC,
  DEFAULT_WIRE_JWKS_URL,
  defaultReplayStoreWithWarning,
  normalizeActionUrl,
  readBody,
  remoteJwks,
  sha256Base64Url,
  timingSafeEqual,
} from './verify.js';

// ─── The wire format (plane-contracts webhooks.ts) ──────────────────────────

/** Header `typ` of a webhook JWT. */
export const WIRE_WEBHOOK_JWT_TYP = 'wire-webhook+jwt';
/** `iss` of a webhook JWT. */
export const WIRE_WEBHOOK_ISSUER = 'wire';
/** Lifetime of a webhook JWT (`exp - iat`), seconds. */
export const WIRE_WEBHOOK_TOKEN_LIFETIME_SEC = 60;
export const WIRE_WEBHOOK_EVENT_ID_HEADER = 'X-Wire-Event-Id';
export const WIRE_WEBHOOK_EVENT_TYPE_HEADER = 'X-Wire-Event-Type';
/** Claim names of a webhook JWT. */
export const WIRE_WEBHOOK_CLAIMS = {
  /** The event id. */
  event: 'wire_event',
  /** The exact URL the request was sent to (the registered webhook URL). */
  url: 'wire_url',
  /** base64url (no padding) SHA-256 of the exact request body bytes. */
  bodyHash: 'wire_body_sha256',
} as const;

/** Every install event Wire sends. */
export const WIRE_WEBHOOK_EVENT_TYPES = [
  'install.created',
  'install.upgraded',
  'install.disconnected',
  'install.uninstalled',
  'install.claimed',
  'install.expiring',
  'install.expired',
  'install.container_deleted',
] as const;
export type WireWebhookEventType = (typeof WIRE_WEBHOOK_EVENT_TYPES)[number];

/** Default ceiling on the body read (Wire's payloads are at most 32 KiB). */
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
/**
 * How long an event id is remembered, seconds. Wire's retries span about 24
 * hours; a week also covers the same event being emitted again later.
 */
export const DEFAULT_WEBHOOK_DEDUPE_TTL_SEC = 7 * 24 * 60 * 60;

const MAX_CLOCK_TOLERANCE_SEC = 60;
const MAX_TOKEN_CHARS = 8 * 1024;
const MAX_ID_CHARS = 256;
const MAX_URL_CHARS = 2048;
const SHA256_B64URL_RE = /^[A-Za-z0-9_-]{43}$/;
const BEARER_RE = /^Bearer[ ]+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;
/** A jti is remembered for as long as any instance could still accept its token. */
const JTI_TTL_SEC = WIRE_WEBHOOK_TOKEN_LIFETIME_SEC + 2 * MAX_CLOCK_TOLERANCE_SEC + 1;

// ─── Types ──────────────────────────────────────────────────────────────────

/** A verified webhook event. `install` is the install as it was when the event happened. */
export interface WireWebhookEvent<T extends string = WireWebhookEventType> {
  /** The event id (`evt_…`). The same on every retry: dedupe on it. */
  id: string;
  type: T;
  createdAt: Date;
  install: WireInstall;
}

/** The payload of a verified webhook JWT. */
export interface WireWebhookClaims extends JWTPayload {
  iss: string;
  aud: string | string[];
  jti: string;
  iat: number;
  exp: number;
  wire_event: string;
  wire_url: string;
  wire_body_sha256: string;
}

/** A webhook request as raw parts, for servers that do not hand you a Fetch Request. */
export interface RawWebhookRequest {
  headers: Headers | Record<string, string | string[] | undefined>;
  /** The EXACT body bytes received. Never a re-serialized parsed body. */
  rawBody: Uint8Array | ArrayBuffer | string;
  /** The URL the request arrived at: absolute, or a path when `origin` is set. Optional when `url` is set. */
  url?: string;
}

export interface VerifyWireWebhookOptions {
  /**
   * Your agent id: the `aud` Wire signs for (`geo-app`); the manifest form
   * (`geo_app`) names the same agent and is accepted too. Required unless the
   * deprecated `appId` is set.
   */
  agentId?: string;
  /** @deprecated Use `agentId`. */
  appId?: string;
  /**
   * The public URL Wire calls: the webhook URL registered on your agent. Checked
   * against the token's `wire_url`. Defaults to the request's URL (or `origin`
   * plus its path). Set it when a proxy or TLS terminator changes what the
   * agent sees.
   */
  url?: string;
  /**
   * The public origin (`https://someday.example`), used with the request's
   * path and query when `url` is not set. For servers that see plain http
   * behind TLS termination.
   */
  origin?: string;
  /** Wire's JWKS URL. Defaults to `${baseUrl}/.well-known/wire-actions-jwks.json`. */
  jwksUrl?: string;
  /** Wire's origin, used for the JWKS URL when `jwksUrl` is not set. Defaults to https://app.usewire.io. */
  baseUrl?: string;
  /**
   * Where used jtis and received event ids are recorded. Defaults to a
   * process-wide in-memory store, which only protects one instance and forgets
   * everything on restart. In production pass a shared, durable, atomic store
   * (Redis `SET NX EX`, a Durable Object, a unique-key INSERT) that implements
   * `release`, or set `dedupe: false` and dedupe on `event.id` in your own
   * database, in the same transaction as the work.
   */
  replayStore?: ReplayStore;
  /** Record event ids and refuse repeats with DUPLICATE_EVENT. Default true. */
  dedupe?: boolean;
  /** How long an event id is remembered, seconds. Default 7 days. */
  dedupeTtlSec?: number;
  /** The current time, for tests. */
  now?: Date | (() => Date);
  /** Clock skew tolerance in seconds. Default 30, capped at 60. */
  clockToleranceSec?: number;
  /** Largest body read. Default 64 KiB. */
  maxBodyBytes?: number;
}

export interface VerifiedWireWebhook {
  event: WireWebhookEvent<WireWebhookEventType | (string & {})>;
  /** Every verified claim, for logging or audit. */
  claims: WireWebhookClaims;
  /** The parsed body, as sent (for fields this SDK version does not type). */
  raw: Record<string, unknown>;
  /**
   * Forget this event id, so Wire's retry of it is processed rather than
   * acknowledged as a duplicate. Call it when handling fails, before
   * answering 5xx. A no-op when dedupe is off or the store has no `release`.
   */
  release(): Promise<void>;
}

// ─── verifyWireWebhook ──────────────────────────────────────────────────────

/**
 * Verify a Wire webhook. Returns the typed event, or throws WireWebhookError
 * (its `status` is the HTTP status to answer with; DUPLICATE_EVENT is 200).
 *
 * Takes a Fetch `Request` (read from a clone, so it stays readable) or the raw
 * parts `{ headers, rawBody, url }`. The body is hashed exactly as received
 * and parsed only after the hash matches.
 */
export async function verifyWireWebhook(
  request: Request | RawWebhookRequest,
  options: VerifyWireWebhookOptions
): Promise<VerifiedWireWebhook> {
  return verifyWebhookInput(request instanceof Request ? request.clone() : request, options);
}

/** @internal defineWebhook consumes the request itself instead of cloning. */
export async function verifyWebhookInput(
  input: Request | RawWebhookRequest,
  options: VerifyWireWebhookOptions
): Promise<VerifiedWireWebhook> {
  const agentId = agentIdOption(options);
  if (!agentId) throw new TypeError('verifyWireWebhook: agentId is required');
  const audiences = audiencesFor(agentId);
  const expectedUrl = expectedWebhookUrl(input, options);
  const tolerance = Math.min(
    Math.max(0, options.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC),
    MAX_CLOCK_TOLERANCE_SEC
  );
  const jwks = remoteJwks(jwksUrlOf(options));
  const currentDate = options.now === undefined ? undefined : typeof options.now === 'function' ? options.now() : options.now;
  const headers = input instanceof Request ? input.headers : toHeaders(input.headers);

  // 1. The bearer.
  const auth = headers.get('authorization');
  if (!auth) throw new WireWebhookError('MISSING_TOKEN', 'Authorization: Bearer <token> required');
  const match = BEARER_RE.exec(auth.trim());
  if (!match || match[1].length > MAX_TOKEN_CHARS) {
    throw new WireWebhookError('MALFORMED_TOKEN', 'Authorization must be "Bearer <jwt>"');
  }
  const token = match[1];

  // 2. The header, before any key lookup: EdDSA, typed as a webhook, with a kid.
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new WireWebhookError('MALFORMED_TOKEN', 'Malformed JWT header');
  }
  if (header.alg !== 'EdDSA') throw new WireWebhookError('UNSUPPORTED_ALGORITHM', 'JWT alg must be EdDSA');
  if (header.typ !== WIRE_WEBHOOK_JWT_TYP) {
    throw new WireWebhookError('MALFORMED_TOKEN', `JWT typ must be ${WIRE_WEBHOOK_JWT_TYP}`);
  }
  if (typeof header.kid !== 'string' || !header.kid) throw new WireWebhookError('UNKNOWN_KEY', 'JWT header has no kid');

  // 3. Signature and registered claims.
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      algorithms: ['EdDSA'],
      typ: WIRE_WEBHOOK_JWT_TYP,
      issuer: WIRE_WEBHOOK_ISSUER,
      audience: audiences,
      currentDate,
      clockTolerance: tolerance,
      maxTokenAge: WIRE_WEBHOOK_TOKEN_LIFETIME_SEC + tolerance,
      requiredClaims: [
        'iss',
        'aud',
        'jti',
        'iat',
        'exp',
        WIRE_WEBHOOK_CLAIMS.event,
        WIRE_WEBHOOK_CLAIMS.url,
        WIRE_WEBHOOK_CLAIMS.bodyHash,
      ],
    }));
  } catch (err) {
    throw mapJoseError(err);
  }

  // 4. Claims jose does not check: one audience, the lifetime, the URL, the event.
  const claims = checkClaims(payload, audiences);
  if (normalizeActionUrl(claims.wire_url) !== expectedUrl) {
    throw new WireWebhookError('URL_MISMATCH', `Token was issued for a different URL than ${expectedUrl}`);
  }
  const headerEventId = headers.get(WIRE_WEBHOOK_EVENT_ID_HEADER);
  if (headerEventId !== claims.wire_event) {
    throw new WireWebhookError('EVENT_MISMATCH', `${WIRE_WEBHOOK_EVENT_ID_HEADER} does not match the signed event id`);
  }

  // 5. The body: the exact bytes received, hashed before anything reads them.
  const maxBytes = options.maxBodyBytes ?? DEFAULT_WEBHOOK_MAX_BODY_BYTES;
  const body = await rawBodyOf(input, maxBytes);
  if (!timingSafeEqual(await sha256Base64Url(body), claims.wire_body_sha256)) {
    throw new WireWebhookError('BODY_MISMATCH', 'Request body does not match the signed hash');
  }

  // 6. Only now parse it, and bind it to the token and headers.
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new WireWebhookError('INVALID_EVENT', 'Webhook body is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new WireWebhookError('INVALID_EVENT', 'Webhook body is not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.id !== claims.wire_event) {
    throw new WireWebhookError('EVENT_MISMATCH', "The body's id does not match the signed event id");
  }
  if (typeof obj.type !== 'string' || !obj.type) throw new WireWebhookError('INVALID_EVENT', 'Webhook body has no type');
  const headerType = headers.get(WIRE_WEBHOOK_EVENT_TYPE_HEADER);
  if (headerType !== null && headerType !== obj.type) {
    throw new WireWebhookError('EVENT_MISMATCH', `${WIRE_WEBHOOK_EVENT_TYPE_HEADER} does not match the body's type`);
  }
  const createdAt = typeof obj.createdAt === 'string' ? new Date(obj.createdAt) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) {
    throw new WireWebhookError('INVALID_EVENT', 'Webhook body has no valid createdAt');
  }
  let install: WireInstall;
  try {
    install = installFromWire(obj.install);
  } catch (err) {
    if (err instanceof InstallShapeError) throw new WireWebhookError('INVALID_EVENT', err.message);
    throw err;
  }

  // 7. Replay, then dedupe, last: only an otherwise valid request spends a key.
  const store = options.replayStore ?? defaultReplayStoreWithWarning();
  const aud = audiences[0];
  if (!(await mark(store, `wire-webhook|jti|${aud}|${claims.jti}`, JTI_TTL_SEC))) {
    throw new WireWebhookError('REPLAYED', 'This request has already been received (jti reused)');
  }
  let release = async (): Promise<void> => {};
  if (options.dedupe !== false) {
    const eventKey = `wire-webhook|event|${aud}|${claims.wire_event}`;
    const ttl = Math.max(1, Math.floor(options.dedupeTtlSec ?? DEFAULT_WEBHOOK_DEDUPE_TTL_SEC));
    if (!(await mark(store, eventKey, ttl))) {
      throw new WireWebhookError('DUPLICATE_EVENT', `Event ${claims.wire_event} has already been received`);
    }
    let released = false;
    release = async () => {
      if (released) return;
      released = true;
      await store.release?.(eventKey);
    };
  }

  return {
    event: { id: claims.wire_event, type: obj.type, createdAt, install },
    claims,
    raw: obj,
    release,
  };
}

// ─── defineWebhook ──────────────────────────────────────────────────────────

/** What a webhook handler knows about the delivery. */
export interface WebhookContext {
  claims: WireWebhookClaims;
  /** The parsed body, as sent. */
  raw: Record<string, unknown>;
  /** The original request (its body has already been read), when there is one. */
  request: Request;
}

/**
 * Handle one event. Return nothing to answer 200. Return a Response to answer
 * with it: a non-2xx makes Wire retry, and `new Response(null, { status: 410 })`
 * tells Wire to stop sending this event. Throw to answer 500, and Wire retries.
 */
export type WebhookHandler<T extends string = WireWebhookEventType | (string & {})> = (
  event: WireWebhookEvent<T>,
  ctx: WebhookContext
) => void | Response | Promise<void | Response>;

/** One handler per event type; `default` takes any type without its own. Types with neither are acknowledged and ignored. */
export type WebhookHandlers = { [K in WireWebhookEventType]?: WebhookHandler<K> } & {
  default?: WebhookHandler;
};

export interface DefineWebhookOptions extends Omit<VerifyWireWebhookOptions, 'now'> {
  /** Clock for tests. */
  now?: () => Date;
  /**
   * Called with every failure: verification failures, handler exceptions and
   * non-2xx handler answers. The default logs only what the operator must act
   * on (JWKS or replay store unreachable, handler failures) and skips routine
   * 401s, with codes and event ids only.
   */
  onError?: (event: WebhookErrorEvent) => void;
}

export interface WebhookErrorEvent {
  code: string;
  status: number;
  eventId?: string;
  type?: string;
  error?: unknown;
}

/** A verified webhook endpoint. */
export interface WireWebhookEndpoint {
  /** Web-standard handler: Cloudflare Workers, Bun, Deno, Node 18+ servers that speak Request/Response. */
  fetch(request: Request): Promise<Response>;
  /** Hono: `app.post('/webhooks/wire', webhook.hono)`. Mount before any middleware that reads the body. */
  hono(c: { req: { raw: Request } }): Promise<Response>;
}

/**
 * A complete webhook endpoint:
 *
 *   POST  →  verify (401 / 413 / 503; a repeated event id answers 200, not handled again)
 *         →  handler(event, ctx)
 *         →  200 { "received": true }
 *
 * A handler that throws answers 500 and its event id is released, so Wire's
 * retry is handled. Error bodies are `{ "error": { "code", "message" } }`.
 * Keep handlers well under Wire's 8-second timeout: acknowledge, then do slow
 * work in the background (a queue, `ctx.waitUntil`).
 */
export function defineWebhook(
  handlers: WebhookHandler | WebhookHandlers,
  options: DefineWebhookOptions
): WireWebhookEndpoint {
  const agentId = agentIdOption(options);
  if (!agentId) throw new TypeError('defineWebhook: agentId is required');
  audiencesFor(agentId);
  checkJwksUrl(jwksUrlOf(options));
  if (options.url !== undefined && normalizeActionUrl(options.url) === null) {
    throw new TypeError('defineWebhook: url must be an absolute http(s) URL');
  }
  if (options.origin !== undefined) originOf(options.origin);
  const pick = handlerPicker(handlers);
  const report = options.onError ?? defaultOnError;

  const fail = (status: number, code: string, message: string, event?: Partial<WebhookErrorEvent>) => {
    if (event) report({ code, status, ...event });
    return json(status, { error: { code, message } });
  };

  async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } }), {
        status: 405,
        headers: { 'content-type': 'application/json', allow: 'POST' },
      });
    }

    let verified: VerifiedWireWebhook;
    try {
      verified = await verifyWebhookInput(request, options);
    } catch (err) {
      if (err instanceof WireWebhookError) {
        if (err.code === 'DUPLICATE_EVENT') return json(200, { received: true, duplicate: true });
        return fail(err.status, err.code, err.message, { error: err });
      }
      return fail(500, 'INTERNAL_ERROR', 'Verification failed unexpectedly', { error: err });
    }

    const { event } = verified;
    const handler = pick(event.type);
    if (!handler) return json(200, { received: true, ignored: true });

    let answer: void | Response;
    try {
      answer = await handler(event as WireWebhookEvent<never>, { claims: verified.claims, raw: verified.raw, request });
    } catch (err) {
      await verified.release().catch(() => {});
      return fail(500, 'HANDLER_ERROR', 'The webhook handler failed', { eventId: event.id, type: event.type, error: err });
    }
    if (answer instanceof Response) {
      if (answer.status < 200 || answer.status >= 300) {
        // 410 stops Wire's retries, so there is no retry to process; anything else is retried.
        if (answer.status !== 410) await verified.release().catch(() => {});
        report({ code: `HANDLER_${answer.status}`, status: answer.status, eventId: event.id, type: event.type });
      }
      return answer;
    }
    return json(200, { received: true });
  }

  return { fetch: handle, hono: (c) => handle(c.req.raw) };
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** The accepted `aud` values: the agent id first, then its manifest form when different. */
/** The agent id an options object names: `agentId`, or the deprecated `appId`. */
function agentIdOption(options: { agentId?: unknown; appId?: unknown } | undefined): string | null {
  const v = options?.agentId ?? options?.appId;
  return typeof v === 'string' && v ? v : null;
}

function audiencesFor(id: string): string[] {
  const agentId = id.replace(/_/g, '-');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(agentId)) throw new TypeError(`"${id}" is not an agent id`);
  const manifestId = agentId.replace(/-/g, '_');
  return manifestId === agentId ? [agentId] : [agentId, manifestId];
}

function jwksUrlOf(options: Pick<VerifyWireWebhookOptions, 'jwksUrl' | 'baseUrl'>): string {
  if (options.jwksUrl) return options.jwksUrl;
  if (options.baseUrl) return `${options.baseUrl.replace(/\/+$/, '')}/.well-known/wire-actions-jwks.json`;
  return DEFAULT_WIRE_JWKS_URL;
}

function originOf(origin: string): string {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    throw new TypeError('origin is not an absolute URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new TypeError('origin must be http(s)');
  return u.origin;
}

function expectedWebhookUrl(input: Request | RawWebhookRequest, options: VerifyWireWebhookOptions): string {
  let candidate: string | undefined;
  if (options.url !== undefined) {
    candidate = options.url;
  } else {
    const seen = input.url;
    if (options.origin !== undefined) {
      if (!seen) throw new TypeError('verifyWireWebhook: the request has no url; pass url');
      let path: string;
      try {
        const u = new URL(seen, 'http://placeholder.invalid');
        path = `${u.pathname}${u.search}`;
      } catch {
        throw new TypeError('verifyWireWebhook: the request url is not a URL; pass url');
      }
      candidate = `${originOf(options.origin)}${path}`;
    } else {
      candidate = seen;
    }
  }
  const normalized = candidate ? normalizeActionUrl(candidate) : null;
  if (normalized === null) {
    throw new TypeError(
      options.url !== undefined
        ? 'verifyWireWebhook: url is not an absolute http(s) URL'
        : 'verifyWireWebhook: the request url is not an absolute http(s) URL; pass url or origin'
    );
  }
  return normalized;
}

function toHeaders(h: RawWebhookRequest['headers']): Headers {
  if (h instanceof Headers) return h;
  const out = new Headers();
  for (const [k, v] of Object.entries(h ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) out.append(k, item);
    else out.set(k, v);
  }
  return out;
}

async function rawBodyOf(input: Request | RawWebhookRequest, maxBytes: number): Promise<Uint8Array> {
  if (input instanceof Request) {
    try {
      return await readBody(input, maxBytes);
    } catch (err) {
      if (err instanceof WireActionAuthError && err.code === 'BODY_TOO_LARGE') {
        throw new WireWebhookError('BODY_TOO_LARGE', err.message);
      }
      throw err;
    }
  }
  const b = input.rawBody;
  const bytes =
    typeof b === 'string' ? new TextEncoder().encode(b) : b instanceof ArrayBuffer ? new Uint8Array(b) : b instanceof Uint8Array ? b : null;
  if (!bytes) throw new TypeError('verifyWireWebhook: rawBody must be a Uint8Array, ArrayBuffer or string');
  if (bytes.byteLength > maxBytes) throw new WireWebhookError('BODY_TOO_LARGE', `Body exceeds ${maxBytes} bytes`);
  return bytes;
}

async function mark(store: ReplayStore, key: string, ttl: number): Promise<boolean> {
  try {
    return await store.markUsed(key, ttl);
  } catch (err) {
    throw new WireWebhookError('REPLAY_STORE_UNAVAILABLE', 'Replay store unavailable', { cause: err });
  }
}

function mapJoseError(err: unknown): WireWebhookError {
  if (err instanceof WireWebhookError) return err;
  // The shared JWKS loader speaks in action-error codes; they mean the same here.
  if (err instanceof WireActionAuthError) {
    return new WireWebhookError(err.code as WireWebhookErrorCode, err.message, { cause: err });
  }
  if (err instanceof joseErrors.JWTExpired) return new WireWebhookError('TOKEN_EXPIRED', 'Token expired');
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'typ') return new WireWebhookError('MALFORMED_TOKEN', `JWT typ must be ${WIRE_WEBHOOK_JWT_TYP}`);
    if (err.claim === 'iss') return new WireWebhookError('INVALID_ISSUER', 'Token issuer is not Wire');
    if (err.claim === 'aud') return new WireWebhookError('INVALID_AUDIENCE', 'Token is not for this agent');
    return new WireWebhookError('INVALID_CLAIMS', `Claim check failed: ${err.claim} (${err.reason})`);
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return new WireWebhookError('BAD_SIGNATURE', 'Signature verification failed');
  }
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return new WireWebhookError('UNSUPPORTED_ALGORITHM', 'JWT alg must be EdDSA');
  return new WireWebhookError('MALFORMED_TOKEN', 'Malformed token', { cause: err });
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_CHARS;
}

function checkClaims(payload: JWTPayload, audiences: string[]): WireWebhookClaims {
  const aud = payload.aud;
  const single = Array.isArray(aud) ? (aud.length === 1 ? aud[0] : undefined) : aud;
  if (typeof single !== 'string' || !audiences.includes(single)) {
    throw new WireWebhookError('INVALID_AUDIENCE', 'Token is not for this agent');
  }
  const { iat, exp } = payload;
  if (typeof iat !== 'number' || typeof exp !== 'number' || exp <= iat || exp - iat > WIRE_WEBHOOK_TOKEN_LIFETIME_SEC) {
    throw new WireWebhookError('INVALID_CLAIMS', `Token lifetime must be at most ${WIRE_WEBHOOK_TOKEN_LIFETIME_SEC}s`);
  }
  if (!isId(payload.jti) || payload.jti.length < 8) throw new WireWebhookError('INVALID_CLAIMS', 'Missing or short jti');
  const p = payload as Record<string, unknown>;
  if (!isId(p[WIRE_WEBHOOK_CLAIMS.event])) throw new WireWebhookError('INVALID_CLAIMS', 'Missing event id');
  const url = p[WIRE_WEBHOOK_CLAIMS.url];
  if (typeof url !== 'string' || url.length > MAX_URL_CHARS || normalizeActionUrl(url) === null) {
    throw new WireWebhookError('INVALID_CLAIMS', 'Missing or malformed URL');
  }
  const hash = p[WIRE_WEBHOOK_CLAIMS.bodyHash];
  if (typeof hash !== 'string' || !SHA256_B64URL_RE.test(hash)) {
    throw new WireWebhookError('INVALID_CLAIMS', 'Missing or malformed body hash');
  }
  return payload as WireWebhookClaims;
}

function handlerPicker(handlers: WebhookHandler | WebhookHandlers): (type: string) => WebhookHandler | undefined {
  if (typeof handlers === 'function') return () => handlers;
  if (!handlers || typeof handlers !== 'object') {
    throw new TypeError('defineWebhook: pass a handler function or an object of handlers by event type');
  }
  const map = handlers as Record<string, unknown>;
  for (const [k, v] of Object.entries(map)) {
    if (typeof v !== 'function') throw new TypeError(`defineWebhook: the handler for "${k}" is not a function`);
    if (k !== 'default' && !(WIRE_WEBHOOK_EVENT_TYPES as readonly string[]).includes(k)) {
      throw new TypeError(`defineWebhook: "${k}" is not a Wire webhook event type`);
    }
  }
  return (type) => (Object.prototype.hasOwnProperty.call(map, type) ? map[type] : map.default) as WebhookHandler | undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function defaultOnError(event: WebhookErrorEvent): void {
  // Routine rejections are the sender's problem, and logging them would let anyone fill the log.
  if (event.status === 401 || event.status === 413 || event.status === 400) return;
  const name = event.error instanceof Error ? event.error.name : '';
  console.error(
    `[wire webhook] ${event.status} ${event.code}${event.eventId ? ` ${event.type} ${event.eventId}` : ''}${name ? ` (${name})` : ''}`
  );
}
