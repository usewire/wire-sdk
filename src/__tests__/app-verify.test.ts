import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { base64url, SignJWT } from 'jose';
import {
  MemoryReplayStore,
  verifyWireAction,
  WireActionAuthError,
  type VerifyWireActionOptions,
} from '../app/index.js';
import {
  actionRequest,
  makeKey,
  NOW,
  NOW_SEC,
  signAction,
  startJwksServer,
  uniqueUrl,
  type JwksServer,
  type TestKey,
} from './helpers/wire-signer.js';

const BODY = JSON.stringify({ address: '1 Main St, Springfield' });

let server: JwksServer;
let key: TestKey;

beforeAll(async () => {
  key = await makeKey('wire-2026-09');
  server = await startJwksServer([key.publicJwk]);
});
afterAll(() => server.close());
afterEach(() => {
  server.keys = [key.publicJwk];
  server.status = 200;
  vi.useRealTimers();
});

function opts(extra: Partial<VerifyWireActionOptions> = {}): VerifyWireActionOptions {
  return {
    appId: 'geo-app',
    action: 'geocode',
    jwksUrl: uniqueUrl(server),
    now: NOW,
    replayStore: new MemoryReplayStore(),
    ...extra,
  };
}

async function expectCode(p: Promise<unknown>, code: string, status = 401) {
  const err = await p.then(
    () => {
      throw new Error('expected verification to fail');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(WireActionAuthError);
  expect((err as WireActionAuthError).code).toBe(code);
  expect((err as WireActionAuthError).status).toBe(status);
}

describe('verifyWireAction', () => {
  it('accepts a valid call and returns who is calling', async () => {
    const token = await signAction({ key, body: BODY });
    const req = actionRequest(token, BODY);
    const result = await verifyWireAction(req, opts());
    expect(result).toMatchObject({
      connectionId: 'conn_123',
      containerId: 'ctr_456',
      action: 'geocode',
      requestId: 'req_789',
    });
    expect(result.claims.iss).toBe('wire');
    // The body is read from a clone; the caller can still read it.
    expect(await req.text()).toBe(BODY);
  });

  it('refuses a missing Authorization header', async () => {
    await expectCode(verifyWireAction(actionRequest(null, BODY), opts()), 'MISSING_TOKEN');
  });

  it('refuses a non-Bearer or malformed header', async () => {
    const req = new Request('https://x.example', { method: 'POST', headers: { authorization: 'Basic abc' }, body: BODY });
    await expectCode(verifyWireAction(req, opts()), 'MALFORMED_TOKEN');
    await expectCode(verifyWireAction(actionRequest('not.a-jwt', BODY), opts()), 'MALFORMED_TOKEN');
  });

  it('refuses the wrong audience', async () => {
    const token = await signAction({ key, body: BODY, aud: 'other-app' });
    await expectCode(verifyWireAction(actionRequest(token, BODY), opts()), 'INVALID_AUDIENCE');
  });

  it('refuses a multi-audience token even if it lists this app', async () => {
    const token = await signAction({ key, body: BODY, aud: ['geo-app', 'other-app'] });
    await expectCode(verifyWireAction(actionRequest(token, BODY), opts()), 'INVALID_AUDIENCE');
  });

  it('refuses an issuer other than wire', async () => {
    const token = await signAction({ key, body: BODY, iss: 'not-wire' });
    await expectCode(verifyWireAction(actionRequest(token, BODY), opts()), 'INVALID_ISSUER');
  });

  it('refuses an expired token', async () => {
    const token = await signAction({ key, body: BODY, iat: NOW_SEC - 120, exp: NOW_SEC - 60 });
    await expectCode(verifyWireAction(actionRequest(token, BODY), opts()), 'TOKEN_EXPIRED');
  });

  it('tolerates clock skew up to the tolerance (30 s by default) but not more', async () => {
    const skewed = await signAction({ key, body: BODY, iat: NOW_SEC - 85, exp: NOW_SEC - 25 });
    await expect(verifyWireAction(actionRequest(skewed, BODY), opts())).resolves.toBeTruthy();
    const late = await signAction({ key, body: BODY, iat: NOW_SEC - 100, exp: NOW_SEC - 40 });
    await expectCode(verifyWireAction(actionRequest(late, BODY), opts()), 'TOKEN_EXPIRED');
    const strict = await signAction({ key, body: BODY, iat: NOW_SEC - 65, exp: NOW_SEC - 5 });
    await expectCode(verifyWireAction(actionRequest(strict, BODY), opts({ clockToleranceSec: 2 })), 'TOKEN_EXPIRED');
  });

  it('refuses a token issued in the future', async () => {
    const token = await signAction({ key, body: BODY, iat: NOW_SEC + 45, exp: NOW_SEC + 105 });
    await expectCode(verifyWireAction(actionRequest(token, BODY), opts()), 'INVALID_CLAIMS');
  });

  it('refuses a lifetime longer than 60 seconds', async () => {
    const token = await signAction({ key, body: BODY, iat: NOW_SEC, exp: NOW_SEC + 3600 });
    await expectCode(verifyWireAction(actionRequest(token, BODY), opts()), 'INVALID_CLAIMS');
  });

  it.each(['sub', 'jti', 'wire_container', 'wire_action', 'wire_body_sha256', 'iat', 'exp'])(
    'refuses a token without %s',
    async (claim) => {
      const token = await signAction({ key, body: BODY, omit: [claim] });
      const err = await verifyWireAction(actionRequest(token, BODY), opts()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WireActionAuthError);
      expect(['INVALID_CLAIMS', 'TOKEN_EXPIRED']).toContain((err as WireActionAuthError).code);
    }
  );

  it('refuses a tampered body', async () => {
    const token = await signAction({ key, body: BODY });
    const tampered = JSON.stringify({ address: '2 Other St' });
    await expectCode(verifyWireAction(actionRequest(token, tampered), opts()), 'BODY_MISMATCH');
  });

  it('hashes raw bytes: a semantically equal but re-serialized body does not verify', async () => {
    const token = await signAction({ key, body: BODY });
    const reformatted = JSON.stringify(JSON.parse(BODY), null, 2);
    await expectCode(verifyWireAction(actionRequest(token, reformatted), opts()), 'BODY_MISMATCH');
  });

  it('refuses a replayed jti', async () => {
    const replayStore = new MemoryReplayStore();
    const token = await signAction({ key, body: BODY, jti: 'jti-replay-0001' });
    const o = opts({ replayStore });
    await verifyWireAction(actionRequest(token, BODY), o);
    await expectCode(verifyWireAction(actionRequest(token, BODY), o), 'REPLAYED');
  });

  it('does not spend a jti on a call that fails another check', async () => {
    const replayStore = new MemoryReplayStore();
    const o = opts({ replayStore });
    const token = await signAction({ key, body: BODY, jti: 'jti-unspent-01' });
    await expectCode(verifyWireAction(actionRequest(token, 'tampered'), o), 'BODY_MISMATCH');
    expect(replayStore.size).toBe(0);
    await expect(verifyWireAction(actionRequest(token, BODY), o)).resolves.toBeTruthy();
  });

  it('fails closed (503) when the replay store throws', async () => {
    const token = await signAction({ key, body: BODY });
    const broken = { markUsed: () => Promise.reject(new Error('redis down')) };
    await expectCode(
      verifyWireAction(actionRequest(token, BODY), opts({ replayStore: broken })),
      'REPLAY_STORE_UNAVAILABLE',
      503
    );
  });

  it('refuses a token minted for another action when one is expected', async () => {
    const token = await signAction({ key, body: BODY, action: 'reverse_geocode' });
    await expectCode(verifyWireAction(actionRequest(token, BODY), opts({ action: 'geocode' })), 'ACTION_MISMATCH');
  });

  it('refuses a token without the wire-action+jwt typ', async () => {
    const untyped = await signAction({ key, body: BODY, typ: null });
    await expectCode(verifyWireAction(actionRequest(untyped, BODY), opts()), 'MALFORMED_TOKEN');
    const other = await signAction({ key, body: BODY, typ: 'JWT' });
    await expectCode(verifyWireAction(actionRequest(other, BODY), opts()), 'MALFORMED_TOKEN');
  });

  it('accepts a one-element audience array, as the engine does', async () => {
    const token = await signAction({ key, body: BODY, aud: ['geo-app'] });
    await expect(verifyWireAction(actionRequest(token, BODY), opts())).resolves.toBeTruthy();
  });

  it('refuses a token without a kid', async () => {
    const token = await signAction({ key, body: BODY, kid: null });
    await expectCode(verifyWireAction(actionRequest(token, BODY), opts()), 'UNKNOWN_KEY');
  });

  it('refuses a kid Wire does not publish', async () => {
    const stranger = await makeKey('not-in-jwks');
    const token = await signAction({ key: stranger, body: BODY });
    await expectCode(verifyWireAction(actionRequest(token, BODY), opts()), 'UNKNOWN_KEY');
  });

  it('refuses a signature by a different key under a published kid', async () => {
    const impostor = await makeKey(key.kid);
    const token = await signAction({ key: impostor, body: BODY });
    await expectCode(verifyWireAction(actionRequest(token, BODY), opts()), 'BAD_SIGNATURE');
  });

  it('refetches the JWKS on an unknown kid (after the cooldown) and accepts a rotated key', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const o = opts();

    // Warm the cache with the current key.
    await verifyWireAction(actionRequest(await signAction({ key, body: BODY }), BODY), o);
    const fetchesBefore = server.fetches;

    // Wire rotates: the new key is published and used.
    const next = await makeKey('wire-2026-10');
    server.keys = [key.publicJwk, next.publicJwk];

    // Within the 30s cooldown the SDK does not refetch, so an unknown kid
    // cannot be used to make it fetch on every request.
    const t1 = await signAction({ key: next, body: BODY });
    await expectCode(verifyWireAction(actionRequest(t1, BODY), o), 'UNKNOWN_KEY');
    expect(server.fetches).toBe(fetchesBefore);

    // After the cooldown, an unknown kid triggers one refetch and verifies.
    vi.setSystemTime(new Date(NOW.getTime() + 31_000));
    const t2 = await signAction({ key: next, body: BODY });
    const result = await verifyWireAction(actionRequest(t2, BODY), o);
    expect(result.connectionId).toBe('conn_123');
    expect(server.fetches).toBe(fetchesBefore + 1);
  });

  it('answers 503 when the JWKS cannot be fetched', async () => {
    server.status = 500;
    const token = await signAction({ key, body: BODY });
    await expectCode(verifyWireAction(actionRequest(token, BODY), opts()), 'JWKS_UNAVAILABLE', 503);
  });

  it('rides out a JWKS outage on the last good set, and backs off instead of refetching per call', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const o = opts();
    await verifyWireAction(actionRequest(await signAction({ key, body: BODY }), BODY), o);

    // The cache expires and Wire's JWKS starts failing.
    server.status = 500;
    vi.setSystemTime(new Date(NOW.getTime() + 6 * 60_000));
    const t1 = await signAction({ key, body: BODY });
    await expect(verifyWireAction(actionRequest(t1, BODY), o)).resolves.toBeTruthy();
    const fetchesAfterFailure = server.fetches;

    // Within the backoff, no further fetch, and still verifying.
    const t2 = await signAction({ key, body: BODY });
    await expect(verifyWireAction(actionRequest(t2, BODY), o)).resolves.toBeTruthy();
    expect(server.fetches).toBe(fetchesAfterFailure);

    // An hour on, the stale set is no longer trusted.
    vi.setSystemTime(new Date(NOW.getTime() + 70 * 60_000));
    const t3 = await signAction({ key, body: BODY });
    await expectCode(verifyWireAction(actionRequest(t3, BODY), o), 'JWKS_UNAVAILABLE', 503);
  });

  describe('algorithm confusion', () => {
    it('refuses alg none', async () => {
      const header = base64url.encode(JSON.stringify({ alg: 'none', typ: 'wire-action+jwt', kid: key.kid }));
      const payload = base64url.encode(JSON.stringify({ iss: 'wire', aud: 'geo-app' }));
      await expectCode(
        verifyWireAction(actionRequest(`${header}.${payload}.sig`, BODY), opts()),
        'UNSUPPORTED_ALGORITHM'
      );
    });

    it('refuses HS256 signed with the public key as the HMAC secret', async () => {
      const secret = new TextEncoder().encode(key.publicJwk.x as string);
      const token = await new SignJWT({ wire_body_sha256: 'x' })
        .setProtectedHeader({ alg: 'HS256', typ: 'wire-action+jwt', kid: key.kid })
        .setIssuer('wire')
        .setAudience('geo-app')
        .sign(secret);
      await expectCode(verifyWireAction(actionRequest(token, BODY), opts()), 'UNSUPPORTED_ALGORITHM');
    });
  });

  it('refuses a body over the limit', async () => {
    const big = JSON.stringify({ address: 'x'.repeat(2048) });
    const token = await signAction({ key, body: big });
    await expectCode(verifyWireAction(actionRequest(token, big), opts({ maxBodyBytes: 1024 })), 'BODY_TOO_LARGE', 413);
  });

  it('records a jti for a constant, clock-independent TTL', async () => {
    const seen: number[] = [];
    const replayStore = { markUsed: (_k: string, ttl: number) => (seen.push(ttl), true) };
    await verifyWireAction(actionRequest(await signAction({ key, body: BODY }), BODY), opts({ replayStore }));
    expect(seen).toEqual([60 + 2 * 60 + 1]);
  });

  it('refuses a non-https JWKS URL except on loopback', async () => {
    const token = await signAction({ key, body: BODY });
    await expect(
      verifyWireAction(actionRequest(token, BODY), opts({ jwksUrl: 'http://wire.example/jwks.json' }))
    ).rejects.toThrow(TypeError);
  });

  it('requires appId', async () => {
    await expect(verifyWireAction(actionRequest('a.b.c', BODY), { appId: '', action: 'geocode' })).rejects.toThrow(/appId/);
  });

  it('requires action, since the request path is not signed', async () => {
    const token = await signAction({ key, body: BODY });
    const { action: _omit, ...withoutAction } = opts();
    await expect(
      verifyWireAction(actionRequest(token, BODY), withoutAction as VerifyWireActionOptions)
    ).rejects.toThrow(/action is required/);
    await expect(verifyWireAction(actionRequest(token, BODY), opts({ action: '' }))).rejects.toThrow(TypeError);
  });
});

describe('MemoryReplayStore', () => {
  it('forgets a key once its TTL passes', () => {
    let now = 1_000_000;
    const store = new MemoryReplayStore({ now: () => now });
    expect(store.markUsed('k', 60)).toBe(true);
    expect(store.markUsed('k', 60)).toBe(false);
    now += 61_000;
    expect(store.markUsed('k', 60)).toBe(true);
  });

  it('fails closed when full of live entries, and prunes expired ones', () => {
    let now = 0;
    const store = new MemoryReplayStore({ maxEntries: 2, now: () => now });
    store.markUsed('a', 10);
    store.markUsed('b', 10);
    expect(() => store.markUsed('c', 10)).toThrow(/full/);
    now += 11_000;
    expect(store.markUsed('c', 10)).toBe(true);
    expect(store.size).toBe(1);
  });
});
