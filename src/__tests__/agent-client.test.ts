/**
 * WireAgentClient (SUP-958). Every request is checked by `wireAgentApi` below,
 * which restates the platform's agent API door check for check: the runtime
 * key looked up by kid, `jwtVerify` with `aud` one of `wire-agent-api` /
 * `wire-app-api` (the platform accepts both during the rename), `iss` the
 * key's agent, a jti of 8+ characters used once, a lifetime of 1..60 s, `iat`
 * not in the future, and on DELETE `body_sha256` of the exact body. The door
 * answers both `/api/v1/agents/...` and the deprecated `/api/v1/apps/...`.
 * So a token this client mints is one the platform accepts, and the other way
 * round.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt, decodeProtectedHeader, errors as joseErrors, importJWK, jwtVerify } from 'jose';
import { WireSdkError } from '../types.js';
import {
  AGENT_API_AUDIENCE,
  APP_API_AUDIENCE,
  generateRuntimeKey,
  WireAgentApiError,
  WireAgentClient,
  WireAppApiError,
  WireAppClient,
  type WireAgentClientOptions,
} from '../app/index.js';
import * as agentEntry from '../agent/index.js';
import { installJson } from './helpers/wire-signer.js';

const EMPTY_BODY_SHA256 = '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';
const INSTALL = 'ins_aaaaaaaaaaaaaaaaaaaaaaaa';
const AGENT_USER = 'au_bbbbbbbbbbbbbbbbbbbbbbbb';

interface RegisteredKey {
  agentId: string;
  publicKey: string;
  purpose: 'publish' | 'runtime';
  revoked?: boolean;
}

async function sha(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let s = '';
  for (const b of d) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type Answer = { status: number; body: unknown };

/** The platform's agent API door: auth exactly as the platform's, then `route` answers. */
function wireAgentApi(keys: Map<string, RegisteredKey>, route: (method: string, path: string) => Answer) {
  const seen = new Set<string>();
  const requests: Request[] = [];
  const fail = (status: number, code: string, message: string): Response =>
    new Response(JSON.stringify({ success: false, error: { code, message } }), { status });

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    requests.push(req.clone());
    const auth = req.headers.get('authorization');
    if (!auth?.startsWith('Bearer ')) return fail(401, 'UNAUTHORIZED', 'Bearer token required');
    const token = auth.slice(7).trim();
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      return fail(401, 'INVALID_TOKEN', 'Malformed JWT header');
    }
    if (header.alg !== 'EdDSA') return fail(401, 'INVALID_TOKEN', 'JWT alg must be EdDSA');
    if (typeof header.kid !== 'string' || !header.kid) return fail(401, 'RUNTIME_KEY_REQUIRED', 'Sign with a runtime key');
    const key = keys.get(header.kid);
    if (!key) return fail(401, 'INVALID_TOKEN', 'Unknown key');
    if (key.revoked) return fail(401, 'CREDENTIAL_REVOKED', 'Key has been revoked');
    if (key.purpose !== 'runtime') return fail(401, 'INVALID_TOKEN', 'This is a publish key; the app API takes a runtime key');

    let payload: Record<string, unknown>;
    try {
      const jwk = await importJWK({ kty: 'OKP', crv: 'Ed25519', x: key.publicKey }, 'EdDSA');
      payload = (await jwtVerify(token, jwk, { audience: ['wire-agent-api', 'wire-app-api'], algorithms: ['EdDSA'] })).payload as Record<string, unknown>;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) return fail(401, 'TOKEN_EXPIRED', 'JWT expired');
      if (err instanceof joseErrors.JWTClaimValidationFailed) return fail(401, 'INVALID_TOKEN', `JWT claim invalid: ${err.claim}`);
      return fail(401, 'INVALID_TOKEN', 'JWT signature verification failed');
    }
    if (payload.iss !== key.agentId) return fail(401, 'INVALID_TOKEN', 'iss must be the agent the key belongs to');
    if (typeof payload.jti !== 'string' || payload.jti.length < 8) return fail(401, 'INVALID_TOKEN', 'Missing or short jti');
    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') return fail(401, 'INVALID_TOKEN', 'Missing iat or exp');
    if (payload.exp <= payload.iat || payload.exp - payload.iat > 60) return fail(401, 'INVALID_TOKEN', 'JWT lifetime must be 1..60s');
    if (payload.iat > Math.floor(Date.now() / 1000) + 30) return fail(401, 'INVALID_TOKEN', 'JWT issued in the future');
    if (req.method === 'DELETE') {
      const raw = new Uint8Array(await req.arrayBuffer());
      if (payload.body_sha256 !== (await sha(raw))) return fail(401, 'INVALID_TOKEN', 'body_sha256 mismatch');
    }
    const replayKey = `sdk:jti:${payload.iss}:${payload.jti}`;
    if (seen.has(replayKey)) return fail(401, 'REPLAY_DETECTED', 'jti already used');
    seen.add(replayKey);

    const url = new URL(req.url);
    const m = /^\/api\/v1\/(agents|apps)\/([^/]+)(\/.*)$/.exec(url.pathname);
    // A path naming another agent is 404.
    if (!m || m[2].replace(/_/g, '-') !== key.agentId) return fail(404, 'NOT_FOUND', 'Install not found');
    const a = route(req.method, m[3]);
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status });
  });
  return { fetch: fetchImpl as unknown as typeof fetch, requests, mock: fetchImpl };
}

