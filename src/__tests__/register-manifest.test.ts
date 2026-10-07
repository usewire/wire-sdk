import { afterEach, describe, expect, it, vi } from 'vitest';
import { importJWK, jwtVerify } from 'jose';
import {
  MANIFEST_JWT_AUDIENCE,
  MANIFEST_REGISTER_PATH,
  MANIFEST_VALIDATOR_HEADER,
  WireClient,
  WireSdkError,
  type WireManifest,
} from '../index.js';
import { MANIFEST_VALIDATOR_REF, sha256Base64Url } from '../app/index.js';
import { generateDeviceKey } from '../crypto.js';

const manifest: WireManifest = {
  manifest: 1,
  app: { id: 'geo_app', name: 'Geo App', version: '0.1.0' },
  actions: [
    {
      name: 'geocode',
      description: 'Geocodes an address.',
      url: 'https://geo-app.example/geocode',
      input: { type: 'object' },
      output: { type: 'object' },
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('WireClient.registerManifest', () => {
  it('posts the manifest with a signed JWT bound to the body', async () => {
    const key = await generateDeviceKey();
    const deviceKey = { ...key, credentialId: 'pk_abc' };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          app_id: 'geo_app',
          version: '0.1.0',
          hash: 'h1',
          status: 'created',
          tools: [],
          base_tools: [],
          actions: [{ name: 'geocode', host: 'geo-app.example' }],
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    // The agent id may use '-'; the manifest's app id is the same with '_'.
    const client = new WireClient({ agentId: 'geo-app', deviceKey });
    const result = await client.registerManifest(manifest);

    expect(result).toEqual({
      // An older server sends only app_id; the agent id is derived from it.
      agentId: 'geo-app',
      appId: 'geo_app',
      version: '0.1.0',
      hash: 'h1',
      status: 'created',
      tools: [],
      baseTools: [],
      actions: [{ name: 'geocode', host: 'geo-app.example' }],
      // Always a list; empty when Wire sends none (and from a server that never does).
      warnings: [],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://app.usewire.io${MANIFEST_REGISTER_PATH}`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ manifest });
    expect(init.headers[MANIFEST_VALIDATOR_HEADER]).toBe(MANIFEST_VALIDATOR_REF);
    expect(MANIFEST_VALIDATOR_REF).toMatch(/^[0-9a-f]{40}$/);

    const token = (init.headers.Authorization as string).replace(/^Bearer /, '');
    const pub = await importJWK({ kty: 'OKP', crv: 'Ed25519', x: key.publicKey }, 'EdDSA');
    const { payload, protectedHeader } = await jwtVerify(token, pub, { audience: 'wire-manifest', algorithms: ['EdDSA'] });
    expect(MANIFEST_JWT_AUDIENCE).toBe('wire-manifest');
    expect(protectedHeader.alg).toBe('EdDSA');
    expect(protectedHeader.kid).toBe('pk_abc');
    expect(payload.iss).toBe('geo-app');
    expect((payload.jti as string).length).toBeGreaterThanOrEqual(8);
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(60);
    expect(payload.sub).toBe('pk_abc');
    expect(payload.body_sha256).toBe(await sha256Base64Url(init.body));
  });

  it('refuses without a publisher key (no bootstrap registration)', async () => {
    const client = new WireClient({ agentId: 'geo_app' });
    await expect(client.registerManifest(manifest)).rejects.toMatchObject({ code: 'NO_CREDENTIAL' });
  });

  it("refuses a manifest for another agent", async () => {
    const key = await generateDeviceKey();
    const client = new WireClient({ agentId: 'other', deviceKey: { ...key, credentialId: 'c' } });
    await expect(client.registerManifest(manifest)).rejects.toMatchObject({ code: 'AGENT_MISMATCH' });
  });

  it('surfaces a 409 for the same version with different content', async () => {
    const key = await generateDeviceKey();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ success: false, error: { code: 'CONFLICT', message: 'Version 0.1.0 is registered with different content' } }),
      })
    );
    const client = new WireClient({ agentId: 'geo_app', deviceKey: { ...key, credentialId: 'pk_1' } });
    await expect(client.registerManifest(manifest)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
  });

  it("surfaces the server's validation error", async () => {
    const key = await generateDeviceKey();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({
          success: false,
          error: {
            code: 'INVALID_MANIFEST',
            message: 'The manifest is not valid',
            details: { errors: [{ path: 'actions.0.description', message: 'is required' }] },
          },
        }),
      })
    );
    const client = new WireClient({ agentId: 'geo_app', deviceKey: { ...key, credentialId: 'c' } });
    const err = await client.registerManifest(manifest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WireSdkError);
    expect(err).toMatchObject({
      code: 'INVALID_MANIFEST',
      status: 422,
      details: { errors: [{ path: 'actions.0.description', message: 'is required' }] },
    });
  });

  // 0.18.0: a registration that succeeds can carry warnings, and the SDK no longer drops them.
  describe('warnings', () => {
    const answer = (data: Record<string, unknown>) =>
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { agent_id: 'geo-app', app_id: 'geo_app', version: '0.2.0', hash: 'h', status: 'updated', ...data } }),
        })
      );
    const register = async () => {
      const key = await generateDeviceKey();
      return new WireClient({ agentId: 'geo_app', deviceKey: { ...key, credentialId: 'pk_1' } }).registerManifest(manifest);
    };

    it('an action moved without declaring its old address: the warning Wire sends is returned as it is', async () => {
      const dropped = { code: 'ACTION_ADDRESS_DROPPED', message: 'Action "geocode" moved to a new address without declaring the old one in previous_urls.' };
      answer({ warnings: [dropped] });
      const r = await register();
      expect(r.status).toBe('updated');
      expect(r.warnings).toEqual([dropped]);
    });

    it('none, an older server that sends no such key, and entries that are not warnings all give an empty or cleaned list', async () => {
      answer({});
      expect((await register()).warnings).toEqual([]);
      answer({ warnings: 'nope' });
      expect((await register()).warnings).toEqual([]);
      answer({ warnings: [null, { code: 7, message: 'x' }, { code: 'A' }, { code: 'B', message: 'kept', extra: 1 }] });
      expect((await register()).warnings).toEqual([{ code: 'B', message: 'kept' }]);
    });
  });
});
