/**
 * WireSignIn: the server side of "Sign in with Wire", against a stand-in for
 * Wire's authorization server (discovery, keys, the token endpoint, userinfo)
 * behind an injected fetch.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AGENT_USER_ID_PATTERN, pkceChallenge, WireSignIn, WireSignInError } from '../app/index.js';

const BASE = 'https://app.usewire.io';
const AGENT = 'someday';
const SECRET = 'wcs_00000000000000000000000000000000fake';
const REDIRECT = 'https://someday.example/auth/callback';
const SUB = 'au_0123456789abcdefghijklmn';

type Key = { privateKey: CryptoKey; jwk: Record<string, unknown>; kid: string };
let wireKey: Key;
let otherKey: Key;

async function makeKey(kid: string): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  return { privateKey: privateKey as CryptoKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' }, kid };
}

async function idToken(over: { claims?: Record<string, unknown>; key?: Key; iss?: string; aud?: string; exp?: number; alg?: string } = {}): Promise<string> {
  const key = over.key ?? wireKey;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: SUB, ...(over.claims ?? {}) })
    .setProtectedHeader({ alg: 'EdDSA', kid: key.kid })
    .setIssuer(over.iss ?? BASE)
    .setAudience(over.aud ?? AGENT)
    .setIssuedAt(now)
    .setExpirationTime(over.exp ?? now + 3600)
    .sign(key.privateKey);
}

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}
let calls: Call[];
let tokenAnswer: () => Promise<Response> | Response;
let discovery: Record<string, unknown> | null;
let discoveryStatus: number;
let userinfoAnswer: () => Response;
let jwksStatus: number;
let jwksKeys: () => unknown[];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const fetchStub: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const headers = new Headers(init?.headers);
  calls.push({ url, method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : '' });
  const path = new URL(url).pathname;
  if (path === '/.well-known/openid-configuration') return discovery ? json(discovery, discoveryStatus) : new Response('nope', { status: discoveryStatus });
  if (path === '/api/auth/jwks') return jwksStatus === 200 ? json({ keys: jwksKeys() }) : new Response('unavailable', { status: jwksStatus });
  if (path === '/api/auth/oauth2/token') return tokenAnswer();
  if (path === '/api/auth/oauth2/userinfo') return userinfoAnswer();
  return new Response('not found', { status: 404 });
};

const client = (over: Record<string, unknown> = {}) => new WireSignIn({ agentId: AGENT, clientSecret: SECRET, redirectUri: REDIRECT, fetch: fetchStub, ...over } as never);
const tokenCalls = () => calls.filter((c) => c.url.endsWith('/api/auth/oauth2/token'));
const err = async (p: Promise<unknown>): Promise<WireSignInError> => {
  const e = await p.then(
    () => null,
    (x) => x,
  );
  expect(e).toBeInstanceOf(WireSignInError);
  return e as WireSignInError;
};

beforeAll(async () => {
  wireKey = await makeKey('wire-key-1');
  otherKey = await makeKey('someone-elses-key');
});
beforeEach(() => {
  calls = [];
  discovery = { issuer: BASE, jwks_uri: `${BASE}/api/auth/jwks` };
  discoveryStatus = 200;
  tokenAnswer = async () => json({ access_token: 'opaque-access', token_type: 'Bearer', expires_in: 3600, refresh_token: 'opaque-refresh', id_token: await idToken(), scope: 'openid offline_access' });
  userinfoAnswer = () => json({ sub: SUB });
  jwksStatus = 200;
  jwksKeys = () => [wireKey.jwk];
});

describe('the authorize request', () => {
  it('is a code flow with PKCE for the agent’s own client, and never names a resource', async () => {
    const req = await client().createAuthorizeRequest({ scope: ['email', 'offline_access'] });
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe(`${BASE}/api/auth/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: AGENT,
      redirect_uri: REDIRECT,
      scope: 'openid email offline_access',
      state: req.state,
      code_challenge: await pkceChallenge(req.codeVerifier),
      code_challenge_method: 'S256',
      nonce: req.nonce,
    });
    expect(url.searchParams.has('resource')).toBe(false);
    expect(req.url).not.toContain(SECRET);
    expect(req.url).not.toContain(req.codeVerifier);
    // nothing was sent anywhere to make it
    expect(calls).toHaveLength(0);
  });

  it('every request has its own state, verifier and nonce, and `openid` is always asked for', async () => {
    const c = client();
    const a = await c.createAuthorizeRequest();
    const b = await c.createAuthorizeRequest();
    expect(new Set([a.state, b.state, a.nonce, b.nonce, a.codeVerifier, b.codeVerifier]).size).toBe(6);
    expect(a.state.length).toBeGreaterThanOrEqual(32);
    expect(a.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(new URL(a.url).searchParams.get('scope')).toBe('openid');
    expect(new URL(c.authorizeUrl({ state: 'a-state-of-my-own', codeChallenge: await pkceChallenge('v'), scope: ['openid', 'openid'] as never })).searchParams.get('scope')).toBe('openid');
  });

  it('refuses a weak state or something that is not an S256 challenge', async () => {
    const c = client();
    expect(() => c.authorizeUrl({ state: 'x', codeChallenge: 'a'.repeat(43) })).toThrow(WireSignInError);
    expect(() => c.authorizeUrl({ state: 'a-good-enough-state', codeChallenge: 'the-verifier-itself' })).toThrow(/S256/);
  });
});

describe('the code exchange', () => {
  it('authenticates with the client secret, sends the verifier, and answers verified tokens', async () => {
    const before = Date.now();
    const tokens = await client().exchangeCode({ code: 'the-code', codeVerifier: 'the-verifier', nonce: false });
    expect(tokens).toMatchObject({ accessToken: 'opaque-access', refreshToken: 'opaque-refresh', scope: ['openid', 'offline_access'], identity: { agentUserId: SUB } });
    expect(tokens.identity.agentUserId).toMatch(AGENT_USER_ID_PATTERN);
    expect(tokens.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600_000 - 5);

    const [call] = tokenCalls();
    expect(call!.method).toBe('POST');
    expect(call!.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    // client_secret_basic
    expect(atob(call!.headers.get('authorization')!.replace(/^Basic /, ''))).toBe(`${AGENT}:${SECRET}`);
    expect(Object.fromEntries(new URLSearchParams(call!.body))).toEqual({ grant_type: 'authorization_code', code: 'the-code', code_verifier: 'the-verifier', redirect_uri: REDIRECT, client_id: AGENT });
    // the secret is in the header and nowhere else
    expect(call!.body).not.toContain(SECRET);
    expect(call!.url).not.toContain(SECRET);
    expect(new URLSearchParams(call!.body).has('resource')).toBe(false);
  });

  it('a secret with characters that need encoding is form-encoded before base64', async () => {
    await client({ clientSecret: 'p@ss:word/with+odd=chars!!' }).exchangeCode({ code: 'c', codeVerifier: 'v', nonce: false });
    expect(atob(tokenCalls()[0]!.headers.get('authorization')!.slice(6))).toBe(`${AGENT}:${encodeURIComponent('p@ss:word/with+odd=chars!!')}`);
  });

  it('identity fields come from the verified ID token, and only when it carries them', async () => {
    tokenAnswer = async () => json({ access_token: 'a', expires_in: 60, id_token: await idToken({ claims: { email: 'ada@example.test', email_verified: true, name: 'Ada', picture: 'https://img.example/a.png' } }) });
    const t = await client().exchangeCode({ code: 'c', codeVerifier: 'v', nonce: false });
    expect(t.identity).toMatchObject({ agentUserId: SUB, email: 'ada@example.test', emailVerified: true, name: 'Ada', picture: 'https://img.example/a.png' });
    expect(t.refreshToken).toBeNull();
    tokenAnswer = async () => json({ access_token: 'a', expires_in: 60, id_token: await idToken() });
    const bare = await client().exchangeCode({ code: 'c', codeVerifier: 'v', nonce: false });
    expect('email' in bare.identity).toBe(false);
    expect('name' in bare.identity).toBe(false);
  });

  it('checks the nonce when given one', async () => {
    tokenAnswer = async () => json({ access_token: 'a', expires_in: 60, id_token: await idToken({ claims: { nonce: 'the-one-i-kept' } }) });
    await expect(client().exchangeCode({ code: 'c', codeVerifier: 'v', nonce: 'the-one-i-kept' })).resolves.toBeTruthy();
    expect((await err(client().exchangeCode({ code: 'c', codeVerifier: 'v', nonce: 'another' }))).code).toBe('INVALID_ID_TOKEN');
  });

  it('the nonce is required; leaving it out is an explicit choice, and nothing is sent without one', async () => {
    for (const bad of [{ code: 'c', codeVerifier: 'v' }, { code: 'c', codeVerifier: 'v', nonce: '' }, { code: 'c', codeVerifier: 'v', nonce: undefined }]) {
      const e = await err(client().exchangeCode(bad as never));
      expect(e.code).toBe('INVALID_ARGUMENT');
      expect(e.message).toContain('nonce');
    }
    expect(tokenCalls()).toHaveLength(0);
    await expect(client().exchangeCode({ code: 'c', codeVerifier: 'v', nonce: false })).resolves.toBeTruthy();
  });

  it('Wire’s keys are fetched BEFORE the code is spent: when they cannot be, the code is never sent', async () => {
    jwksStatus = 503;
    const e = await err(client().exchangeCode({ code: 'c', codeVerifier: 'v', nonce: false }));
    expect(e).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    expect(tokenCalls()).toHaveLength(0);
    // the order on a good day: configuration, keys, then the token request
    jwksStatus = 200;
    calls = [];
    await client().exchangeCode({ code: 'c', codeVerifier: 'v', nonce: false });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/.well-known/openid-configuration', '/api/auth/jwks', '/api/auth/oauth2/token']);
  });

  it('maps Wire’s refusals: a bad grant, a bad secret, a blip, anything else', async () => {
    const cases: Array<[() => Response, string, boolean]> = [
      [() => json({ error: 'invalid_grant', error_description: 'code already used' }, 400), 'INVALID_GRANT', false],
      [() => json({ error: 'invalid_client' }, 401), 'INVALID_CLIENT', false],
      [() => json({ error: 'temporarily_unavailable', error_description: 'try again' }, 503), 'UNAVAILABLE', true],
      [() => json({ error: 'temporarily_unavailable' }, 400), 'UNAVAILABLE', true],
      [() => new Response('bad gateway', { status: 502 }), 'UNAVAILABLE', true],
      [() => json({ error: 'slow_down' }, 429), 'UNAVAILABLE', true],
      [() => json({ error: 'invalid_request', error_description: 'This client cannot request a resource' }, 400), 'OAUTH_ERROR', false],
      [() => json({ token_type: 'Bearer' }), 'UNEXPECTED_RESPONSE', false],
      [() => json({ access_token: 'a' }), 'UNEXPECTED_RESPONSE', false],
    ];
    for (const [answer, code, retryable] of cases) {
      tokenAnswer = answer;
      const e = await err(client().exchangeCode({ code: 'c', codeVerifier: 'v', nonce: false }));
      expect(e.code, code).toBe(code);
      expect(e.retryable, code).toBe(retryable);
      expect(e.message).not.toContain(SECRET);
    }
  });

  it('a request that never reaches Wire is NETWORK_ERROR, retryable', async () => {
    const c = new WireSignIn({ agentId: AGENT, clientSecret: SECRET, redirectUri: REDIRECT, fetch: (async () => { throw new TypeError('fetch failed'); }) as never });
    const e = await err(c.exchangeCode({ code: 'c', codeVerifier: 'v', nonce: false }));
    expect(e.code).toBe('NETWORK_ERROR');
    expect(e.retryable).toBe(true);
  });
});

describe('refresh', () => {
  it('sends the refresh token with the secret and answers the NEW refresh token', async () => {
    tokenAnswer = async () => json({ access_token: 'access-2', expires_in: 3600, refresh_token: 'refresh-2', id_token: await idToken(), scope: 'openid offline_access' });
    const t = await client().refresh('refresh-1');
    expect(t).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', identity: { agentUserId: SUB } });
    const [call] = tokenCalls();
    expect(Object.fromEntries(new URLSearchParams(call!.body))).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: AGENT });
    expect(call!.headers.get('authorization')).toMatch(/^Basic /);
  });

  it('a blip Wire ANSWERED is retryable with the same token; a spent or revoked one means signing in again', async () => {
    tokenAnswer = () => json({ error: 'temporarily_unavailable' }, 503);
    const blip = await err(client().refresh('r'));
    expect(blip.retryable).toBe(true);
    expect(blip.tokens).toBeUndefined();
    tokenAnswer = () => json({ error: 'invalid_grant' }, 400);
    const e = await err(client({ refreshRetryDelayMs: 0 }).refresh('r'));
    expect(e.code).toBe('INVALID_GRANT');
    expect(e.retryable).toBe(false);
  });

  // Two refreshes with one token at the same instant: Wire gives one the new tokens and can
  // answer the other `invalid_grant` for the moment before the first answer is kept. Nothing
  // is ended, and the same token a moment later gets the same new tokens.
  it('INVALID_GRANT IS TRIED ONCE MORE after a pause, with the same token: a collision with another refresh ends as a success', async () => {
    let n = 0;
    const at: number[] = [];
    tokenAnswer = async () => {
      at.push(Date.now());
      return ++n === 1
        ? json({ error: 'invalid_grant' }, 400)
        : json({ access_token: 'access-2', expires_in: 3600, refresh_token: 'refresh-2', id_token: await idToken(), scope: 'openid offline_access' });
    };
    const t = await client({ refreshRetryDelayMs: 40 }).refresh('refresh-1');
    expect(t).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    const sent = tokenCalls();
    expect(sent).toHaveLength(2);
    // the same request both times
    expect(sent[1]!.body).toBe(sent[0]!.body);
    expect(new URLSearchParams(sent[1]!.body).get('refresh_token')).toBe('refresh-1');
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(35);
  });

  it('ONCE, not in a loop: a token that is really no longer good is refused twice and that is final', async () => {
    tokenAnswer = () => json({ error: 'invalid_grant' }, 400);
    const e = await err(client({ refreshRetryDelayMs: 0 }).refresh('gone'));
    expect(e.code).toBe('INVALID_GRANT');
    expect(e.retryable).toBe(false);
    expect(tokenCalls()).toHaveLength(2);
  });

  it('nothing else is tried again: a blip, a bad secret and an answer that carried tokens are sent once', async () => {
    for (const answer of [() => json({ error: 'temporarily_unavailable' }, 503), () => json({ error: 'invalid_client' }, 401), () => json({ error: 'server_error' }, 500)]) {
      calls = [];
      tokenAnswer = answer;
      await err(client({ refreshRetryDelayMs: 0 }).refresh('r'));
      expect(tokenCalls()).toHaveLength(1);
    }
    // Wire answered with tokens, and the ID token does not verify: the error carries the tokens,
    // and the spent token is not sent again
    calls = [];
    tokenAnswer = async () => json({ access_token: 'access-2', expires_in: 3600, refresh_token: 'refresh-2', id_token: await idToken({ aud: 'another-agent' }), scope: 'openid' });
    const carried = await err(client({ refreshRetryDelayMs: 0 }).refresh('r'));
    expect(carried.tokens).toMatchObject({ refreshToken: 'refresh-2' });
    expect(tokenCalls()).toHaveLength(1);
  });

  it('the second answer is the one reported, whatever it is', async () => {
    let n = 0;
    tokenAnswer = () => (++n === 1 ? json({ error: 'invalid_grant' }, 400) : json({ error: 'temporarily_unavailable' }, 503));
    const e = await err(client({ refreshRetryDelayMs: 0 }).refresh('r'));
    expect(e.code).toBe('UNAVAILABLE');
    expect(tokenCalls()).toHaveLength(2);
  });

  it('a code exchange is never tried again: a code works once', async () => {
    tokenAnswer = () => json({ error: 'invalid_grant' }, 400);
    await err(client({ refreshRetryDelayMs: 0 }).exchangeCode({ code: 'c', codeVerifier: 'v'.repeat(43), nonce: 'n' }));
    expect(tokenCalls()).toHaveLength(1);
  });

  // Wire replaces the refresh token before this client sees the answer. From that moment the
  // one that was sent is spent, and sending it again signs the person out. So nothing after the
  // answer may lose the new one.
  it('NO ID TOKEN IN THE ANSWER (Wire may leave it out of a refresh): the new tokens, and no identity', async () => {
    tokenAnswer = () => json({ access_token: 'access-2', expires_in: 3600, refresh_token: 'refresh-2', scope: 'openid offline_access' });
    const t = await client().refresh('refresh-1');
    expect(t).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', idToken: null, identity: null });
  });

  it('WIRE’S KEYS ARE FETCHED BEFORE THE TOKEN IS SENT: when they cannot be, the refresh token is not spent', async () => {
    for (const status of [503, 404, 500]) {
      jwksStatus = status;
      const e = await err(client().refresh('refresh-1'));
      expect(e, String(status)).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
      expect(e.tokens).toBeUndefined();
    }
    expect(tokenCalls()).toHaveLength(0);
    // unreachable, not just a bad status
    const down = new WireSignIn({
      agentId: AGENT,
      clientSecret: SECRET,
      redirectUri: REDIRECT,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/api/auth/jwks')) throw new TypeError('fetch failed');
        return fetchStub(input, init);
      }) as never,
    });
    expect(await err(down.refresh('refresh-1'))).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    expect(tokenCalls()).toHaveLength(0);
    // and a failure is not remembered: the next call fetches the keys and goes through
    jwksStatus = 200;
    const c = client();
    jwksStatus = 503;
    await err(c.refresh('refresh-1'));
    jwksStatus = 200;
    expect((await c.refresh('refresh-1')).refreshToken).toBe('opaque-refresh');
  });

  it('AN ID TOKEN THAT DOES NOT VERIFY AFTER THE ANSWER: the error carries the new tokens, and says not to retry', async () => {
    tokenAnswer = async () => json({ access_token: 'access-2', expires_in: 3600, refresh_token: 'refresh-2', id_token: await idToken({ key: otherKey }), scope: 'openid' });
    const e = await err(client().refresh('refresh-1'));
    expect(e.code).toBe('INVALID_ID_TOKEN');
    expect(e.retryable).toBe(false);
    expect(e.tokens).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', identity: null, idToken: null });
    expect(e.message).toContain('store them');
    // the tokens are not something a log of the error shows
    expect(JSON.stringify(e)).not.toContain('refresh-2');
    expect(Object.keys(e)).not.toContain('tokens');
  });

  it('the keys rotate between the pre-fetch and the answer and cannot be re-fetched: UNAVAILABLE, with the tokens, not retryable', async () => {
    const c = client();
    await c.refresh('refresh-0'); // the key set is loaded and held
    const newKey = await makeKey('wire-key-2');
    tokenAnswer = async () => json({ access_token: 'access-3', expires_in: 3600, refresh_token: 'refresh-3', id_token: await idToken({ key: newKey }) });
    // Later: the library re-fetches the key set for a key id it has not seen (it will not do so
    // again within seconds of the last fetch).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    try {
      jwksStatus = 503; // the re-fetch fails
      const e = await err(c.refresh('refresh-2'));
      expect(e.code).toBe('UNAVAILABLE');
      expect(e.retryable).toBe(false); // Wire answered: the token that was sent is spent
      expect(e.tokens).toMatchObject({ accessToken: 'access-3', refreshToken: 'refresh-3' });
      // and when the re-fetch works, the new key is simply picked up
      jwksStatus = 200;
      jwksKeys = () => [wireKey.jwk, newKey.jwk];
      vi.setSystemTime(Date.now() + 10 * 60 * 1000);
      expect((await c.refresh('refresh-3')).identity?.agentUserId).toBe(SUB);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a code exchange is different: with no verified ID token nobody is signed in, and no tokens are handed over', async () => {
    tokenAnswer = async () => json({ access_token: 'a', expires_in: 60, refresh_token: 'r', id_token: await idToken({ key: otherKey }) });
    const e = await err(client().exchangeCode({ code: 'c', codeVerifier: 'v', nonce: false }));
    expect(e.code).toBe('INVALID_ID_TOKEN');
    expect(e.tokens).toBeUndefined();
    tokenAnswer = () => json({ access_token: 'a', expires_in: 60 });
    expect((await err(client().exchangeCode({ code: 'c', codeVerifier: 'v', nonce: false }))).code).toBe('UNEXPECTED_RESPONSE');
  });
});

describe('redirects are never followed', () => {
  it('every request says `manual` (Cloudflare Workers refuses `error`), and a redirect answer is an error, not a new destination', async () => {
    const seen: Array<{ url: string; redirect: unknown }> = [];
    const recording: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), redirect: init?.redirect });
      return fetchStub(input, init);
    };
    const c = client({ fetch: recording });
    await c.exchangeCode({ code: 'c', codeVerifier: 'v', nonce: false });
    await c.refresh('r');
    await c.userInfo('a');
    expect(seen.length).toBeGreaterThanOrEqual(5);
    for (const call of seen) expect(call.redirect, call.url).toBe('manual');

    for (const status of [301, 302, 307, 308]) {
      tokenAnswer = () => new Response(null, { status, headers: { location: 'https://evil.example/token' } });
      calls = [];
      const e = await err(client().refresh('r'));
      expect(e, String(status)).toMatchObject({ code: 'UNEXPECTED_RESPONSE', retryable: false });
      // nothing was sent to where the redirect pointed
      expect(calls.some((x) => x.url.includes('evil.example'))).toBe(false);
    }
    userinfoAnswer = () => new Response(null, { status: 302, headers: { location: 'https://evil.example/me' } });
    expect((await err(client().userInfo('a'))).code).toBe('UNEXPECTED_RESPONSE');
  });

  it('an opaque redirect (what a browser-like runtime hands back for `manual`) is the same error', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), json: async () => null } as unknown as Response;
    const c = new WireSignIn({ agentId: AGENT, clientSecret: SECRET, redirectUri: REDIRECT, fetch: (async () => opaque) as never });
    expect((await err(c.userInfo('a'))).code).toBe('UNEXPECTED_RESPONSE');
  });
});

describe('the ID token is verified', () => {
  const verify = (token: string, over: Record<string, unknown> = {}) => client(over).verifyIdToken(token);

  it('a token Wire signed for this agent verifies', async () => {
    expect((await verify(await idToken())).agentUserId).toBe(SUB);
  });

  it('the subject pattern is Wire’s own: lowercase letters and digits, 16 to 48 of them', async () => {
    expect(AGENT_USER_ID_PATTERN.source).toBe('^au_[0-9a-z]{16,48}$');
    for (const sub of ['au_0123456789abcdef', `au_${'a'.repeat(48)}`, 'au_00000000000000000000000a']) {
      expect((await verify(await idToken({ claims: { sub } }))).agentUserId, sub).toBe(sub);
    }
    for (const sub of ['au_ABCDEFGHIJKLMNOPQRSTUVWX', 'au_0123456789abcde', `au_${'a'.repeat(49)}`, 'ins_0123456789abcdefghijklmn', 'au_0123456789abcdef-']) {
      expect((await err(verify(await idToken({ claims: { sub } })))).code, sub).toBe('INVALID_ID_TOKEN');
    }
  });

  it('a key set that answers anything but 200 is UNAVAILABLE, never "the token is bad"', async () => {
    jwksStatus = 500;
    expect(await err(verify(await idToken()))).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    jwksStatus = 200;
    // a token signed by a key Wire does not publish IS a bad token
    expect((await err(verify(await idToken({ key: otherKey })))).code).toBe('INVALID_ID_TOKEN');
  });

  it('refuses a wrong signer, issuer, audience, an expired token, and a subject that is not a per-agent id', async () => {
    const bad: Array<[string, string]> = [
      ['signed by someone else', await idToken({ key: otherKey })],
      ['another issuer', await idToken({ iss: 'https://evil.example' })],
      ['for another agent', await idToken({ aud: 'another-agent' })],
      ['expired', await idToken({ exp: Math.floor(Date.now() / 1000) - 3600 })],
      ['a Wire user id as the subject', await idToken({ claims: { sub: 'usr_1234567890' } })],
      ['an id of the wrong length', await idToken({ claims: { sub: 'au_short' } })],
      ['not a token', 'opaque-string'],
    ];
    for (const [what, token] of bad) {
      const e = await err(verify(token));
      expect(e.code, what).toBe('INVALID_ID_TOKEN');
      expect(e.retryable, what).toBe(false);
    }
  });

  it('refuses a token for more than one audience, and keeps a refused token’s claims out of the error', async () => {
    const now = Math.floor(Date.now() / 1000);
    const two = await new SignJWT({ sub: SUB })
      .setProtectedHeader({ alg: 'EdDSA', kid: wireKey.kid })
      .setIssuer(BASE)
      .setAudience([AGENT, 'another-agent'])
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(wireKey.privateKey);
    expect((await err(verify(two))).code).toBe('INVALID_ID_TOKEN');
    // one audience, as an array of one, is the same token
    const one = await new SignJWT({ sub: SUB }).setProtectedHeader({ alg: 'EdDSA', kid: wireKey.kid }).setIssuer(BASE).setAudience([AGENT]).setIssuedAt(now).setExpirationTime(now + 600).sign(wireKey.privateKey);
    expect((await verify(one)).agentUserId).toBe(SUB);

    const expired = await idToken({ exp: now - 3600, claims: { email: 'ada@example.test', name: 'Ada Lovelace' } });
    const e = await err(verify(expired));
    const seen = JSON.stringify({ message: e.message, details: e.details, cause: (e as { cause?: unknown }).cause ?? null });
    expect(seen).not.toContain('ada@example.test');
    expect(seen).not.toContain('Ada Lovelace');
  });

  it('refuses an unsigned token and one that claims a symmetric algorithm', async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = b64({ sub: SUB, iss: BASE, aud: AGENT, iat: now, exp: now + 600 });
    for (const header of [{ alg: 'none' }, { alg: 'HS256', kid: wireKey.kid }]) {
      expect((await err(verify(`${b64(header)}.${payload}.`))).code).toBe('INVALID_ID_TOKEN');
      expect((await err(verify(`${b64(header)}.${payload}.c2ln`))).code).toBe('INVALID_ID_TOKEN');
    }
  });

  it('a token answer whose ID token does not verify signs nobody in', async () => {
    tokenAnswer = async () => json({ access_token: 'a', expires_in: 60, id_token: await idToken({ key: otherKey }) });
    expect((await err(client().exchangeCode({ code: 'c', codeVerifier: 'v', nonce: false }))).code).toBe('INVALID_ID_TOKEN');
  });

  it('trusts only Wire’s own origin for the issuer and the keys', async () => {
    for (const doc of [
      { issuer: 'https://evil.example', jwks_uri: `${BASE}/api/auth/jwks` },
      { issuer: BASE, jwks_uri: 'https://evil.example/jwks' },
      { issuer: BASE },
      { issuer: 'not a url', jwks_uri: 'nor this' },
    ]) {
      discovery = doc;
      expect((await err(verify(await idToken()))).code).toBe('UNEXPECTED_RESPONSE');
    }
    // a failed read is not remembered: the next call asks again and succeeds
    discovery = null;
    discoveryStatus = 503;
    const c = client();
    const e = await err(c.verifyIdToken(await idToken()));
    expect(e.code).toBe('UNAVAILABLE');
    expect(e.retryable).toBe(true);
    discovery = { issuer: BASE, jwks_uri: `${BASE}/api/auth/jwks` };
    discoveryStatus = 200;
    expect((await c.verifyIdToken(await idToken())).agentUserId).toBe(SUB);
  });

  it('an issuer with a path under Wire’s origin is followed as given', async () => {
    discovery = { issuer: `${BASE}/api/auth`, jwks_uri: `${BASE}/api/auth/jwks` };
    expect((await verify(await idToken({ iss: `${BASE}/api/auth` }))).agentUserId).toBe(SUB);
    expect((await err(client().verifyIdToken(await idToken({ iss: BASE })))).code).toBe('INVALID_ID_TOKEN');
  });

  it('preview: another base URL is another issuer and another key set', async () => {
    const PREVIEW = 'https://preview.app.usewire.io';
    discovery = { issuer: PREVIEW, jwks_uri: `${PREVIEW}/api/auth/jwks` };
    const c = client({ baseUrl: PREVIEW });
    expect((await c.verifyIdToken(await idToken({ iss: PREVIEW }))).agentUserId).toBe(SUB);
    expect(new URL((await c.createAuthorizeRequest()).url).origin).toBe(PREVIEW);
    // production's token is not preview's
    expect((await err(c.verifyIdToken(await idToken()))).code).toBe('INVALID_ID_TOKEN');
  });
});

describe('userinfo', () => {
  it('answers the per-agent id, null for a token that is no longer good, and nothing else', async () => {
    expect(await client().userInfo('opaque-access')).toEqual({ agentUserId: SUB });
    expect(calls.at(-1)!.headers.get('authorization')).toBe('Bearer opaque-access');
    userinfoAnswer = () => json({ error: 'invalid_token' }, 401);
    expect(await client().userInfo('stale')).toBeNull();
    userinfoAnswer = () => json({ sub: 'usr_a_real_wire_user_id' });
    expect((await err(client().userInfo('x'))).code).toBe('UNEXPECTED_RESPONSE');
    userinfoAnswer = () => new Response('', { status: 503 });
    expect((await err(client().userInfo('x'))).retryable).toBe(true);
  });
});

describe('it is a server-side client', () => {
  it('needs an agent id, a secret, an absolute redirect address and an https origin', () => {
    const base = { agentId: AGENT, clientSecret: SECRET, redirectUri: REDIRECT };
    for (const bad of [
      { ...base, agentId: 'Not An Id' },
      { ...base, clientSecret: '' },
      { ...base, clientSecret: 'short' },
      { ...base, redirectUri: '/relative' },
      { ...base, redirectUri: `${REDIRECT}#fragment` },
      { ...base, baseUrl: 'http://app.usewire.io' },
      { ...base, baseUrl: 'nonsense' },
    ]) {
      expect(() => new WireSignIn(bad as never), JSON.stringify(bad)).toThrow(WireSignInError);
    }
    expect(() => new WireSignIn({ ...base, baseUrl: 'http://localhost:3000' })).not.toThrow();
  });

  it('refuses to be constructed in a browser page: the secret would be given away', () => {
    const g = globalThis as Record<string, unknown>;
    g.window = {};
    g.document = {};
    try {
      expect(() => client()).toThrow(/runs on a server/);
    } finally {
      delete g.window;
      delete g.document;
    }
  });

  it('never puts the secret in an error, a URL or an object you might log', async () => {
    const c = client();
    expect(JSON.stringify(c)).not.toContain(SECRET);
    expect(Object.keys(c)).not.toContain('clientSecret');
    tokenAnswer = () => json({ error: 'invalid_client', error_description: 'bad credentials' }, 401);
    const e = await err(c.exchangeCode({ code: 'c', codeVerifier: 'v', nonce: false }));
    expect(JSON.stringify({ message: e.message, details: e.details, code: e.code })).not.toContain(SECRET);
  });
});