const ok = (data: unknown): Answer => ({ status: 200, body: { success: true, data } });
const err = (status: number, code: string, message = 'x'): Answer => ({ status, body: { success: false, error: { code, message } } });

let runtime: Awaited<ReturnType<typeof generateRuntimeKey>>;
let publish: Awaited<ReturnType<typeof generateRuntimeKey>>;
let keys: Map<string, RegisteredKey>;

beforeEach(async () => {
  runtime = await generateRuntimeKey();
  publish = await generateRuntimeKey();
  keys = new Map([
    ['pk_runtime', { agentId: 'someday', publicKey: runtime.publicKey, purpose: 'runtime' }],
    ['pk_publish', { agentId: 'someday', publicKey: publish.publicKey, purpose: 'publish' }],
  ]);
});

function client(api: ReturnType<typeof wireAgentApi>, extra: Partial<WireAgentClientOptions> = {}) {
  return new WireAgentClient({
    agentId: 'someday',
    runtimeKey: { privateJwk: runtime.privateJwk, keyId: 'pk_runtime' },
    baseUrl: 'https://preview.app.usewire.io',
    fetch: api.fetch,
    ...extra,
  });
}

describe('WireAgentClient: signing', () => {
  it("each call signs a fresh token the platform's door accepts", async () => {
    const api = wireAgentApi(keys, () => ok(installJson()));
    const c = client(api);
    await c.getInstall(INSTALL);
    await c.getInstall(INSTALL);
    expect(api.requests).toHaveLength(2);
    const tokens = api.requests.map((r) => r.headers.get('authorization')!.slice(7));
    const [h, p] = [decodeProtectedHeader(tokens[0]), decodeJwt(tokens[0])];
    expect(h).toEqual({ alg: 'EdDSA', kid: 'pk_runtime' });
    expect(p.iss).toBe('someday');
    expect(p.aud).toBe(AGENT_API_AUDIENCE);
    expect(p.aud).toBe('wire-agent-api');
    expect(p.exp! - p.iat!).toBe(60);
    expect(Math.abs(p.iat! - Date.now() / 1000)).toBeLessThan(5);
    expect(typeof p.jti === 'string' && p.jti.length >= 8).toBe(true);
    expect(p.body_sha256).toBeUndefined();
    expect(decodeJwt(tokens[1]).jti).not.toBe(p.jti);
    expect(api.requests[0].url).toBe(`https://preview.app.usewire.io/api/v1/agents/someday/installs/${INSTALL}`);
    expect(api.requests[0].method).toBe('GET');
  });

  it('DELETE carries body_sha256 of the empty body, and sends no body', async () => {
    const api = wireAgentApi(keys, () => ok(installJson()));
    await client(api).revokeInstall(INSTALL);
    const req = api.requests[0];
    expect(req.method).toBe('DELETE');
    expect(decodeJwt(req.headers.get('authorization')!.slice(7)).body_sha256).toBe(EMPTY_BODY_SHA256);
    expect(await req.text()).toBe('');
  });

  it('the manifest form of the agent id signs and routes as the agent id', async () => {
    keys.set('pk_geo', { agentId: 'geo-app', publicKey: runtime.publicKey, purpose: 'runtime' });
    const api = wireAgentApi(keys, () => ok(installJson()));
    const c = client(api, { agentId: 'geo_app', runtimeKey: { privateJwk: runtime.privateJwk, keyId: 'pk_geo' } });
    expect(c.agentId).toBe('geo-app');
    await c.getInstall(INSTALL);
    expect(decodeJwt(api.requests[0].headers.get('authorization')!.slice(7)).iss).toBe('geo-app');
    expect(new URL(api.requests[0].url).pathname).toBe(`/api/v1/agents/geo-app/installs/${INSTALL}`);
  });

  it('accepts the private JWK as a JSON string (an env secret)', async () => {
    const api = wireAgentApi(keys, () => ok(installJson()));
    const c = client(api, { runtimeKey: { privateJwk: JSON.stringify(runtime.privateJwk), keyId: 'pk_runtime' } });
    expect((await c.getInstall(INSTALL))?.installId).toBe(INSTALL);
  });

  it('a publish key is refused by the door (the client surfaces it as INVALID_TOKEN)', async () => {
    const api = wireAgentApi(keys, () => ok(installJson()));
    const c = client(api, { runtimeKey: { privateJwk: publish.privateJwk, keyId: 'pk_publish' } });
    const e = await c.getInstall(INSTALL).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WireAgentApiError);
    expect((e as WireAgentApiError).code).toBe('INVALID_TOKEN');
    expect((e as WireAgentApiError).status).toBe(401);
    expect((e as WireAgentApiError).retryable).toBe(false);
  });

  it('refuses a bad configuration up front', () => {
    const base = { agentId: 'someday', runtimeKey: { privateJwk: runtime.privateJwk, keyId: 'pk_runtime' } };
    expect(() => new WireAgentClient({ ...base, agentId: '' })).toThrow(/agentId/);
    expect(() => new WireAgentClient({ ...base, agentId: '../x' })).toThrow(/agent id/);
    expect(() => new WireAgentClient({ ...base, apiVersion: 'v2' as never })).toThrow(/apiVersion/);
    expect(() => new WireAgentClient({ ...base, runtimeKey: { privateJwk: runtime.privateJwk, keyId: '' } })).toThrow(/keyId/);
    expect(() => new WireAgentClient({ ...base, runtimeKey: { privateJwk: 'not json', keyId: 'k' } })).toThrow(/JWK/);
    const { d: _d, ...publicOnly } = runtime.privateJwk;
    expect(() => new WireAgentClient({ ...base, runtimeKey: { privateJwk: publicOnly, keyId: 'k' } })).toThrow(/private JWK/);
  });
});

