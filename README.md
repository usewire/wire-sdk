# @usewire/sdk

[Wire](https://usewire.io) is context as a service for agents. A Wire
container is portable, shareable, composable context that users and
agents fill together: notes, knowledge bases, project state, and data
ingested from the SaaS tools they already use.

This SDK is for teams building agents, harnesses, or AI infrastructure
who want Wire container connectivity as a first-class part of the
product. Three methods. Your user authorizes in their browser; you
get back a scoped MCP endpoint and API key to hand to your agent.

You don't run the storage. You don't build the import flow. You don't
manage user data. Wire owns the connect screen, the auth, and the
connection lifecycle. Your agent keeps speaking MCP, now with whatever
the user has brought along.

## Install

```bash
npm install @usewire/sdk
```

## Connect

```typescript
import { WireClient } from '@usewire/sdk';

const client = new WireClient({ agentId: 'my-agent' });

const connection = await client.connect({ label: 'my-laptop' });

// Hand these to your agent's MCP client:
console.log(connection.mcpUrl);
console.log(connection.apiKey);
```

`connect()` shows the user a short code and opens their browser. The user
types the code on the connect screen, picks a container, and `connect()`
resolves with the result.

If you need to drive the prompt yourself (custom UI, no stdout):

```typescript
const connection = await client.connect({
  onUserPrompt: ({ code, url }) => {
    myUi.show(`Code: ${code}`);
    myBrowser.open(url);
  },
});
```

## What you get

```typescript
interface Connection {
  mcpUrl: string;
  apiUrl: string;
  apiKey: string;
  containerId: string;
  containerName: string;
  orgSlug: string | null;
  expiresAt: Date | null;   // ephemeral containers only
  agentId: string;
  credentialId: string;
  deviceKey: DeviceKey;
  connectedAt: Date;
  label?: string;
}
```

## Reuse the install identity

`deviceKey` identifies the install across reconnects. Persist it if you want
the same user and machine to appear as the same install instead of a fresh
one every time:

```typescript
// First run
const conn = await client.connect();
saveSomewhere(conn.deviceKey);

// Later
const client2 = new WireClient({
  agentId: 'my-agent',
  deviceKey: loadSomewhere(),
});
const conn2 = await client2.connect();
```

The SDK doesn't store anything for you. Local file, OS keychain, secrets
manager, your call.

## Claim an ephemeral container

Connections made before the user has a Wire account get an ephemeral
container (7-day TTL, `connection.expiresAt` tells you when). `claim()`
upgrades it to permanent from inside your agent flow:

```typescript
const claimed = await client.claim(connection.apiKey, {
  onUserPrompt: ({ url }) => {
    myUi.show(`Sign up to keep your container: ${url}`);
  },
});
// claimed.expiresAt === null — the container is permanent
```

The SDK mints a claim URL, hands it to your `onUserPrompt` (or prints it
and opens the OS browser), and polls until the user finishes sign-up
(5-minute default, `timeoutMs` to override). Already-claimed containers
resolve immediately. On timeout the link stays valid for 30 minutes and a
later `getStatus()` will reflect the claim.

## Disconnect and status

```typescript
await client.disconnect(connection.apiKey);
await client.getStatus(connection.apiKey);
```

Disconnect revokes the apiKey but keeps the install identity, so reconnect
from the same `deviceKey` still works.

## From a browser app

Browser agents skip the device flow entirely: `connectInBrowser()` sends
the user through Wire's authorization screen (Authorization Code + PKCE)
where they pick a container, and your page gets the Connection back.

```typescript
// Starting the flow (your app page):
await client.connectInBrowser({ redirectUri: 'https://my-app.com/callback' });
// or popup mode, which resolves in place:
const connection = await client.connectInBrowser({
  redirectUri: 'https://my-app.com/callback',
  popup: true,
});

// On your callback page (safe to call on every load):
const connection = await client.completeConnectInBrowser();
```

Register your redirect URIs on the agent in the Wire dashboard first.
Browser connections have no `deviceKey`; the OAuth grant is the identity.
See `examples/browser-connect/` for a runnable page.

## Turn-based agents (non-blocking)

`connect()` and `claim()` block while the user acts. If your agent can't
hold a promise open across a user turn, use the primitives underneath:

```typescript
// Turn 1: start the handshake, show the code + URL, persist the handle
const pending = await client.beginConnect();
myUi.show(`Code: ${pending.userCode} — open ${pending.url}`);
save(pending); // plain JSON, safe to stash

// Later turns: single poll, no waiting
const connection = await client.checkConnection(load());
if (connection) save(connection);

// Same for claiming: mint the link, detect completion yourself
const { url } = await client.getClaimUrl(connection.apiKey);
myUi.show(`Sign up to keep your container: ${url}`);
// later: (await client.getStatus(apiKey)).container.isEphemeral === false
```

`beginConnect()` handles are valid until the code expires
(`pending.expiresAt`, ~10 minutes). `getClaimUrl()` links last 30 minutes
and throws `ALREADY_CLAIMED` on permanent containers.

## Building a Connect app

A Connect app can do more than read and write a container. Its manifest can
install custom tools into the container the user connects, and those tools can
call the app's own HTTPS functions, called actions, before or after the Wire
tool they wrap. A `save_place` tool, for example, can call your `geocode`
action on the address and then save the place with coordinates.

Wire calls your actions. Your app never calls the container for them, stores
no secret, and gets nothing at install time. Every call is signed with Wire's
own Ed25519 key, and you check it against Wire's published keys.

The app side lives on its own entry point, so apps that only connect never
load it:

```typescript
import { defineManifest, defineAction } from '@usewire/sdk/app';
```

> **Status:** actions ship with the Wire release that runs them. Until then the
> manifest format, the action-call claims and the registration endpoint may
> still change.

### The manifest

```typescript
// manifest.ts
import { defineManifest } from '@usewire/sdk/app';

export const manifest = defineManifest({
  manifest: 1,
  app: { id: 'geo-app', name: 'Geo App', version: '0.1.0' },
  actions: [
    {
      name: 'geocode',
      description:
        'Turns a street address into coordinates and a city. The address is sent to the app; nothing is stored there.',
      url: 'https://geo-app.example.workers.dev/geocode',
      input: {
        type: 'object',
        properties: { address: { type: 'string', minLength: 1 } },
        required: ['address'],
      },
      output: {
        type: 'object',
        properties: {
          lat: { type: 'number' },
          lng: { type: 'number' },
          locality: { type: 'string' },
        },
        required: ['lat', 'lng'],
      },
      timeout_ms: 5000,
    },
  ],
  tools: [
    {
      name: 'save_place',
      description: 'Save a place the user wants to go. Give the street address.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, address: { type: 'string' } },
        required: ['name', 'address'],
      },
      before: { action: 'geocode', args: { address: '{{input.address}}' } },
      tool: {
        name: 'wire_write',
        args: {
          content: '{{input.name}}',
          fields: { name: '{{input.name}}', lat: '{{before.lat}}', lng: '{{before.lng}}' },
        },
      },
    },
  ],
});
```

- `app.id` is the agent id you registered with Wire, lowercase. It is also the
  audience of every action call, so a call meant for another app never
  verifies in yours.
- Every action needs a plain `description`. The user sees it on the consent
  screen, so say what the action receives and whether you keep it.
- `url` must be https. `timeout_ms` is capped at 8000.
- An action receives only the fields its tool's mapping sends it.

`defineManifest` checks locally what your action endpoints depend on and
throws `WireManifestError` listing every problem. Wire runs the full
validation (tool mappings, reserved names, limits) when you register.

### Register it

Registration is signed the same way as `connect()`, with an Ed25519 key, but
it must be one of your agent's **publisher keys**: a key added to the agent in
the Wire dashboard by someone who can manage it. An install's device key
cannot register a manifest, since anyone can create one for any agent id. Pass
the publisher key as the `deviceKey`, with its id as `credentialId`.

```typescript
import { WireClient } from '@usewire/sdk';
import { manifest } from './manifest';

const client = new WireClient({ agentId: 'geo-app', deviceKey: loadPublisherKey() });
const registered = await client.registerManifest(manifest);
// { appId, version, hash, status: 'created' | 'updated' | 'unchanged', tools, baseTools, actions }
```

Registering an identical document again answers `unchanged`. Bump
`app.version` to ship a change. A refused manifest throws `WireSdkError` with
code `INVALID_MANIFEST` and `details.errors`, each naming its path.

### Serve an action (Cloudflare Worker)

`defineAction` returns a complete endpoint. It verifies the call (401), checks
the input against the action's `input` schema (400), runs your handler,
checks what you return against the `output` schema (500), and answers JSON.
It also answers before Wire's timeout would fire (504), and aborts
`ctx.signal` when time is up.

```typescript
// worker.ts
import { defineAction, WireActionError } from '@usewire/sdk/app';
import { manifest } from './manifest';

const geocode = defineAction<{ address: string }, { lat: number; lng: number; locality?: string }>(
  manifest,
  'geocode',
  async ({ address }, ctx) => {
    const res = await fetch(`https://geocoder.example/search?q=${encodeURIComponent(address)}`, {
      signal: ctx.signal,
    });
    const [hit] = (await res.json()) as Array<{ lat: string; lon: string; city?: string }>;
    if (!hit) throw new WireActionError('NOT_FOUND', 'No match for that address', 404);
    return { lat: Number(hit.lat), lng: Number(hit.lon), locality: hit.city };
  }
);

