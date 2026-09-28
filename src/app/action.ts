/**
 * defineAction(): a complete, verified HTTP endpoint for one manifest action.
 *
 *   POST  →  verify the Wire call (401 / 413 / 503)
 *         →  parse and validate input against the action's `input` schema (400)
 *         →  handler(input, ctx), bounded by the action's timeout (504)
 *         →  validate output against the action's `output` schema (500)
 *         →  200 application/json
 *
 * Error bodies are `{ "error": { "code", "message" } }`. PROVISIONAL until the
 * engine PR fixes the action response shape.
 */
import { WireActionAuthError, WireActionError } from './errors.js';
import {
  assertManifest,
  MAX_ACTION_TIMEOUT_MS,
  type ActionName,
  type ManifestAction,
  type WireManifest,
} from './manifest.js';
import type { ReplayStore } from './replay.js';
import { compileSchema, type SchemaIssue } from './schema.js';
import {
  actionAudience,
  checkJwksUrl,
  DEFAULT_WIRE_JWKS_URL,
  normalizeActionUrl,
  verifyWireActionRequest,
  type WireActionClaims,
} from './verify.js';

/** What a handler knows about the call. */
export interface ActionContext {
  /** The connection. Key per-install state by (connectionId, containerId), never connectionId alone. */
  connectionId: string;
  containerId: string;
  action: string;
  /** The tool call this action is part of (X-Wire-Request-Id). Unsigned: for log correlation only. */
  requestId: string | null;
  claims: WireActionClaims;
  /** Aborts when the action's time budget runs out. Pass it to your fetches. */
  signal: AbortSignal;
  /** The original request (its body has already been read). */
  request: Request;
}

export type ActionHandler<I, O> = (input: I, ctx: ActionContext) => O | Promise<O>;

export interface DefineActionOptions {
  /** Your agent id, when it is not the manifest's (the `aud` is its manifest form). Defaults to the manifest's `app.id`. */
  agentId?: string;
  /** @deprecated Use `agentId`. The exact `aud` to require. */
  appId?: string;
  /** Wire's JWKS URL. Defaults to DEFAULT_WIRE_JWKS_URL. */
  jwksUrl?: string;
  /**
   * The public URL Wire calls this action at, checked against the token's
   * `wire_url`. Defaults to `request.url`. Behind a proxy or TLS terminator
   * that changes what the agent sees, set it to the action's `url` from your
   * manifest. See `normalizeActionUrl` for the comparison.
   */
  url?: string;
  /**
   * Shared, atomic replay store. The default is in memory, per instance —
   * pass a shared one if the agent runs more than one instance.
   */
  replayStore?: ReplayStore;
  /** Clock for tests. */
  now?: () => Date;
  /** Clock skew tolerance in seconds (default 30). */
  clockToleranceSec?: number;
  /** Largest accepted request body (default 1 MiB). */
  maxBodyBytes?: number;
  /**
   * How long before Wire's deadline to give up and answer 504, so the answer
   * arrives while Wire is still waiting. Default 250 ms.
   */
  deadlineMarginMs?: number;
  /**
   * Called with every failure: verification failures, handler exceptions,
   * invalid output, timeouts. The default logs to console.error only what the
   * app operator must act on (Wire's keys or the replay store unreachable,
   * handler exceptions, invalid output, timeouts) and skips routine 401s, so
   * unauthenticated traffic cannot flood the log. It logs codes, value paths
   * and the error's name, never input or output values.
   */
  onError?: (event: ActionErrorEvent) => void;
}

export interface ActionErrorEvent {
  action: string;
  code: string;
  status: number;
  error?: unknown;
  issues?: SchemaIssue[];
}

/** A verified endpoint for one action. */
export interface WireActionEndpoint {
  readonly action: ManifestAction;
  /** Web-standard handler: Cloudflare Workers, Bun, Deno, Node 18+ servers that speak Request/Response. */
  fetch(request: Request): Promise<Response>;
  /** Hono: `app.post('/geocode', geocode.hono)`. Mount before any middleware that reads the body. */
  hono(c: { req: { raw: Request } }): Promise<Response>;
}

/**
 * Build the endpoint for `name`, one of the manifest's actions. Throws at
 * definition time if the manifest declares no such action.
 */
export function defineAction<
  I = Record<string, unknown>,
  O = Record<string, unknown>,
  M extends WireManifest = WireManifest,
