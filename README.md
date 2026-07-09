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

## Runtime

Node 18+, Cloudflare Workers, Deno, Bun. `connect()` needs to drive the
user's browser; browser-only environments work for `getStatus`, `claim`, and
`disconnect`.

## Errors

Rejected promises throw `WireSdkError` with a `code` and HTTP `status` when
applicable.

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