export default {
  fetch(request: Request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/geocode') return geocode.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
```

`ctx` carries `connectionId`, `containerId`, `action`, the verified `claims`,
and `signal`. Throw `WireActionError` for an error the agent should see.
Anything else thrown becomes a generic 500, so internals never reach the agent.

**Hono:** `app.post('/geocode', geocode.hono)`.
**Node:** `http.createServer(toNodeHandler(geocode))`, or
`app.post('/geocode', toNodeHandler(geocode))` in Express. Mount it before any
JSON body parser. The signature covers the raw body bytes, and a parsed and
re-serialized body does not hash the same.

A few things worth knowing:

- Wire makes one attempt per call and does not retry; the agent may call the
  tool again, which is a new call with a new `jti`. A handler that has side
  effects should be idempotent, keyed on `ctx.requestId` (the
  `X-Wire-Request-Id` header) if you need one.
- After a 504 the handler is not stopped, only `ctx.signal` is aborted. Pass
  the signal to your fetches.
- A `pattern` in your schemas runs against input an agent chose. Keep patterns
  simple; a regular expression that backtracks badly can stall the endpoint.
- By default failures are logged with their code, never with input or output
  values, and routine 401s are not logged. Pass `onError` to route them
  elsewhere.

To verify inside a server you already have, call the check on its own.
`action` is required: the request path is not signed, so without it a call
Wire made to another of your actions would verify here too.

```typescript
import { verifyWireAction, WireActionAuthError } from '@usewire/sdk/app';

try {
  const { connectionId, containerId, action } = await verifyWireAction(request, {
    appId: 'geo-app',
    action: 'geocode',
  });
  const input = await request.json(); // still readable: verification reads a clone
} catch (err) {
  if (err instanceof WireActionAuthError) return new Response(err.code, { status: err.status });
  throw err;
}
```

### Replay protection

Each call carries a one-time `jti`. The SDK records it, and a second call with
the same `jti` is refused. The default record is in memory, which protects one
process. **If your app runs more than one instance, pass a shared store**:
every Cloudflare Worker under real traffic runs many isolates, and a captured
call could otherwise be replayed once against each of them within its 60
seconds.

The store must be atomic: record the key and report whether it was new in one
step. Workers KV is eventually consistent and is not suitable. Redis `SET NX`,
a Durable Object, or a unique-key insert are.

```typescript
import type { ReplayStore } from '@usewire/sdk/app';

const replayStore: ReplayStore = {
  async markUsed(key, ttlSeconds) {
    // Redis: true if the key was set, false if it already existed.
    return (await redis.set(`wire:jti:${key}`, '1', { NX: true, EX: ttlSeconds })) === 'OK';
  },
};

const geocode = defineAction(manifest, 'geocode', handler, { replayStore });
```

If the store throws, the call is refused with 503 rather than let through.

### Verifying without the SDK

Any language with an EdDSA-capable JWT library can verify an action call.

1. Read `Authorization: Bearer <jwt>`.
2. Refuse unless the header has `alg: "EdDSA"`, `typ: "wire-action+jwt"` and a `kid`.
3. Verify the signature with the key of that `kid` from Wire's JWKS,
   `https://api.usewire.io/.well-known/wire-actions-jwks.json`. Cache it for up
   to 5 minutes; refetch on an unknown `kid`, at most every 30 seconds. Never
   take a key or a key URL from the token itself.
4. Check the claims:

   | Claim | Check |
   |---|---|
   | `iss` | exactly `"wire"` |
   | `aud` | exactly your app id (a single string) |
   | `sub` | the connection id |
   | `wire_container` | the container the call comes from |
   | `wire_action` | the action this endpoint serves |
   | `iat`, `exp` | not expired, not issued in the future (allow up to 30 s of skew), `exp - iat <= 60` |
   | `jti` | not seen before; remember it until `exp` plus the skew has passed |
   | `wire_body_sha256` | base64url (no padding) SHA-256 of the raw request body bytes |

   `X-Wire-Request-Id` names the tool call the action is part of. It is not
   signed, so use it only to correlate logs.

5. Hash the body exactly as received, before any parsing, and compare.

```typescript
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://api.usewire.io/.well-known/wire-actions-jwks.json'));

async function verify(request: Request, appId: string) {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const { payload } = await jwtVerify(token, JWKS, {
    algorithms: ['EdDSA'],
    typ: 'wire-action+jwt',
    issuer: 'wire',
    audience: appId,
    clockTolerance: 30,
    maxTokenAge: 90,
    requiredClaims: ['sub', 'jti', 'iat', 'exp', 'wire_container', 'wire_action', 'wire_body_sha256'],
  });
  if (payload.aud !== appId || payload.exp! - payload.iat! > 60) throw new Error('bad token');

  const body = new Uint8Array(await request.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  const hash = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (hash !== payload.wire_body_sha256) throw new Error('body does not match');

  // Then: record payload.jti in a shared store and refuse if it was already there.
  return { payload, body };
}
```

## Runtime

Node 18+, Cloudflare Workers, Deno, Bun. `connect()` needs to drive the
user's browser; browser-only environments work for `getStatus`, `claim`, and
`disconnect`. `@usewire/sdk/app` runs anywhere with `fetch` and Web Crypto,
and imports nothing Node-specific.

## Errors

Rejected promises throw `WireSdkError` with a `code` and HTTP `status` when
applicable. On `@usewire/sdk/app`, a failed verification throws
`WireActionAuthError` (`code`, and `status`: 401, 413, or 503 when your app
could not check), and `defineManifest` throws `WireManifestError` with
`issues`.

## Migrating from 0.1.x

0.2.0 renames the registered-integration primitive from `app` to `agent` across the public surface. Functionality is unchanged.

| 0.1.x | 0.2.0 |
|---|---|
| `new WireClient({ appId })` | `new WireClient({ agentId })` |
| `client.appId` | `client.agentId` |
| `connection.appId` | `connection.agentId` |
| `status.app` | `status.agent` |

Rename your call sites; nothing else changes.

## License

MIT.