>(manifest: M, name: ActionName<M> | (string & {}), handler: ActionHandler<I, O>, options: DefineActionOptions = {}): WireActionEndpoint {
  // A manifest that did not come through defineManifest() gets the same checks
  // here, so a bad timeout or schema fails now rather than on every call.
  assertManifest(manifest);
  checkJwksUrl(options.jwksUrl ?? DEFAULT_WIRE_JWKS_URL);
  if (options.url !== undefined && normalizeActionUrl(options.url) === null) {
    throw new TypeError('defineAction: url must be an absolute http(s) URL');
  }
  const found = manifest.actions?.find((a) => a.name === name);
  if (!found) {
    throw new TypeError(`defineAction: the manifest declares no action named "${String(name)}"`);
  }
  const action: ManifestAction = found;
  if (typeof handler !== 'function') throw new TypeError('defineAction: handler must be a function');

  const appId = actionAudience(options) ?? manifest.app?.id;
  if (!appId) throw new TypeError('defineAction: no agent id (set manifest.app.id or options.agentId)');

  const checkInput = compileSchema(action.input, 'input');
  const checkOutput = compileSchema(action.output, 'output');
  const budgetMs = Math.min(action.timeout_ms ?? MAX_ACTION_TIMEOUT_MS, MAX_ACTION_TIMEOUT_MS);
  const marginMs = Math.max(0, options.deadlineMarginMs ?? 250);
  const report = options.onError ?? defaultOnError;

  const fail = (status: number, code: string, message: string, event?: Partial<ActionErrorEvent>) => {
    if (event) report({ action: action.name, code, status, ...event });
    return json(status, { error: { code, message } });
  };

  async function handle(request: Request): Promise<Response> {
    // Wire's clock starts when it sends; ours starts on receipt. Everything,
    // including verification, spends the same budget.
    const deadline = Date.now() + budgetMs - marginMs;

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } }), {
        status: 405,
        headers: { 'content-type': 'application/json', allow: 'POST' },
      });
    }

    let verified;
    let body: Uint8Array<ArrayBuffer>;
    try {
      ({ verified, body } = await verifyWireActionRequest(request, {
        appId,
        action: action.name,
        url: options.url,
        jwksUrl: options.jwksUrl,
        replayStore: options.replayStore,
        now: options.now,
        clockToleranceSec: options.clockToleranceSec,
        maxBodyBytes: options.maxBodyBytes,
      }));
    } catch (err) {
      if (err instanceof WireActionAuthError) {
        return fail(err.status, err.code, err.message, { error: err });
      }
      return fail(500, 'INTERNAL_ERROR', 'Verification failed unexpectedly', { error: err });
    }

    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch {
      return fail(400, 'INVALID_JSON', 'Request body is not valid JSON');
    }
    const inputIssues = safeCheck(checkInput, input);
    if (inputIssues.length) {
      return json(400, {
        error: { code: 'INVALID_INPUT', message: 'Input does not match the action input schema', issues: inputIssues },
      });
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return fail(504, 'TIMEOUT', 'Action time budget spent before the handler ran', {});

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('Wire action deadline reached'));
        resolve(TIMED_OUT);
      }, remaining);
    });

    let output: unknown;
    try {
      const ctx: ActionContext = {
        connectionId: verified.connectionId,
        containerId: verified.containerId,
        action: verified.action,
        requestId: verified.requestId,
        claims: verified.claims,
        signal: controller.signal,
        request,
      };
      output = await Promise.race([Promise.resolve().then(() => handler(input as I, ctx)), timedOut]);
    } catch (err) {
      if (err instanceof WireActionError) return fail(clampStatus(err.status), err.code, err.message);
      return fail(500, 'HANDLER_ERROR', 'The action failed', { error: err });
    } finally {
      clearTimeout(timer);
    }
    if (output === TIMED_OUT) return fail(504, 'TIMEOUT', 'The action did not finish in time', {});

    const outputIssues = safeCheck(checkOutput, output);
    if (outputIssues.length) {
      return fail(500, 'INVALID_OUTPUT', 'The action returned output that does not match its schema', {
        issues: outputIssues,
      });
    }
    return json(200, output);
  }

  return {
    action,
    fetch: handle,
    hono: (c) => handle(c.req.raw),
  };
}

const TIMED_OUT: unique symbol = Symbol('timed out');

/** A validator that throws (an unsupported value, a schema quirk) is a failed check, not a crash. */
function safeCheck(check: (v: unknown) => SchemaIssue[], value: unknown): SchemaIssue[] {
  if (value === undefined) return [{ path: '', message: 'No value' }];
  try {
    return check(value);
  } catch (err) {
    return [{ path: '', message: (err as Error)?.message ?? 'Validation failed' }];
  }
}

/** A deliberate error must still be an error status Response accepts. */
function clampStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function defaultOnError(event: ActionErrorEvent): void {
  // Routine auth failures (401/413) are the caller's problem, and logging
  // them would let anyone fill the log.
  if (event.status === 401 || event.status === 413) return;
  // Paths only: an issue's message can quote a schema value.
  const issues = event.issues?.map((i) => i.path || '(root)').join(', ');
  const name = event.error instanceof Error ? event.error.name : '';
  console.error(
    `[wire action ${event.action}] ${event.status} ${event.code}${issues ? ` at ${issues}` : ''}${name ? ` (${name})` : ''}`
  );
}
