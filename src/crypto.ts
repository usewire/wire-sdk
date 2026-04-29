/**
 * Ed25519 keypair generation + JWT signing for SDK requests.
 *
 * Uses Web Crypto via `jose` so the same code works in Node 18+, Cloudflare
 * Workers, Deno, and Bun. Public keys are stored as base64url raw 32-byte
 * encoding; private keys are stored as JWK (the format jose ingests).
 */
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type JWTHeaderParameters,
} from 'jose';
import type { DeviceKey } from './types.js';

const JWT_LIFETIME_SECONDS = 60;

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

function randomJti(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

/**
 * Generate a new Ed25519 keypair. The returned `publicKey` is base64url-
 * encoded raw, ready to send in /api/v1/sdk/connect's body on bootstrap.
 *
 * The credentialId is assigned by the server after first connect; callers
 * should overwrite that field after the bootstrap round-trip succeeds.
 */
export async function generateDeviceKey(): Promise<Omit<DeviceKey, 'credentialId'>> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  if (!publicJwk.x) throw new Error('Failed to export Ed25519 public key');
  const publicKeyB64 = publicJwk.x;
  base64UrlDecode(publicKeyB64); // roundtrip-validate
  return { privateJwk, publicKey: publicKeyB64 };
}

/**
 * Sign a short-lived EdDSA JWT for /api/v1/sdk/connect.
 *
 * Required claims (matches the server's verifyEd25519 middleware):
 *   - iss = appId (must match a registered app row)
 *   - aud = 'wire-api'
 *   - sub = credentialId on returning install, 'bootstrap' on first run
 *   - jti = random nonce, used for replay protection
 *   - iat / exp: 60s lifetime
 *
 * `kid` is set in the protected header when we have a server-assigned
 * credential id; absent on first-run bootstrap.
 */
export async function signConnectJwt(args: {
  appId: string;
  privateJwk: JsonWebKey;
  /** server-assigned credential id, or null for first-run bootstrap */
  credentialId: string | null;
}): Promise<string> {
  const { appId, privateJwk, credentialId } = args;
  const key = await importJWK({ ...privateJwk, alg: 'EdDSA' }, 'EdDSA');
  const header: JWTHeaderParameters = { alg: 'EdDSA' };
  if (credentialId) header.kid = credentialId;

  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader(header)
    .setIssuer(appId)
    .setAudience('wire-api')
    .setSubject(credentialId ?? 'bootstrap')
    .setJti(randomJti())
    .setIssuedAt(now)
    .setExpirationTime(now + JWT_LIFETIME_SECONDS)
    .sign(key);
  return jwt;
}
