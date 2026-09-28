/**
 * verifyWireWebhook / defineWebhook (SUP-958). Tokens and requests are built
 * the way wire-platform's WebhookDeliveryWorkflow builds them
 * (helpers/wire-signer.ts mirrors buildWebhookClaims + signWebhookJwt +
 * attemptWebhookDelivery), and each rejection differs from an accepted request
 * by one thing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  defineWebhook,
  MemoryReplayStore,
  toNodeHandler,
  verifyWireWebhook,
  WIRE_WEBHOOK_EVENT_TYPES,
  WireWebhookError,
  type DefineWebhookOptions,
  type ReplayStore,
  type VerifyWireWebhookOptions,
} from '../app/index.js';
import {
  EVENT_ID,
  installJson,
  makeKey,
  NOW,
  NOW_SEC,
  signAction,
  signWebhook,
  startJwksServer,
  uniqueUrl,
  WEBHOOK_URL,
  webhookBody,
  webhookRequest,
  type JwksServer,
  type TestKey,
} from './helpers/wire-signer.js';

let server: JwksServer;
let key: TestKey;
let rogue: TestKey;

beforeAll(async () => {
  key = await makeKey('wh-2026-09');
  rogue = await makeKey('wh-2026-09'); // same kid, different key: a forged signature
  server = await startJwksServer([key.publicJwk]);
});
afterAll(() => server.close());
afterEach(() => {
  server.keys = [key.publicJwk];
  server.status = 200;
});

function opts(extra: Partial<VerifyWireWebhookOptions> = {}): VerifyWireWebhookOptions {
  return {
    agentId: 'someday',
    jwksUrl: uniqueUrl(server),
    now: NOW,
    replayStore: new MemoryReplayStore(),
    ...extra,
  };
}

async function signed(body = webhookBody(), extra: Partial<Parameters<typeof signWebhook>[0]> = {}) {
  return signWebhook({ key, body, ...extra });
}

async function expectCode(p: Promise<unknown>, code: string, status = 401) {
  const err = await p.then(
    () => {
      throw new Error('expected verification to fail');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(WireWebhookError);
  expect((err as WireWebhookError).code).toBe(code);
  expect((err as WireWebhookError).status).toBe(status);
}

describe('verifyWireWebhook: accepted', () => {
  it('verifies a webhook signed the way Wire signs it, and returns the typed event', async () => {
    const body = webhookBody();
    const req = webhookRequest(await signed(body), body);
    const v = await verifyWireWebhook(req, opts());
    expect(v.event.id).toBe(EVENT_ID);
    expect(v.event.type).toBe('install.created');
    expect(v.event.createdAt).toEqual(new Date('2026-09-26T11:59:59.000Z'));
    expect(v.event.install.installId).toBe('ins_aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(v.event.install.connection.connectedAt).toBeInstanceOf(Date);
    expect(v.event.install.connection.status).toBe('active');
    expect(v.claims.wire_event).toBe(EVENT_ID);
    expect(v.claims.aud).toBe('someday');
    expect(v.raw.id).toBe(EVENT_ID);
    // Read from a clone: the request is still readable.
    expect(await req.text()).toBe(body);
  });

  it('maps a trial install (claimUrl, ephemeral expiry) and a revoked one (reason)', async () => {
    const body = webhookBody({
      type: 'install.expiring',
      install: installJson({
        agentUserId: null,
        claimed: false,
        claimUrl: 'https://app.usewire.io/onboarding/create-account?claimToken=t',
        container: {
          id: 'c1',
          name: 'Places',
          mcpEndpoint: 'https://x.mcp.usewire.io/container/c1/mcp',
          orgSlug: 'x',
          isEphemeral: true,
          ephemeralExpiresAt: '2026-09-28T00:00:00.000Z',
        },
      }),
    });
    const v = await verifyWireWebhook(webhookRequest(await signed(body), body, { type: 'install.expiring' }), opts());
    expect(v.event.install.agentUserId).toBeNull();
    expect(v.event.install.appUserId).toBeNull();
    expect(v.event.install.claimed).toBe(false);
    expect(v.event.install.claimUrl).toContain('claimToken=');
    expect(v.event.install.container.ephemeralExpiresAt).toEqual(new Date('2026-09-28T00:00:00.000Z'));

    const gone = webhookBody({
      id: 'evt_gone',
      type: 'install.container_deleted',
      install: installJson({
        container: { id: 'c1', name: null, mcpEndpoint: null, orgSlug: null, isEphemeral: false, ephemeralExpiresAt: null },
        connection: { status: 'revoked', reason: 'container_deleted', connectedAt: '2026-09-01T00:00:00.000Z', lastUsedAt: '2026-09-02T00:00:00.000Z' },
      }),
    });
    const g = await verifyWireWebhook(
      webhookRequest(await signed(gone, { eventId: 'evt_gone' }), gone, { eventId: 'evt_gone', type: 'install.container_deleted' }),
      opts()
    );
    expect(g.event.install.container.name).toBeNull();
    expect(g.event.install.connection).toMatchObject({ status: 'revoked', reason: 'container_deleted' });
    expect(g.event.install.connection.lastUsedAt).toEqual(new Date('2026-09-02T00:00:00.000Z'));
  });

  it("maps the install's versions and update link, and defaults them when absent", async () => {
    const upgradeUrl = 'https://app.usewire.io/containers/c1/connections?upgrade=someday#installed-agents';
    const body = webhookBody({
      install: installJson({ installedVersion: '0.1.0', latestVersion: '0.3.0', updateAvailable: true, upgradeUrl }),
    });
    const v = await verifyWireWebhook(webhookRequest(await signed(body), body), opts());
    expect(v.event.install).toMatchObject({ installedVersion: '0.1.0', latestVersion: '0.3.0', updateAvailable: true, upgradeUrl });

    // An older Wire sends none of the four.
    const old = webhookBody();
    const o = await verifyWireWebhook(webhookRequest(await signed(old), old), opts());
    expect(o.event.install.installedVersion).toBeNull();
    expect(o.event.install.latestVersion).toBeNull();
    expect(o.event.install.updateAvailable).toBe(false);
    expect(o.event.install.upgradeUrl).toBeUndefined();
  });

  it('takes raw parts: a header record, the raw body, and url or origin + path', async () => {
    const body = webhookBody();
    const token = await signed(body);
    const headers = { authorization: `Bearer ${token}`, 'x-wire-event-id': EVENT_ID, 'x-wire-event-type': 'install.created' };
    const a = await verifyWireWebhook({ headers, rawBody: body, url: WEBHOOK_URL }, opts());
    expect(a.event.id).toBe(EVENT_ID);
    // Behind TLS termination the server sees a path; origin supplies the public half.
    const b = await verifyWireWebhook(
      { headers: { ...headers, authorization: `Bearer ${await signed(body)}` }, rawBody: new TextEncoder().encode(body), url: '/hooks/wire?x=1' },
      opts({ origin: 'https://someday.example' })
    );
    expect(b.event.id).toBe(EVENT_ID);
    // Or the registered URL outright.
    const c = await verifyWireWebhook(
      { headers: { ...headers, authorization: `Bearer ${await signed(body)}` }, rawBody: body },
      opts({ url: WEBHOOK_URL })
    );
    expect(c.event.id).toBe(EVENT_ID);
  });

  it('the manifest form of the agent id names the same agent', async () => {
    const body = webhookBody();
    const v = await verifyWireWebhook(
      webhookRequest(await signed(body, { audience: 'geo-app' }), body),
      opts({ agentId: 'geo_app' })
    );
    expect(v.claims.aud).toBe('geo-app');
  });

  it('the deprecated appId option still names the agent', async () => {
    const body = webhookBody();
    const v = await verifyWireWebhook(webhookRequest(await signed(body), body), opts({ agentId: undefined, appId: 'someday' }));
    expect(v.claims.aud).toBe('someday');
  });

  it('reads an install with both user id fields (the payload during the rename) as agentUserId', async () => {
    const body = webhookBody({ install: installJson({ agentUserId: 'au_new', appUserId: 'au_new' }) });
    const v = await verifyWireWebhook(webhookRequest(await signed(body), body), opts());
    expect(v.event.install.agentUserId).toBe('au_new');
    expect(v.event.install.appUserId).toBe('au_new');
  });

  it('reads a pre-rename install: appUserId only, reason app_disconnected', async () => {
    const legacy = installJson({
      appUserId: 'au_old',
      connection: { status: 'revoked', reason: 'app_disconnected', connectedAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null },
    });
    delete legacy.agentUserId;
    const body = webhookBody({ type: 'install.disconnected', install: legacy });
    const v = await verifyWireWebhook(webhookRequest(await signed(body), body, { type: 'install.disconnected' }), opts());
    expect(v.event.install.agentUserId).toBe('au_old');
    expect(v.event.install.appUserId).toBe('au_old');
    expect(v.event.install.connection.reason).toBe('agent_disconnected');
  });

  it('agent_disconnected passes through as is', async () => {
    const body = webhookBody({
      type: 'install.disconnected',
      install: installJson({ connection: { status: 'revoked', reason: 'agent_disconnected', connectedAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null } }),
    });
    const v = await verifyWireWebhook(webhookRequest(await signed(body), body, { type: 'install.disconnected' }), opts());
    expect(v.event.install.connection.reason).toBe('agent_disconnected');
  });

  it('finds the JWKS from baseUrl', async () => {
    const body = webhookBody();
    const base = server.url.replace(/\/jwks\.json$/, '');
    // The test server answers the key set on any path.
    const v = await verifyWireWebhook(webhookRequest(await signed(body), body), opts({ jwksUrl: undefined, baseUrl: `${base}/b${Date.now()}` }));
    expect(v.event.id).toBe(EVENT_ID);
  });
});

describe('verifyWireWebhook: refused', () => {
  const body = webhookBody();

  it('no token, a malformed one, another algorithm', async () => {
    await expectCode(verifyWireWebhook(webhookRequest(null, body), opts()), 'MISSING_TOKEN');
    await expectCode(verifyWireWebhook(webhookRequest('not-a-jwt', body), opts()), 'MALFORMED_TOKEN');
    const hs = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IndpcmUtd2ViaG9vaytqd3QiLCJraWQiOiJ3aC0yMDI2LTA5In0.e30.c2ln';
    await expectCode(verifyWireWebhook(webhookRequest(hs, body), opts()), 'UNSUPPORTED_ALGORITHM');
  });

  it('TYP: an action token is not a webhook, and neither is an untyped one', async () => {
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body, { typ: 'wire-action+jwt' }), body), opts()), 'MALFORMED_TOKEN');
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body, { typ: null }), body), opts()), 'MALFORMED_TOKEN');
    // A genuine action-call token, replayed at the webhook URL.
    const action = await signAction({ key, body, appId: 'someday', url: WEBHOOK_URL });
    await expectCode(verifyWireWebhook(webhookRequest(action, body), opts()), 'MALFORMED_TOKEN');
  });

  it('KEY: no kid, an unknown kid, a forged signature', async () => {
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body, { kid: null }), body), opts()), 'UNKNOWN_KEY');
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body, { kid: 'nope' }), body), opts()), 'UNKNOWN_KEY');
    const forged = await signWebhook({ key: rogue, body });
    await expectCode(verifyWireWebhook(webhookRequest(forged, body), opts()), 'BAD_SIGNATURE');
  });

  it('ISS: only Wire', async () => {
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body, { iss: 'someday' }), body), opts()), 'INVALID_ISSUER');
  });

  it('AUD: another app, or several audiences', async () => {
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body, { audience: 'other-app' }), body), opts()), 'INVALID_AUDIENCE');
    await expectCode(
      verifyWireWebhook(webhookRequest(await signed(body, { audience: ['someday', 'other-app'] }), body), opts()),
      'INVALID_AUDIENCE'
    );
  });

  it('URL: a token for another URL, path or query', async () => {
    for (const url of ['https://evil.example/hooks/wire?x=1', 'https://someday.example/other?x=1', 'https://someday.example/hooks/wire?x=2']) {
      await expectCode(verifyWireWebhook(webhookRequest(await signed(body, { url }), body), opts()), 'URL_MISMATCH');
    }
    // The registered URL pins it even when the request URL agrees with the token.
    const t = await signed(body, { url: 'https://proxy.internal/hooks/wire?x=1' });
    await expectCode(
      verifyWireWebhook(webhookRequest(t, body, { url: 'https://proxy.internal/hooks/wire?x=1' }), opts({ url: WEBHOOK_URL })),
      'URL_MISMATCH'
    );
  });

  it('BODY: checked against the raw bytes before parsing', async () => {
    const token = await signed(body);
    await expectCode(verifyWireWebhook(webhookRequest(token, `${body} `), opts()), 'BODY_MISMATCH');
    const reserialized = JSON.stringify(JSON.parse(body), null, 2);
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body), reserialized), opts()), 'BODY_MISMATCH');
    // Unparseable bytes with a matching hash never get as far as a parse error unless signed.
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body), '{nope'), opts()), 'BODY_MISMATCH');
  });

  it('EVENT: token, header and body must name one event', async () => {
    // The header names another event.
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body), body, { eventId: 'evt_other' }), opts()), 'EVENT_MISMATCH');
    // No header at all.
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body), body, { eventId: null }), opts()), 'EVENT_MISMATCH');
    // The (signed) body is another event than the token's.
    const other = webhookBody({ id: 'evt_other' });
    await expectCode(verifyWireWebhook(webhookRequest(await signed(other), other), opts()), 'EVENT_MISMATCH');
    // The unsigned type header disagrees with the signed body.
    await expectCode(
      verifyWireWebhook(webhookRequest(await signed(body), body, { type: 'install.uninstalled' }), opts()),
      'EVENT_MISMATCH'
    );
  });

  it('TIME: expired, too long-lived, issued in the future', async () => {
    await expectCode(
      verifyWireWebhook(webhookRequest(await signed(body, { iat: NOW_SEC - 200, exp: NOW_SEC - 140 }), body), opts()),
      'TOKEN_EXPIRED'
    );
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body, { exp: NOW_SEC + 61 }), body), opts()), 'INVALID_CLAIMS');
    await expectCode(
      verifyWireWebhook(webhookRequest(await signed(body, { iat: NOW_SEC + 600, exp: NOW_SEC + 660 }), body), opts()),
      'INVALID_CLAIMS'
    );
    // Within the clock tolerance is fine.
    const late = await verifyWireWebhook(webhookRequest(await signed(body, { iat: NOW_SEC - 80, exp: NOW_SEC - 20 }), body), opts());
    expect(late.event.id).toBe(EVENT_ID);
  });

  it('CLAIMS: each required claim, and a short jti', async () => {
    for (const omit of ['jti', 'wire_event', 'wire_url', 'wire_body_sha256']) {
      await expectCode(verifyWireWebhook(webhookRequest(await signed(body, { omit: [omit] }), body), opts()), 'INVALID_CLAIMS');
    }
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body, { jti: 'short' }), body), opts()), 'INVALID_CLAIMS');
  });

  it('INVALID_EVENT (400): a signed body that is not an event', async () => {
    for (const b of ['{nope', '[]', JSON.stringify({ id: EVENT_ID, type: 'install.created', createdAt: '2026-09-26T00:00:00Z' })]) {
      await expectCode(verifyWireWebhook(webhookRequest(await signed(b), b), opts()), 'INVALID_EVENT', 400);
    }
  });

  it('BODY_TOO_LARGE (413)', async () => {
    const big = webhookBody({ pad: 'x'.repeat(70 * 1024) });
    await expectCode(verifyWireWebhook(webhookRequest(await signed(big), big), opts()), 'BODY_TOO_LARGE', 413);
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body), body), opts({ maxBodyBytes: 16 })), 'BODY_TOO_LARGE', 413);
  });

  it('JWKS down with nothing cached: 503 so Wire retries', async () => {
    server.status = 500;
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body), body), opts()), 'JWKS_UNAVAILABLE', 503);
  });
});

describe('verifyWireWebhook: replay and dedupe', () => {
  const body = webhookBody();

  it('REPLAY: the same request twice is refused', async () => {
    const o = opts();
    const token = await signed(body);
    await verifyWireWebhook(webhookRequest(token, body), o);
    await expectCode(verifyWireWebhook(webhookRequest(token, body), o), 'REPLAYED');
  });

  it("DEDUPE: Wire's retry of an event (new jti, same id) is DUPLICATE_EVENT, status 200", async () => {
    const o = opts();
    await verifyWireWebhook(webhookRequest(await signed(body), body), o);
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body), body), o), 'DUPLICATE_EVENT', 200);
  });

  it('release() lets the retry through, once', async () => {
    const o = opts();
    const first = await verifyWireWebhook(webhookRequest(await signed(body), body), o);
    await first.release();
    await first.release();
    const second = await verifyWireWebhook(webhookRequest(await signed(body), body), o);
    expect(second.event.id).toBe(EVENT_ID);
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body), body), o), 'DUPLICATE_EVENT', 200);
  });

  it('dedupe: false leaves deduplication to the app (the jti is still single use)', async () => {
    const o = opts({ dedupe: false });
    const token = await signed(body);
    await verifyWireWebhook(webhookRequest(token, body), o);
    await verifyWireWebhook(webhookRequest(await signed(body), body), o);
    await expectCode(verifyWireWebhook(webhookRequest(token, body), o), 'REPLAYED');
  });

  it('keys are per agent: another agent receiving the same event id is not a duplicate', async () => {
    const store = new MemoryReplayStore();
    await verifyWireWebhook(webhookRequest(await signed(body), body), opts({ replayStore: store }));
    const v = await verifyWireWebhook(
      webhookRequest(await signed(body, { audience: 'other-app' }), body),
      opts({ replayStore: store, agentId: 'other-app' })
    );
    expect(v.event.id).toBe(EVENT_ID);
  });

  it('remembers event ids for a week by default', async () => {
    const calls: [string, number][] = [];
    const store: ReplayStore = {
      markUsed: (k, ttl) => {
        calls.push([k, ttl]);
        return true;
      },
    };
    await verifyWireWebhook(webhookRequest(await signed(body), body), opts({ replayStore: store }));
    expect(calls.map(([k]) => k.split('|').slice(0, 3).join('|'))).toEqual(['wire-webhook|jti|someday', 'wire-webhook|event|someday']);
    expect(calls[0][1]).toBe(181);
    expect(calls[1][1]).toBe(7 * 24 * 3600);
  });

  it('a replay store that throws fails closed with 503', async () => {
    const store: ReplayStore = {
      markUsed: () => {
        throw new Error('down');
      },
    };
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body), body), opts({ replayStore: store })), 'REPLAY_STORE_UNAVAILABLE', 503);
  });

  it('a failed verification spends nothing', async () => {
    const o = opts();
    await expectCode(verifyWireWebhook(webhookRequest(await signed(body), `${body} `), o), 'BODY_MISMATCH');
    const v = await verifyWireWebhook(webhookRequest(await signed(body), body), o);
    expect(v.event.id).toBe(EVENT_ID);
  });
});

describe('verifyWireWebhook: options', () => {
  it('refuses a missing agentId, and a request URL it cannot bind', async () => {
    const body = webhookBody();
    await expect(verifyWireWebhook(webhookRequest(await signed(body), body), { ...opts(), agentId: '' })).rejects.toThrow(/agentId/);
    await expect(
      verifyWireWebhook({ headers: {}, rawBody: body, url: '/hooks/wire' }, opts())
    ).rejects.toThrow(/pass url or origin/);
  });
});

// ─── defineWebhook ──────────────────────────────────────────────────────────

function defOpts(extra: Partial<DefineWebhookOptions> = {}): DefineWebhookOptions {
  return {
    agentId: 'someday',
    jwksUrl: uniqueUrl(server),
    now: () => NOW,
    replayStore: new MemoryReplayStore(),
    onError: () => {},
    ...extra,
  };
}

async function deliver(endpoint: { fetch(r: Request): Promise<Response> }, body = webhookBody(), extra: Parameters<typeof webhookRequest>[2] = {}) {
  const type = (JSON.parse(body) as { type: string }).type;
  const id = (JSON.parse(body) as { id: string }).id;
  return endpoint.fetch(webhookRequest(await signWebhook({ key, body, eventId: id }), body, { type, eventId: id, ...extra }));
}

describe('defineWebhook', () => {
  it('answers 200 after the handler, with the typed event', async () => {
    const seen: string[] = [];
    const hook = defineWebhook((event) => {
      seen.push(`${event.type} ${event.install.installId}`);
    }, defOpts());
    const res = await deliver(hook);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(seen).toEqual(['install.created ins_aaaaaaaaaaaaaaaaaaaaaaaa']);
  });

  it('a duplicate is acknowledged (200) and not handled again', async () => {
    const handler = vi.fn();
    const hook = defineWebhook(handler, defOpts());
    expect((await deliver(hook)).status).toBe(200);
    const again = await deliver(hook);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a bad signature is 401 and the handler never runs', async () => {
    const handler = vi.fn();
    const onError = vi.fn();
    const hook = defineWebhook(handler, defOpts({ onError }));
    const body = webhookBody();
    const res = await hook.fetch(webhookRequest(await signWebhook({ key: rogue, body }), body));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BAD_SIGNATURE');
    expect(handler).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'BAD_SIGNATURE', status: 401 }));
  });

  it("a handler that throws answers 500, and Wire's retry is handled", async () => {
    let calls = 0;
    const hook = defineWebhook(() => {
      calls++;
      if (calls === 1) throw new Error('db down');
    }, defOpts());
    const first = await deliver(hook);
    expect(first.status).toBe(500);
    expect(((await first.json()) as { error: { code: string; message: string } }).error).toEqual({
      code: 'HANDLER_ERROR',
      message: 'The webhook handler failed',
    });
    const retry = await deliver(hook);
    expect(retry.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('dispatches by event type; default takes the rest; neither is acknowledged and ignored', async () => {
    const created = vi.fn();
    const fallback = vi.fn();
    const hook = defineWebhook({ 'install.created': created, default: fallback }, defOpts());
    await deliver(hook);
    await deliver(hook, webhookBody({ id: 'evt_2', type: 'install.claimed' }));
    expect(created).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0][0].type).toBe('install.claimed');

    const only = defineWebhook({ 'install.uninstalled': vi.fn() }, defOpts());
    const res = await deliver(only);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, ignored: true });
  });

  it('410 from the handler is passed through (Wire stops); another non-2xx releases the event for the retry', async () => {
    const gone = defineWebhook(() => new Response(null, { status: 410 }), defOpts());
    expect((await deliver(gone)).status).toBe(410);

    let n = 0;
    const busy = defineWebhook(() => (++n === 1 ? new Response(null, { status: 503 }) : undefined), defOpts());
    expect((await deliver(busy)).status).toBe(503);
    expect((await deliver(busy)).status).toBe(200);
    expect(n).toBe(2);
  });

  it('POST only', async () => {
    const hook = defineWebhook(vi.fn(), defOpts());
    const res = await hook.fetch(new Request(WEBHOOK_URL, { method: 'GET' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('the Hono adapter serves the raw request', async () => {
    const handler = vi.fn();
    const hook = defineWebhook(handler, defOpts());
    const body = webhookBody();
    const res = await hook.hono({ req: { raw: webhookRequest(await signWebhook({ key, body }), body) } });
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('the Node adapter reads the raw stream and answers', async () => {
    const handler = vi.fn();
    const hook = defineWebhook(handler, defOpts());
    const node = toNodeHandler(hook, { origin: 'https://someday.example' });
    const body = webhookBody();
    const token = await signWebhook({ key, body });
    const req = {
      method: 'POST',
      url: '/hooks/wire?x=1',
      headers: {
        host: 'internal:8080',
        authorization: `Bearer ${token}`,
        'x-wire-event-id': EVENT_ID,
        'x-wire-event-type': 'install.created',
        'content-type': 'application/json',
      },
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode(body.slice(0, 10));
        yield body.slice(10);
      },
    };
    const out: { status?: number; headers: Record<string, string>; body?: string } = { headers: {} };
    const res = {
      statusCode: 0,
      setHeader(k: string, v: string | string[]) {
        out.headers[k] = String(v);
      },
      end(chunk?: Uint8Array | string) {
        out.status = this.statusCode;
        out.body = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      },
    };
    await node(req, res);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body!)).toEqual({ received: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses a bad definition up front', () => {
    expect(() => defineWebhook(vi.fn(), { ...defOpts(), agentId: '' })).toThrow(/agentId/);
    expect(() => defineWebhook(vi.fn(), { ...defOpts(), agentId: undefined, appId: 'someday' })).not.toThrow();
    expect(() => defineWebhook({ 'install.nope': vi.fn() } as never, defOpts())).toThrow(/not a Wire webhook event type/);
    expect(() => defineWebhook(vi.fn(), defOpts({ url: '/relative' }))).toThrow(/url/);
    expect(() => defineWebhook(vi.fn(), defOpts({ jwksUrl: 'http://example.com/jwks' }))).toThrow(/https/);
  });

  it('knows every event type Wire sends', () => {
    expect([...WIRE_WEBHOOK_EVENT_TYPES]).toEqual([
      'install.created',
      'install.upgraded',
      'install.disconnected',
      'install.uninstalled',
      'install.claimed',
      'install.expiring',
      'install.expired',
      'install.container_deleted',
    ]);
  });
});
