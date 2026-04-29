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

const client = new WireClient({ appId: 'my-app' });

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
  appId: string;
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
  appId: 'my-app',
  deviceKey: loadSomewhere(),
});
const conn2 = await client2.connect();
```

The SDK doesn't store anything for you. Local file, OS keychain, secrets
manager, your call.

## Disconnect and status

```typescript
await client.disconnect(connection.apiKey);
await client.getStatus(connection.apiKey);
```

Disconnect revokes the apiKey but keeps the install identity, so reconnect
from the same `deviceKey` still works.

## Runtime

Node 18+, Cloudflare Workers, Deno, Bun. `connect()` needs to drive the
user's browser; browser-only environments work for `getStatus` and
`disconnect`.

## Errors

Rejected promises throw `WireSdkError` with a `code` and HTTP `status` when
applicable.

## License

MIT.
