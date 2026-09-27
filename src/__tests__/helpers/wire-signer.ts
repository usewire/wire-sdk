/**
 * Test double for Wire's side of an action call: a real Ed25519 keypair, a
 * JWKS served over a real local HTTP server, and a signer that mints tokens
 * the way the engine will.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { sha256Base64Url } from '../../app/verify.js';

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export async function makeKey(kid: string): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' };
  return { kid, privateKey, publicJwk };
}

export interface JwksServer {
  url: string;
  /** Keys currently served. Mutate to rotate. */
  keys: JWK[];
  /** Status to answer with (to simulate an outage). */
  status: number;
  fetches: number;
  close(): Promise<void>;
}

export async function startJwksServer(keys: JWK[]): Promise<JwksServer> {
  const state = { keys, status: 200, fetches: 0 };
  const server: Server = createServer((_req, res) => {
    state.fetches++;
    res.statusCode = state.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: state.keys }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/jwks.json`,
    get keys() {
      return state.keys;
    },
    set keys(k: JWK[]) {
      state.keys = k;
    },
    get status() {
      return state.status;
    },
    set status(s: number) {
      state.status = s;
    },
    get fetches() {
      return state.fetches;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let seq = 0;
/** A fresh URL on the same server, so the SDK's per-URL JWKS cache never leaks between tests. */
export function uniqueUrl(server: JwksServer): string {
  return `${server.url}?t=${++seq}`;
}

export interface SignOptions {
  key: TestKey;
  body: string;
  appId?: string;
  iss?: string;
  aud?: string | string[];
  sub?: string;
  containerId?: string;
  action?: string;
  jti?: string;
  iat?: number;
  exp?: number;
  bodyHash?: string;
  kid?: string | null;
  typ?: string | null;
  omit?: string[];
}

export const NOW = new Date('2026-09-26T12:00:00Z');
export const NOW_SEC = Math.floor(NOW.getTime() / 1000);

export async function signAction(o: SignOptions): Promise<string> {
  const payload: Record<string, unknown> = {
    iss: o.iss ?? 'wire',
    aud: o.aud ?? o.appId ?? 'geo-app',
    sub: o.sub ?? 'conn_123',
    wire_container: o.containerId ?? 'ctr_456',
    wire_action: o.action ?? 'geocode',
    jti: o.jti ?? `jti-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    iat: o.iat ?? NOW_SEC,
    exp: o.exp ?? (o.iat ?? NOW_SEC) + 60,
    wire_body_sha256: o.bodyHash ?? (await sha256Base64Url(o.body)),
  };
  for (const k of o.omit ?? []) delete payload[k];
  const header: { alg: string; typ?: string; kid?: string } = { alg: 'EdDSA' };
  if (o.typ !== null) header.typ = o.typ ?? 'wire-action+jwt';
  if (o.kid !== null) header.kid = o.kid ?? o.key.kid;
  return new SignJWT(payload).setProtectedHeader(header).sign(o.key.privateKey);
}

export function actionRequest(token: string | null, body: string, init: { url?: string; method?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-wire-request-id': 'req_789' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(init.url ?? 'https://geo-app.example/geocode', {
    method: init.method ?? 'POST',
    headers,
    body: init.method === 'GET' ? undefined : body,
  });
}