describe('WireAgentClient: reads', () => {
  it('getInstall returns the typed install', async () => {
    const api = wireAgentApi(keys, () =>
      ok(
        installJson({
          claimed: false,
          agentUserId: null,
          claimUrl: 'https://app.usewire.io/onboarding/create-account?claimToken=t',
          container: { id: 'c1', name: 'Places', mcpEndpoint: 'https://x.mcp.usewire.io/container/c1/mcp', orgSlug: 'x', isEphemeral: true, ephemeralExpiresAt: '2026-10-04T00:00:00.000Z' },
          connection: { status: 'active', connectedAt: '2026-09-27T18:04:28.000Z', lastUsedAt: '2026-09-27T19:12:03.000Z' },
        })
      )
    );
    const i = (await client(api).getInstall(INSTALL))!;
    expect(i.installId).toBe(INSTALL);
    expect(i.agentUserId).toBeNull();
    expect(i.appUserId).toBeNull();
    expect(i.claimed).toBe(false);
    expect(i.claimUrl).toContain('claimToken=');
    expect(i.container).toEqual({
      id: 'c1',
      name: 'Places',
      mcpEndpoint: 'https://x.mcp.usewire.io/container/c1/mcp',
      orgSlug: 'x',
      isEphemeral: true,
      ephemeralExpiresAt: new Date('2026-10-04T00:00:00.000Z'),
    });
    expect(i.connection).toEqual({
      status: 'active',
      connectedAt: new Date('2026-09-27T18:04:28.000Z'),
      lastUsedAt: new Date('2026-09-27T19:12:03.000Z'),
    });
    expect(i.manageUrl).toContain('#installed-agents');
  });

  it('a revoked install reads as revoked, with its reason', async () => {
    const api = wireAgentApi(keys, () =>
      ok(installJson({ connection: { status: 'revoked', reason: 'user_disconnected', connectedAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null } }))
    );
    const i = (await client(api).getInstall(INSTALL))!;
    expect(i.connection.status).toBe('revoked');
    expect(i.connection.reason).toBe('user_disconnected');
  });

  it('getInstall answers null for an install this agent does not have (404)', async () => {
    const api = wireAgentApi(keys, () => err(404, 'NOT_FOUND', 'Install not found'));
    expect(await client(api).getInstall('ins_zzzzzzzzzzzzzzzzzzzzzzzz')).toBeNull();
  });

  it('listInstalls returns every install; an unknown agentUserId (404) is []', async () => {
    const api = wireAgentApi(keys, (_m, path) =>
      path === `/users/${AGENT_USER}/installs` ? ok({ installs: [installJson(), installJson({ installId: 'ins_cccccccccccccccccccccccc' })] }) : err(404, 'NOT_FOUND')
    );
    const c = client(api);
    const all = await c.listInstalls(AGENT_USER);
    expect(all.map((i) => i.installId)).toEqual([INSTALL, 'ins_cccccccccccccccccccccccc']);
    expect(await c.listInstalls('au_cccccccccccccccccccccccc')).toEqual([]);
    expect(new URL(api.requests[0].url).pathname).toBe(`/api/v1/agents/someday/users/${AGENT_USER}/installs`);
  });

  it('an install behind the registered version carries updateAvailable and upgradeUrl', async () => {
    const upgradeUrl = 'https://app.usewire.io/containers/c1/connections?upgrade=someday#installed-agents';
    const api = wireAgentApi(keys, () =>
      ok(installJson({ installedVersion: '0.1.0', latestVersion: '0.3.0', updateAvailable: true, upgradeUrl }))
    );
    const i = (await client(api).getInstall(INSTALL))!;
    expect(i.installedVersion).toBe('0.1.0');
    expect(i.latestVersion).toBe('0.3.0');
    expect(i.updateAvailable).toBe(true);
    expect(i.upgradeUrl).toBe(upgradeUrl);
  });

  it('an install on the registered version has no update and no upgradeUrl', async () => {
    const api = wireAgentApi(keys, (_m, path) =>
      path === `/users/${AGENT_USER}/installs`
        ? ok({ installs: [installJson({ installedVersion: '0.3.0', latestVersion: '0.3.0', updateAvailable: false })] })
        : err(404, 'NOT_FOUND')
    );
    const [i] = await client(api).listInstalls(AGENT_USER);
    expect(i.installedVersion).toBe('0.3.0');
    expect(i.latestVersion).toBe('0.3.0');
    expect(i.updateAvailable).toBe(false);
    expect(i.upgradeUrl).toBeUndefined();
    expect('upgradeUrl' in i).toBe(false);
  });

  it('versions read as null when Wire cannot tell, or the agent has no manifest', async () => {
    const api = wireAgentApi(keys, () => ok(installJson({ installedVersion: null, latestVersion: null, updateAvailable: false })));
    const i = (await client(api).getInstall(INSTALL))!;
    expect([i.installedVersion, i.latestVersion, i.updateAvailable, i.upgradeUrl]).toEqual([null, null, false, undefined]);
  });

  it('an older Wire that sends no version fields reads as null, null, false, no upgradeUrl', async () => {
    const legacy = installJson();
    for (const k of ['installedVersion', 'latestVersion', 'updateAvailable', 'upgradeUrl']) expect(k in legacy).toBe(false);
    const api = wireAgentApi(keys, () => ok(legacy));
    const i = (await client(api).getInstall(INSTALL))!;
    expect(i.installedVersion).toBeNull();
    expect(i.latestVersion).toBeNull();
    expect(i.updateAvailable).toBe(false);
    expect(i.upgradeUrl).toBeUndefined();
  });

  it('a version that is not a string is INVALID_RESPONSE', async () => {
    const api = wireAgentApi(keys, () => ok(installJson({ installedVersion: 3 })));
    const e = (await client(api).getInstall(INSTALL).catch((x: unknown) => x)) as WireAgentApiError;
    expect(e.code).toBe('INVALID_RESPONSE');
  });

  it('ids are path-encoded', async () => {
    const api = wireAgentApi(keys, () => err(404, 'NOT_FOUND'));
    await client(api).getInstall('ins_a/../../x');
    expect(new URL(api.requests[0].url).pathname).toBe('/api/v1/agents/someday/installs/ins_a%2F..%2F..%2Fx');
  });
});

