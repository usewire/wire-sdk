/**
 * THE BUILT SDK INSIDE CLOUDFLARE'S RUNTIME (workerd, through Miniflare).
 *
 * `WireSignIn` and `WireAgentEndpoint` are for an agent's server, and many of
 * those are Workers. workerd's fetch is not Node's: it refuses
 * `redirect: 'error'` outright (`TypeError: Invalid redirect value`), which
 * made every call of an earlier build fail there while passing every test
 * here. So this file runs the package as it ships (`dist/`, bundled the way a
 * Worker is) in workerd, against a stand-in for Wire on the Worker's outbound
 * side, for one sign-in, one refresh, one endpoint call each way, and a
 * redirect.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Miniflare, Response as MfResponse } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = 'https://app.usewire.io';
const AGENT = 'someday';
const ENDPOINT = `https://${AGENT}.agent.usewire.io`;
const SUB = 'au_0123456789abcdefghijklmn';
const SECRET = 'wcs_00000000000000000000000000000000fake';

// The Worker: an agent's server, as small as it can be. It answers what the SDK did.
const WORKER = `
import { WireSignIn, WireAgentEndpoint } from ${JSON.stringify(join(root, 'dist/app/index.js'))};
const wire = () => new WireSignIn({ agentId: ${JSON.stringify(AGENT)}, clientSecret: ${JSON.stringify(SECRET)}, redirectUri: 'https://someday.example/auth/callback' });
const endpoint = () => new WireAgentEndpoint({ agentId: ${JSON.stringify(AGENT)} });
const told = (e) => ({ ok: false, name: e && e.name, code: e && e.code, retryable: e && e.retryable, message: String(e && e.message), hasTokens: !!(e && e.tokens) });
export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/authorize') { const r = await wire().createAuthorizeRequest({ scope: ['email'] }); return Response.json({ ok: true, url: r.url, state: r.state.length, verifier: r.codeVerifier.length }); }
      if (path === '/exchange') { const t = await wire().exchangeCode({ code: 'the-code', codeVerifier: 'the-verifier', nonce: false }); return Response.json({ ok: true, sub: t.identity.agentUserId, access: t.accessToken, refresh: t.refreshToken }); }
      if (path === '/refresh') { const t = await wire().refresh('refresh-1'); return Response.json({ ok: true, sub: t.identity && t.identity.agentUserId, access: t.accessToken, refresh: t.refreshToken }); }
      if (path === '/tools') return Response.json({ ok: true, tools: await endpoint().listTools('opaque-access') });
      if (path === '/call') return Response.json({ ok: true, result: await endpoint().callTool('opaque-access', 'find_places', { q: 'ramen' }) });
      return new Response('not found', { status: 404 });
    } catch (e) {
      return Response.json(told(e));
    }
  },
};
`;

let mf: Miniflare;
let mode: 'ok' | 'redirect' = 'ok';
const outbound: Array<{ url: string; method: string; authorization: string | null }> = [];
let idToken: () => Promise<string>;
let jwks: unknown;

beforeAll(async () => {
  if (!existsSync(join(root, 'dist/app/index.js'))) execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });

  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'wire-key-1', alg: 'EdDSA', use: 'sig' }] };
  idToken = async () => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub: SUB }).setProtectedHeader({ alg: 'EdDSA', kid: 'wire-key-1' }).setIssuer(BASE).setAudience(AGENT).setIssuedAt(now).setExpirationTime(now + 600).sign(privateKey as CryptoKey);
  };

  const bundled = await build({ stdin: { contents: WORKER, loader: 'js', resolveDir: root }, bundle: true, format: 'esm', platform: 'browser', conditions: ['worker', 'browser'], write: false, logLevel: 'silent' });

  mf = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0]!.text,
    compatibilityDate: '2026-01-01',
    // Everything the Worker fetches arrives here: this is "Wire".
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      outbound.push({ url: request.url, method: request.method, authorization: request.headers.get('authorization') });
      const json = (body: unknown, status = 200) => new MfResponse(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (mode === 'redirect' && (url.pathname === '/api/auth/oauth2/token' || url.pathname === '/tools')) {
        return new MfResponse(null, { status: 302, headers: { location: 'https://evil.example/elsewhere' } });
      }
      if (url.origin === BASE) {
        if (url.pathname === '/.well-known/openid-configuration') return json({ issuer: BASE, jwks_uri: `${BASE}/api/auth/jwks` });
        if (url.pathname === '/api/auth/jwks') return json(jwks);
        if (url.pathname === '/api/auth/oauth2/token') return json({ access_token: 'opaque-access', token_type: 'Bearer', expires_in: 3600, refresh_token: 'opaque-refresh', id_token: await idToken(), scope: 'openid' });
      }
      if (url.origin === ENDPOINT) {
        if (url.pathname === '/tools') return json({ tools: [{ name: 'find_places', description: 'Find saved places.', inputSchema: { type: 'object' } }] });
        if (url.pathname === '/tools/find_places') return json({ ok: true, data: { places: [{ name: 'Ramen Ya' }] } });
      }
      return json({ error: 'not_found' }, 404);
    },
  } as never);
}, 180_000);

afterAll(async () => {
  await mf?.dispose();
});

const ask = async (path: string): Promise<Record<string, unknown>> => {
  outbound.length = 0;
  const res = await mf.dispatchFetch(`https://agent.example${path}`);
  return (await res.json()) as Record<string, unknown>;
};

describe('the built SDK in workerd', () => {
  it('builds an authorize request (Web Crypto for PKCE, no network)', async () => {
    const r = await ask('/authorize');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const url = new URL(r.url as string);
    expect(url.origin + url.pathname).toBe(`${BASE}/api/auth/oauth2/authorize`);
    expect(url.searchParams.has('resource')).toBe(false);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(outbound).toHaveLength(0);
  });

  it('exchanges a code: the secret in the Basic header, the ID token verified with Wire’s keys (EdDSA), the per-agent id out', async () => {
    const r = await ask('/exchange');
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, sub: SUB, access: 'opaque-access', refresh: 'opaque-refresh' });
    const token = outbound.find((o) => o.url.endsWith('/api/auth/oauth2/token'))!;
    expect(token.method).toBe('POST');
    expect(atob(token.authorization!.replace(/^Basic /, ''))).toBe(`${AGENT}:${SECRET}`);
    // workerd accepted every request this client made
    expect(outbound.map((o) => new URL(o.url).pathname)).toEqual(['/.well-known/openid-configuration', '/api/auth/jwks', '/api/auth/oauth2/token']);
  });

  it('refreshes', async () => {
    expect(await ask('/refresh')).toMatchObject({ ok: true, sub: SUB, refresh: 'opaque-refresh' });
  });

  it('lists and calls the agent’s tools over REST with the access token', async () => {
    const list = await ask('/tools');
    expect(list, JSON.stringify(list)).toMatchObject({ ok: true, tools: [{ name: 'find_places' }] });
    expect(outbound).toEqual([{ url: `${ENDPOINT}/tools`, method: 'GET', authorization: 'Bearer opaque-access' }]);
    const call = await ask('/call');
    expect(call, JSON.stringify(call)).toMatchObject({ ok: true, result: { data: { places: [{ name: 'Ramen Ya' }] } } });
    expect(outbound[0]).toMatchObject({ url: `${ENDPOINT}/tools/find_places`, method: 'POST', authorization: 'Bearer opaque-access' });
  });

  it('a redirect is an error in workerd too, and nothing is sent to where it points', async () => {
    mode = 'redirect';
    try {
      const refresh = await ask('/refresh');
      expect(refresh, JSON.stringify(refresh)).toMatchObject({ ok: false, name: 'WireSignInError', code: 'UNEXPECTED_RESPONSE', retryable: false });
      expect(outbound.some((o) => o.url.includes('evil.example'))).toBe(false);
      const tools = await ask('/tools');
      expect(tools, JSON.stringify(tools)).toMatchObject({ ok: false, name: 'WireEndpointError', code: 'UNEXPECTED_RESPONSE' });
      expect(outbound.some((o) => o.url.includes('evil.example'))).toBe(false);
    } finally {
      mode = 'ok';
    }
  });
});
