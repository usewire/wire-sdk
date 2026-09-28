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
  url?: string;
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
    aud: o.aud ?? o.appId ?? 'geo_app',
    sub: o.sub ?? 'conn_123',
    wire_container: o.containerId ?? 'ctr_456',
    wire_action: o.action ?? 'geocode',
    wire_url: o.url ?? 'https://geo-app.example/geocode',
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

// ─── Webhooks ───────────────────────────────────────────────────────────────
// Mirrors wire-platform `packages/plane-contracts/src/webhooks.ts`
// (buildWebhookClaims) and `apps/containers/src/lib/webhook-delivery.ts`
// (signWebhookJwt, attemptWebhookDelivery) exactly: the same header, the same
// claims in the same shape, the same request headers.

export const WEBHOOK_URL = 'https://someday.example/hooks/wire?x=1';
export const EVENT_ID = 'evt_0123456789abcdef0123456789abcdef';

export function installJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    installId: 'ins_aaaaaaaaaaaaaaaaaaaaaaaa',
    agentUserId: 'au_bbbbbbbbbbbbbbbbbbbbbbbb',
    container: {
      id: 'c1',
      name: 'Places',
      mcpEndpoint: 'https://x.mcp.usewire.io/container/c1/mcp',
      orgSlug: 'x',
      isEphemeral: false,
      ephemeralExpiresAt: null,
    },
    claimed: true,
    connection: { status: 'active', connectedAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null },
    manageUrl: 'https://app.usewire.io/containers/c1/connections#installed-agents',
    ...over,
  };
}

export function webhookBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: EVENT_ID,
    type: 'install.created',
    createdAt: '2026-09-26T11:59:59.000Z',
    install: installJson(),
    ...over,
  });
}

export interface WebhookSignOptions {
  key: TestKey;
  body: string;
  audience?: string | string[];
  eventId?: string;
  url?: string;
  iss?: string;
  jti?: string;
  iat?: number;
  exp?: number;
  bodyHash?: string;
  typ?: string | null;
  kid?: string | null;
  omit?: string[];
}

/** buildWebhookClaims + signWebhookJwt, with knobs for the negative cases. */
export async function signWebhook(o: WebhookSignOptions): Promise<string> {
  const iat = o.iat ?? NOW_SEC;
  const payload: Record<string, unknown> = {
    iss: o.iss ?? 'wire',
    aud: o.audience ?? 'someday',
    iat,
    exp: o.exp ?? iat + 60,
    jti: o.jti ?? crypto.randomUUID(),
    wire_event: o.eventId ?? EVENT_ID,
    wire_url: o.url ?? WEBHOOK_URL,
    wire_body_sha256: o.bodyHash ?? (await sha256Base64Url(o.body)),
  };
  for (const k of o.omit ?? []) delete payload[k];
  const header: { alg: string; typ?: string; kid?: string } = { alg: 'EdDSA' };
  if (o.typ !== null) header.typ = o.typ ?? 'wire-webhook+jwt';
  if (o.kid !== null) header.kid = o.kid ?? o.key.kid;
  return new SignJWT(payload).setProtectedHeader(header).sign(o.key.privateKey);
}

/** The request attemptWebhookDelivery sends. */
export function webhookRequest(
  token: string | null,
  body: string,
  init: { url?: string; method?: string; eventId?: string | null; type?: string | null } = {}
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'Wire-Webhooks/1' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (init.eventId !== null) headers['X-Wire-Event-Id'] = init.eventId ?? EVENT_ID;
  if (init.type !== null) headers['X-Wire-Event-Type'] = init.type ?? 'install.created';
  return new Request(init.url ?? WEBHOOK_URL, {
    method: init.method ?? 'POST',
    headers,
    body: init.method === 'GET' ? undefined : body,
  });
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