describe('WireAgentClient: revokeInstall', () => {
  it('uninstalls and returns the install as it now reads', async () => {
    const api = wireAgentApi(keys, (m) =>
      m === 'DELETE'
        ? ok(installJson({ connection: { status: 'revoked', reason: 'uninstalled', connectedAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null } }))
        : err(405, 'METHOD')
    );
    const i = await client(api).revokeInstall(INSTALL);
    expect(i?.connection).toMatchObject({ status: 'revoked', reason: 'uninstalled' });
  });

  it('null when Wire could not read the install back', async () => {
    const api = wireAgentApi(keys, () => ok(null));
    expect(await client(api).revokeInstall(INSTALL)).toBeNull();
  });

  it('502 CONTAINER_UNAVAILABLE is retryable; calling again signs a new token', async () => {
    let n = 0;
    const api = wireAgentApi(keys, () => (++n === 1 ? err(502, 'CONTAINER_UNAVAILABLE', 'Try again') : ok(installJson())));
    const c = client(api);
    const e = (await c.revokeInstall(INSTALL).catch((x: unknown) => x)) as WireAgentApiError;
    expect(e).toBeInstanceOf(WireAgentApiError);
    expect(e).toBeInstanceOf(WireSdkError);
    expect(e.code).toBe('CONTAINER_UNAVAILABLE');
    expect(e.status).toBe(502);
    expect(e.retryable).toBe(true);
    expect(await c.revokeInstall(INSTALL)).not.toBeNull();
  });

  it('404 throws NOT_FOUND', async () => {
    const api = wireAgentApi(keys, () => err(404, 'NOT_FOUND', 'Install not found'));
    const e = (await client(api).revokeInstall(INSTALL).catch((x: unknown) => x)) as WireAgentApiError;
    expect(e.code).toBe('NOT_FOUND');
    expect(e.status).toBe(404);
    expect(e.retryable).toBe(false);
  });
});

