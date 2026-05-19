import { describe, expect, it } from 'vitest';
import { importJWK, jwtVerify } from 'jose';
import { generateDeviceKey, signConnectJwt } from '../crypto.js';

describe('generateDeviceKey', () => {
  it('returns an Ed25519 keypair with base64url public key', async () => {
    const k = await generateDeviceKey();
    expect(k.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(k.privateJwk.kty).toBe('OKP');
    expect(k.privateJwk.crv).toBe('Ed25519');
    expect(k.privateJwk.d).toBeTruthy();
    expect(k.privateJwk.x).toBe(k.publicKey);
  });
});

describe('signConnectJwt', () => {
  it('produces an EdDSA JWT verifiable with the matching public key', async () => {
    const k = await generateDeviceKey();
    const jwt = await signConnectJwt({
      agentId: 'wire-memory',
      privateJwk: k.privateJwk,
      credentialId: null,
    });
    expect(jwt.split('.')).toHaveLength(3);

    const pub = await importJWK(
      { kty: 'OKP', crv: 'Ed25519', x: k.publicKey },
      'EdDSA'
    );
    const { payload, protectedHeader } = await jwtVerify(jwt, pub, {
      audience: 'wire-api',
      algorithms: ['EdDSA'],
    });
    expect(protectedHeader.alg).toBe('EdDSA');
    expect(protectedHeader.kid).toBeUndefined();
    expect(payload.iss).toBe('wire-memory');
    expect(payload.aud).toBe('wire-api');
    expect(payload.sub).toBe('bootstrap');
    expect(typeof payload.jti).toBe('string');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(60);
  });

  it('sets kid on returning install path', async () => {
    const k = await generateDeviceKey();
    const jwt = await signConnectJwt({
      agentId: 'wire-memory',
      privateJwk: k.privateJwk,
      credentialId: 'cred-abc-123',
    });
    const [header64] = jwt.split('.');
    const header = JSON.parse(
      Buffer.from(header64, 'base64url').toString('utf8')
    );
    expect(header.kid).toBe('cred-abc-123');
  });
});