describe('WireAgentClient: error mapping', () => {
  const cases: [number, string, boolean][] = [
    [401, 'UNAUTHORIZED', false],
    [401, 'INVALID_TOKEN', false],
    [401, 'TOKEN_EXPIRED', false],
    [401, 'REPLAY_DETECTED', false],
    [401, 'CREDENTIAL_REVOKED', false],
    [401, 'RUNTIME_KEY_REQUIRED', false],
    [401, 'UNKNOWN_AGENT', false],
    [403, 'AGENT_DISABLED', false],
    [503, 'UNAVAILABLE', true],
    [429, 'RATE_LIMITED', true],
  ];
  for (const [status, code, retryable] of cases) {
    it(`${status} ${code}${retryable ? ' (retryable)' : ''}`, async () => {
      const api = wireAgentApi(keys, () => err(status, code, 'message from Wire'));
      const e = (await client(api).listInstalls(AGENT_USER).catch((x: unknown) => x)) as WireAgentApiError;
      expect(e).toBeInstanceOf(WireAgentApiError);
      expect([e.code, e.status, e.retryable, e.message]).toEqual([code, status, retryable, 'message from Wire']);
    });
  }

  it("the door's own refusals come through (a revoked key)", async () => {
    keys.set('pk_runtime', { ...keys.get('pk_runtime')!, revoked: true });
    const api = wireAgentApi(keys, () => ok(installJson()));
    const e = (await client(api).getInstall(INSTALL).catch((x: unknown) => x)) as WireAgentApiError;
    expect([e.code, e.status]).toEqual(['CREDENTIAL_REVOKED', 401]);
  });

  it('a proxy error page (not the envelope) is HTTP_<status>, retryable on 5xx gateways', async () => {
    const api = wireAgentApi(keys, () => ({ status: 502, body: '<html>Bad gateway</html>' }));
    const e = (await client(api).getInstall(INSTALL).catch((x: unknown) => x)) as WireAgentApiError;
    expect([e.code, e.status, e.retryable]).toEqual(['HTTP_502', 502, true]);
  });

  it('a network failure is NETWORK_ERROR, retryable', async () => {
    const c = client(wireAgentApi(keys, () => ok(null)), {
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    const e = (await c.getInstall(INSTALL).catch((x: unknown) => x)) as WireAgentApiError;
    expect([e.code, e.status, e.retryable]).toEqual(['NETWORK_ERROR', undefined, true]);
  });

  it('a malformed install is INVALID_RESPONSE', async () => {
    const api = wireAgentApi(keys, () => ok({ installId: INSTALL }));
    const e = (await client(api).getInstall(INSTALL).catch((x: unknown) => x)) as WireAgentApiError;
    expect(e.code).toBe('INVALID_RESPONSE');
  });
});

describe('the pre-0.10 names still work', () => {
  it('WireAppClient, WireAppApiError and APP_API_AUDIENCE are the agent ones under their old names', () => {
    expect(WireAppClient).toBe(WireAgentClient);
    expect(WireAppApiError).toBe(WireAgentApiError);
    expect(APP_API_AUDIENCE).toBe('wire-app-api');
    expect(AGENT_API_AUDIENCE).toBe('wire-agent-api');
  });

  it('the appId option still names the agent, and the client calls the agent paths', async () => {
    const api = wireAgentApi(keys, () => ok(installJson()));
    const c = new WireAppClient({ appId: 'someday', runtimeKey: { privateJwk: runtime.privateJwk, keyId: 'pk_runtime' }, baseUrl: 'https://preview.app.usewire.io', fetch: api.fetch });
    expect(c.agentId).toBe('someday');
    expect(c.appId).toBe('someday');
    await c.getInstall(INSTALL);
    expect(new URL(api.requests[0].url).pathname).toBe(`/api/v1/agents/someday/installs/${INSTALL}`);
    expect(decodeJwt(api.requests[0].headers.get('authorization')!.slice(7)).aud).toBe('wire-agent-api');
  });

  it("apiVersion 'apps' calls the deprecated paths with the old audience", async () => {
    const api = wireAgentApi(keys, (_m, path) => (path.startsWith('/users/') ? ok({ installs: [] }) : ok(installJson())));
    const c = client(api, { apiVersion: 'apps' });
    await c.getInstall(INSTALL);
    await c.revokeInstall(INSTALL);
    expect(new URL(api.requests[0].url).pathname).toBe(`/api/v1/apps/someday/installs/${INSTALL}`);
    expect(decodeJwt(api.requests[0].headers.get('authorization')!.slice(7)).aud).toBe('wire-app-api');
    expect(api.requests[1].method).toBe('DELETE');
    expect(new URL(api.requests[1].url).pathname).toBe(`/api/v1/apps/someday/installs/${INSTALL}`);
  });

  it('an install from the deprecated paths (appUserId, app_disconnected) reads in the agent vocabulary', async () => {
    const legacy = installJson({
      appUserId: AGENT_USER,
      connection: { status: 'revoked', reason: 'app_disconnected', connectedAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null },
      manageUrl: 'https://app.usewire.io/containers/c1/connections#installed-apps',
    });
    delete legacy.agentUserId;
    const api = wireAgentApi(keys, () => ok(legacy));
    const i = (await client(api, { apiVersion: 'apps' }).getInstall(INSTALL))!;
    expect(i.agentUserId).toBe(AGENT_USER);
    expect(i.appUserId).toBe(AGENT_USER);
    expect(i.connection.reason).toBe('agent_disconnected');
  });

  it('agentUserId wins when a server sends both', async () => {
    const api = wireAgentApi(keys, () => ok(installJson({ agentUserId: AGENT_USER, appUserId: 'au_old' })));
    const i = (await client(api).getInstall(INSTALL))!;
    expect(i.agentUserId).toBe(AGENT_USER);
    expect(i.appUserId).toBe(AGENT_USER);
  });

  it('@usewire/sdk/agent is the same entry as @usewire/sdk/app', () => {
    expect(agentEntry.WireAgentClient).toBe(WireAgentClient);
    expect(agentEntry.WireAppClient).toBe(WireAgentClient);
  });
});

describe('generateRuntimeKey', () => {
  it('produces the raw public key the publisher-keys route takes, matching the private half', async () => {
    const k = await generateRuntimeKey();
    expect(k.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(k.privateJwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', x: k.publicKey });
    expect(typeof k.privateJwk.d).toBe('string');
  });
});
