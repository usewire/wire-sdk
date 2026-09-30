# @usewire/sdk

[Wire](https://usewire.io) gives every agent a person works with the same
place to read and write: a container, reached over MCP or REST.

This SDK is for teams building agents. Every user gets their own container,
and you don't build the part underneath: ingest, scope, permissions,
retrieval, sync, and audit sit behind one connect flow. Wire owns the connect
screen, the sign-in, and the connection lifecycle.

It covers two kinds of agent:

- **An agent that reads and writes the container.** Your user authorizes in
  their browser, and you get back a scoped MCP endpoint and API key to hand to
  your agent. Start at [Connect](#connect).
- **An agent that brings a manifest.** Connecting it installs its own tools
  into the user's container, and the user's own agents call them. Wire calls
  your server when a tool needs it. Start with the end-to-end guide,
  [Build an agent that brings a manifest](https://docs.usewire.io/build/agents/end-to-end/),
  and see [Bringing a manifest](#bringing-a-manifest) below.

Full documentation: [docs.usewire.io/build/sdk](https://docs.usewire.io/build/sdk/).

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
  installId: string | null;    // stable per agent, user and container; not a credential
  agentUserId: string | null;  // pairwise per agent and user; null on an unclaimed trial
  appUserId: string | null;    // deprecated: the same value as agentUserId
}
```

`installId` and `agentUserId` grant nothing, so they are safe to keep in your
own database next to your user. Keep the API key only if your agent itself
reads or writes the container. An agent that brings a manifest usually
doesn't: Wire calls its actions, the user's own agents call its tools, and its
server reads the install with a runtime key. See
[Look up installs from your server](#look-up-installs-from-your-server). Both
ids are null from a Wire server older than 0.9.0's.

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
// claimed.expiresAt === null: the container is permanent
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

## From the browser

Browser agents skip the device flow entirely: `connectInBrowser()` sends
the user through Wire's authorization screen (Authorization Code + PKCE)
where they pick a container, and your page gets the Connection back.

```typescript
// Starting the flow (any page of your site):
await client.connectInBrowser({ redirectUri: 'https://my-agent.example/callback' });
// or popup mode, which resolves in place:
const connection = await client.connectInBrowser({
  redirectUri: 'https://my-agent.example/callback',
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
myUi.show(`Code: ${pending.userCode}. Open ${pending.url}`);
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

## Bringing a manifest

An agent can do more than read and write a container. It may bring a
manifest: the kinds of records it keeps (declared objects), custom tools that
each wrap one Wire tool, and the agent's own HTTPS functions, called actions,
that a tool runs before or after its Wire tool. Connecting the agent installs
the manifest into the container the user picks, once they approve it on
Wire's consent screen. An install is the agent's manifest applied to one
container, and the agent then manages that container's tools and analysis.

Wire calls your actions. Your agent never calls the container for them, stores
no secret, and gets nothing at install time. Every call is signed with Wire's
own Ed25519 key, and you check it against Wire's published keys.

**[Build an agent that brings a manifest](https://docs.usewire.io/build/agents/end-to-end/)**
walks through a complete one, an agent that saves places with notes, visits
and events, from registration to shipping updates, with the reasons behind
each design choice. In short:

- Declare an object for each kind of record, and put values in typed fields.
- Save records under their common name, and take tags from the calling agent
  instead of fixing a constant tag.
- Connect records with `links` on `wire_write`, not ids in metadata, and
  delete a record with what belongs to it using `withLinked` on `wire_delete`.
- Store a repeating event as an RRULE, and answer "what's on" with a
  `wire_query` tool using `wire_rrule_occurs` and `wire_distance_km`.
- Map values whole (`'{{input.tags}}'`) so they keep their type and are left
  out when absent.
- Hide Wire's built-in tools with `builtin_tools`, and leave `analysis` out
  unless a tool needs a graph.
- Keep `instructions` short, and make the `skill` complete on its own.

The agent side lives on its own entry point, so agents that only connect never
load it:

```typescript
import { defineManifest, defineAction } from '@usewire/sdk/agent';
```

`@usewire/sdk/app` is the same entry under its pre-0.10 name and keeps
working.

### The manifest

A minimal manifest with one action and one tool. The action passes coordinates
through when the calling agent already has them, and geocodes only when it
doesn't:

```typescript
// manifest.ts
import { defineManifest } from '@usewire/sdk/agent';

export const manifest = defineManifest({
  manifest: 1,
  app: { id: 'place_keeper', name: 'Place Keeper', version: '1.0.0' },
  objects: [
    {
      name: 'place',
      geo: { lat: 'lat', lng: 'lng' },
      fields: [
        { name: 'name', type: 'text' },
        { name: 'address', type: 'text' },
        { name: 'lat', type: 'number' },
        { name: 'lng', type: 'number' },
      ],
    },
  ],
  actions: [
    {
      name: 'geocode',
      description:
        'Turns a street address into coordinates. Receives the address, and the coordinates when your agent already has them, in which case they are returned unchanged. Nothing is stored.',
      url: 'https://places.example.com/actions/geocode',
      input: {
        type: 'object',
        properties: { address: { type: 'string', minLength: 1 }, lat: { type: 'number' }, lng: { type: 'number' } },
        required: ['address'],
      },
      output: {
        type: 'object',
        properties: { address: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' } },
        required: ['address', 'lat', 'lng'],
      },
      timeout_ms: 5000,
    },
  ],
  tools: [
    {
      name: 'save_place',
      description: 'Save a place under the name people know it by. Pass lat and lng if you have them.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          address: { type: 'string' },
          lat: { type: 'number' },
          lng: { type: 'number' },
          tags: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 12 },
        },
        required: ['name', 'address'],
      },
      before: { action: 'geocode', args: { address: '{{input.address}}', lat: '{{input.lat}}', lng: '{{input.lng}}' } },
      tool: {
        name: 'wire_write',
        args: {
          content: '{{input.name}}, {{before.address}}',
          object: 'place',
          fields: { name: '{{input.name}}', address: '{{before.address}}', lat: '{{before.lat}}', lng: '{{before.lng}}' },
          tags: '{{input.tags}}',
        },
      },
    },
  ],
  builtin_tools: {
    wire_explore: { enabled: false },
    wire_navigate: { enabled: false },
    wire_search: { enabled: false },
    wire_write: { enabled: false },
    wire_delete: { enabled: false },
  },
});
```

- `app` is the manifest format's literal field name, and names your agent.
  `app.id` is the manifest id: the agent id you registered with Wire, with `-`
  as `_` (lowercase letters, digits and underscores). It is also the audience
  of every action call, so a call meant for another agent never verifies in
  yours.
- Every action needs a plain `description`. The user sees it on the consent
  screen, so say what the action receives and whether you keep it.
- `url` must be https on a public host. Wire calls exactly this URL and signs
  it into every call. `timeout_ms` defaults to, and is capped at, 8000.
- An action receives only the fields its tool's mapping sends it.
- `builtin_tools` sets each Wire built-in tool's visibility (`enabled`,
  `transports: { mcp, rest }`). A hidden built-in still runs under your own
  tools. `analysis: { entity?, provenance? }` turns analysis graphs on; left
  out, both are off, since an install sets both.
- `wire_write` takes `links: [{ to, type, properties? }]` and `wire_delete`
  takes `withLinked: { types, direction: 'incoming' }`. A link's `to` must come
  from a required input.

`defineManifest` runs Wire's own manifest validator, the same one Wire runs
when you register and a container runs when it installs your agent, so a
manifest that passes locally is one Wire accepts. It returns the normalized
manifest (defaults filled in) or throws `WireManifestError` listing every
problem with its path, such as `actions.0.url`. `validateManifest` is exported
too, for a CI check that returns errors instead of throwing.

The validator is a copy of Wire's, pinned to a Wire release. `MANIFEST_VALIDATOR_REF`
says which, and `registerManifest` sends it (`X-Wire-Manifest-Validator`), so Wire can tell you when your SDK
is behind.

### A skill and instructions for the agents that use it

A manifest can tell the agents that use a container your agent manages how to
use it, in two ways:

- **`instructions`**: sent as the MCP server instructions in the answer to
  `initialize`, so every client gets them when it connects, and most clients
  put them in front of the model. At most 16,000 characters. If you give a
  skill and no instructions, connecting clients get one line pointing at the
  skill instead.
- **`skill`**: a `SKILL.md` in the [Agent Skills](https://agentskills.io/specification)
  format, the full usage guide. At most 64,000 characters. When your agent is
  installed, the container serves it over MCP's Skills extension
  (`io.modelcontextprotocol/skills`) as `skill://<name>/SKILL.md`. Hosts that
  support Skills load it on demand, when it's relevant, and check it against
  the digest the container lists for it. Any client can also read it as a
  resource. Reading it is free: it costs the user no credits.

Write `instructions` as the few rules an agent must follow even if it never
opens the skill, and make the skill complete on its own. A host that loads the
skill may not show the instructions next to it, and a client that never loads
skills only has the instructions.

The frontmatter `name` is the skill's directory, and so part of its URI: a
skill named `place-keeper` is served as `skill://place-keeper/SKILL.md`. It must be 1 to
64 lowercase letters, digits and hyphens, with no leading, trailing or doubled
hyphen. Refer to the skill by that URI from `instructions`.

The user sees both on the consent screen and can read them in full before
approving. When they change:

- **Existing installs** start serving the skill and instructions of the
  version their user approved the next time the container opens, including
  installs made before Wire served skills. Nobody has to reconnect.
- **An update** ships the way every manifest change does: register it with a
  bumped `app.version`. The consent screen says the skill or instructions
  changed, and the new ones reach a container after its user approves the
  upgrade. Until then, the container keeps serving the version they approved.

```typescript
import { defineManifest, defineSkill } from '@usewire/sdk/agent';

const skill = defineSkill({
  name: 'place-keeper', // lowercase letters, digits and single hyphens; the skill's directory
  description: 'Save places the user wants to go. Use when the user mentions a place.',
  body: `# Place Keeper

1. Call \`search_places\` first, so you don't save a duplicate.
2. Call \`save_place\` with the street address.
`,
});

export const manifest = defineManifest({
  manifest: 1,
  app: { id: 'place_keeper', name: 'Place Keeper', version: '1.1.0' },
  // ...actions, tools
  instructions: 'Search before you save. Read skill://place-keeper/SKILL.md for the full guide.',
  skill,
});
```

The frontmatter takes these fields:

- `name` and `description`, both required. `description` is at most 1,024
  characters.
- `license` and `compatibility` (each at most 500 characters) and `metadata`
  (at most 64 string keys, each to a string value of at most 1,024
  characters), all optional.

Any other field is refused, and so is `allowed-tools`, because a skill a
container serves can't pre-approve tools on the user's machine.

Wire reads the frontmatter as a strict subset of YAML, so every client reads it
the same way:

- Write each field on one line, plain or quoted.
- Quote a value that would otherwise read as a number, a boolean or null, like
  `version: "1.0"`.
- Folded (`>`) and literal (`|`) blocks are refused.

`defineSkill` writes each value as a quoted string, so what it builds always
passes. Given a string instead, it checks a `SKILL.md` you wrote. It throws
`WireManifestError` with paths such as `skill.name`. `parseSkill` returns the
errors instead, for a CI check. `defineManifest` runs the same check on the
manifest's `skill`.

### Interactive views (MCP Apps)

A tool can render its result as an interactive view in clients that support
[MCP Apps](https://github.com/modelcontextprotocol/ext-apps)
(`io.modelcontextprotocol/ui`). The manifest carries each view as one HTML
document in `ui`, and a tool names the view that renders it:

```ts
import html from './ui/places-map.html'; // bundled as text
import csp from './ui/csp.json';

const manifest = defineManifest({
  manifest: 1,
  app: { id: 'someday', name: 'Someday', version: '1.1.0' },
  ui: [{ name: 'places-map', title: 'Places map', html, csp }],
  tools: [
    {
      name: 'search_places',
      // ...description, inputSchema, tool, result as before
      ui: { resource: 'places-map' },
    },
  ],
});
```

Wire serves the view at a hashed URI, `ui://<app id>/<name>-<hash>`, as
`text/html;profile=mcp-app` (`UI_MIME_TYPE`), with its CSP in `_meta.ui.csp`.
The hash is `uiResourceHash(html)`, the first 8 hex digits of the HTML's
SHA-256, and `uiUri(appId, name, hash)` builds the URI. A changed view is a new
URI, so a host that caches views never renders an old one after an upgrade.
The tool is listed with `_meta.ui.resourceUri` pointing at it. The host renders
the view in a sandboxed iframe and sends it the tool's input and result.

- **`html`** is the whole document, inline, at most 512 KB
  (`UI_HTML_MAX_BYTES`). All views together may hold 1 MB, and a manifest may
  have up to 8. The HTML is part of what the user approves at consent, so load
  heavy libraries from a CDN rather than inlining them.
- **`csp`** lists every origin the view may reach: `connectDomains` (fetch,
  XHR, WebSocket), `resourceDomains` (scripts, styles, images, fonts),
  `frameDomains` and `baseUriDomains`. Each entry is an https origin
  (`https://host[:port]`, at most one leading `*.`), never Wire's own domain.
  `uiDomainProblem(origin)` applies the same rule. `blob:` and `data:` can't be
  declared. Many hosts don't allow `blob:` workers, so a library that starts
  one needs a fallback.
- **`permissions`** requests `camera`, `microphone`, `geolocation` or
  `clipboardWrite`, each as `{}`. **`prefersBorder`** asks the host for a
  border.
- A tool's **`ui.visibility`** says who may call it: `['model']`, `['app']` (the
  view only), or both (the default).
- A client without MCP Apps shows only the tool's normal result. Keep that
  result complete on its own.
- **View-only data.** A top-level `_meta` in a tool's `result` mapping
  (`VIEW_META_KEY`) goes to the MCP result's `_meta.view`, never into
  `structuredContent` or `content`. The view reads it and the model never sees
  it. Use it for a heading, a map center, display hints.
- **Split finding from showing.** Give the search tool no view, and add a small
  render tool that takes the ids the model picked. The model reads the results
  first, and the user gets one map of what matters, not one per search.

[`examples/places-map-ui`](examples/places-map-ui) is a complete view built
with Vite, mapcn and the ext-apps SDK: a single ~340 KB HTML file, its
`csp.json`, and a local MCP server to test it in the ext-apps basic-host. Its
`manifest-snippet.ts` has a `render_places_map` tool over `wire_query` that
binds a list of ids as one JSON param.

### Tool annotations and output schemas

Every tool is listed with MCP annotations (`readOnlyHint`, `destructiveHint`,
`openWorldHint`, `title`). Hosts use them to decide when to ask the user
before a call. A custom tool inherits its base tool's hints, and
`openWorldHint` becomes true when it calls one of your actions.
`annotations` overrides them, **but only toward caution**:

- `readOnlyHint: true` is refused on a tool that writes.
- `destructiveHint: false` is refused on one that deletes.
- Declaring a read-only tool not read-only, or any tool open-world, is fine.
- `title` is always allowed (at most 120 characters).

```ts
{ name: 'forget_place', /* ...wire_delete... */ annotations: { title: 'Forget a place' } }
```

`outputSchema` declares the JSON Schema of the tool's result data. It is
checked on every call and listed on the tool. Without one, a tool that passes
its base tool's result through unchanged (no `result` mapping, no action)
inherits the base tool's schema.

### Register it

Registration is signed with one of your agent's **publisher keys**, an Ed25519
key you add to the agent. An install's device key cannot register a manifest,
since anyone can create one for any agent id.

**1. Create a publisher key.** Generate a keypair and keep the private half
secret, as you would any deploy credential. `generateRuntimeKey()` makes a plain
Ed25519 key pair, the same kind for both of your agent's keys:

```typescript
import { generateRuntimeKey } from '@usewire/sdk/agent';

const { privateJwk, publicKey } = await generateRuntimeKey();
// Store JSON.stringify(privateJwk) in your CI secrets. publicKey is 43 characters of base64url.
```

Then add the public half to the agent. This needs a signed-in owner of the
agent's organization (`organization: update`):

```http
POST https://app.usewire.io/api/v1/agents/<agent id>/publisher-keys
Content-Type: application/json

{ "publicKey": "<publicKey>", "label": "CI deploy key" }
```

The answer's `id` is the key id (`pk_…`). `GET` on the same path lists the agent's
publisher keys, and `DELETE …/publisher-keys/<id>` revokes one.

**2. Register.** Pass the publisher key as the client's `deviceKey`, with its
`pk_…` id as `credentialId`:

```typescript
import { WireClient } from '@usewire/sdk';
import { manifest } from './manifest';

const client = new WireClient({
  agentId: 'place-keeper',
  deviceKey: { privateJwk, publicKey, credentialId: 'pk_…' },
});
const registered = await client.registerManifest(manifest);
// { agentId, appId, version, hash, status: 'created' | 'updated' | 'unchanged', tools, baseTools, actions }
```

`manifest.app.id` must be your agent id with `-` changed to `_` (agent
`place-keeper`, manifest id `place_keeper`), because manifest ids become
tool-name prefixes. `registered.agentId` is the agent id and `registered.appId` the
manifest id.

Registering an identical document again answers `unchanged`, so it is safe
to run on every deploy. Bump `app.version` to ship a change. Registering never
changes anyone's container: each user approves the new version in Wire (see
[Look up installs from your server](#look-up-installs-from-your-server)). Errors throw `WireSdkError`:

| Status | Code | Meaning |
|---|---|---|
| 422 | `INVALID_MANIFEST` | `details.errors` lists each problem with its path |
| 409 | `VERSION_EXISTS` | this `app.version` is already registered with different content |
| 503 | `UNAVAILABLE` | Wire could not read or store the manifest; try again |
| 401 | | the key is not a live publisher key of this agent (a runtime key is refused) |

### Serve an action (Cloudflare Worker)

`defineAction` returns a complete endpoint. It verifies the call (401), checks
the input against the action's `input` schema (400), runs your handler,
checks what you return against the `output` schema (500), and answers JSON.
It also answers before Wire's timeout would fire (504), and aborts
`ctx.signal` when time is up.

```typescript
// worker.ts
import { defineAction, WireActionError } from '@usewire/sdk/agent';
import { manifest } from './manifest';

const geocode = defineAction<
  { address: string; lat?: number; lng?: number },
  { address: string; lat: number; lng: number }
>(manifest, 'geocode', async ({ address, lat, lng }, ctx) => {
  // The calling agent already had coordinates: return them, look nothing up.
  if (lat !== undefined && lng !== undefined) return { address, lat, lng };
  const res = await fetch(`https://geocoder.example/search?q=${encodeURIComponent(address)}`, {
    signal: ctx.signal,
  });
  const [hit] = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  if (!hit) throw new WireActionError('NOT_FOUND', 'No match for that address', 404);
  return { address: hit.display_name, lat: Number(hit.lat), lng: Number(hit.lon) };
});

export default {
  fetch(request: Request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/actions/geocode') return geocode.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
```

`ctx` carries `connectionId`, `containerId`, `action`, the verified `claims`,
and `signal`. Throw `WireActionError` for an error the agent should see.
Anything else thrown becomes a generic 500, so internals never reach the agent.

**Hono:** `app.post('/actions/geocode', geocode.hono)`.
**Node:** `http.createServer(toNodeHandler(geocode, { origin: 'https://places.example.com' }))`,
or `app.post('/actions/geocode', toNodeHandler(geocode, { origin }))` in Express. Mount
it before any JSON body parser: the signature covers the raw body bytes, and a
parsed and re-serialized body does not hash the same.

**The URL check.** Every call is signed with the exact URL Wire sent it to
(`wire_url`, your manifest's action `url`), and it is refused at any other.
By default the SDK compares it with the URL the request arrived at. That is
right for a Worker, Bun or Deno serving the public hostname. Behind a proxy,
load balancer or TLS terminator that changes the scheme, host, port or path
your code sees, pass the public URL instead: `url` on `defineAction` or
`verifyWireAction`, or `origin` on `toNodeHandler`. Forwarded headers are not
trusted for this, since anyone can send them.

Both URLs are parsed and compared as `scheme://host[:port]/path?query`: the
scheme and host are case-insensitive, a default port (443, 80) is dropped, `.`
and `..` segments are resolved and the fragment is ignored. Everything else
counts, including the case of the path, a trailing slash, percent-encoding and
the order of the query. `normalizeActionUrl` is the exact rule.

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
`action` is required, so a call Wire made to another of your actions never
verifies here.

```typescript
import { verifyWireAction, WireActionAuthError } from '@usewire/sdk/agent';

try {
  const { connectionId, containerId, action } = await verifyWireAction(request, {
    agentId: 'place-keeper', // Wire signs for the manifest id, place_keeper
    action: 'geocode',
    // url: 'https://places.example.com/actions/geocode', // behind a proxy
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
process. **If your agent runs more than one instance, pass a shared store**:
every Cloudflare Worker under real traffic runs many isolates, and a captured
call could otherwise be replayed once against each of them within its 60
seconds.

The store must be atomic: record the key and report whether it was new in one
step. Workers KV is eventually consistent and is not suitable. Redis `SET NX`,
a Durable Object, or a unique-key insert are.

```typescript
import type { ReplayStore } from '@usewire/sdk/agent';

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
   `https://app.usewire.io/.well-known/wire-actions-jwks.json` (preview:
   `https://preview.app.usewire.io/.well-known/wire-actions-jwks.json`). Cache it for up
   to 5 minutes; refetch on an unknown `kid`, at most every 30 seconds. Never
   take a key or a key URL from the token itself.
4. Check the claims:

   | Claim | Check |
   |---|---|
   | `iss` | exactly `"wire"` |
   | `aud` | exactly your manifest id, `app.id` (a single string) |
   | `sub` | the connection id |
   | `wire_container` | the container the call comes from |
   | `wire_action` | the action this endpoint serves |
   | `wire_url` | the public URL of this endpoint (compare normalized, as above) |
   | `iat`, `exp` | not expired, not issued in the future (allow up to 30 s of skew), `exp - iat <= 60` |
   | `jti` | not seen before; remember it until `exp` plus the skew has passed |
   | `wire_body_sha256` | base64url (no padding) SHA-256 of the raw request body bytes |

   `X-Wire-Request-Id` names the tool call the action is part of. It is not
   signed, so use it only to correlate logs.

5. Hash the body exactly as received, before any parsing, and compare.

```typescript
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://app.usewire.io/.well-known/wire-actions-jwks.json'));

async function verify(request: Request, manifestId: string, action: string, publicUrl: string) {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const { payload } = await jwtVerify(token, JWKS, {
    algorithms: ['EdDSA'],
    typ: 'wire-action+jwt',
    issuer: 'wire',
    audience: manifestId,
    clockTolerance: 30,
    maxTokenAge: 90,
    requiredClaims: ['sub', 'jti', 'iat', 'exp', 'wire_container', 'wire_action', 'wire_url', 'wire_body_sha256'],
  });
  if (payload.aud !== manifestId || payload.exp! - payload.iat! > 60) throw new Error('bad token');
  if (payload.wire_action !== action) throw new Error('token is for another action');
  const norm = (u: string) => { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname}${x.search}`; };
  if (norm(payload.wire_url as string) !== norm(publicUrl)) throw new Error('token is for another URL');

  const body = new Uint8Array(await request.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  const hash = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (hash !== payload.wire_body_sha256) throw new Error('body does not match');

  // Then: record payload.jti in a shared store and refuse if it was already there.
  return { payload, body };
}
```

### Look up installs from your server

To show "connected to Places, manage it in Wire" on a later visit, your agent
does not need to keep anyone's API key. Keep the two ids every connect returns,
and ask Wire about them from your server:

| Id | One per | Notes |
|---|---|---|
| `installId` (`ins_…`) | agent, user and container | Survives a reconnect of the same user to the same container |
| `agentUserId` (`au_…`) | agent and user | Pairwise: another agent gets a different id for the same person, and it never reveals their Wire account. Null on an unclaimed trial, set when it is claimed |

A typical pattern: when the connect completes, store `agentUserId` on your user
(and `installId` if your agent uses one container per user). Throw the API key
away if your agent does not call the container itself. When you render a
settings or manage page, list that user's installs.

Your server authenticates with a **runtime key**, an Ed25519 key registered for
your agent with `purpose: "runtime"`. It is separate from the publisher key that
registers your manifest, and neither is accepted in place of the other: the key
a live server holds can read and uninstall your own agent's installs and nothing
else. Generate one and register its public half:

```typescript
import { generateRuntimeKey } from '@usewire/sdk/agent';

const { privateJwk, publicKey } = await generateRuntimeKey();
// Keep JSON.stringify(privateJwk) as a server secret. Register publicKey:
```

```bash
curl -X POST https://app.usewire.io/api/v1/agents/place-keeper/publisher-keys \
  -H 'content-type: application/json' --cookie "$WIRE_SESSION" \
  -d '{ "publicKey": "<publicKey>", "label": "production server", "purpose": "runtime" }'
# → { "success": true, "data": { "id": "pk_…", "purpose": "runtime" } }
```

The caller needs `organization: update` on your agent's owner org. The answer's
`id` is the key id. Revoke a key with
`DELETE /api/v1/agents/{agentId}/publisher-keys/{keyId}`.

Then, in a Worker (or Node 18+, Bun, Deno):

```typescript
import { WireAgentClient } from '@usewire/sdk/agent';

const wire = new WireAgentClient({
  agentId: 'place-keeper',
  runtimeKey: { privateJwk: env.WIRE_RUNTIME_KEY, keyId: env.WIRE_RUNTIME_KEY_ID },
  // baseUrl: 'https://preview.app.usewire.io',
});

const installs = await wire.listInstalls(user.wireAgentUserId); // [] if none
for (const i of installs) {
  i.container.name;          // "Places" (null once the container is deleted)
  i.connection.status;       // "active" | "revoked"
  i.connection.reason;       // when revoked: user_disconnected | agent_disconnected | uninstalled | container_deleted | expired
  i.connection.lastUsedAt;   // Date | null
  i.manageUrl;               // link to the container's installed agents in Wire
  i.installedVersion;        // "0.1.0": your manifest version the container runs (string | null)
  i.latestVersion;           // "0.3.0": the version you have registered with Wire (string | null)
  i.updateAvailable;         // true when an active install runs an older version than latestVersion
  i.upgradeUrl;              // only when updateAvailable: where the user reviews the update in Wire
}

const one = await wire.getInstall(user.wireInstallId); // null if your agent has no such install
await wire.revokeInstall(user.wireInstallId);         // uninstall; resolves with the install, now revoked
```

**Updates.** Registering a new version of your manifest never updates anyone's
container: each user approves the update in Wire. `upgradeUrl` takes them to
Wire's review screen for that install (they sign in if needed), where they
approve or decline it; nothing about the approval happens on your site. To offer
it on your own page:

```typescript
const install = await wire.getInstall(user.wireInstallId);
if (install) {
  const line = [`Connected to ${install.container.name ?? 'a deleted container'}`];
  if (install.installedVersion) line.push(`Place Keeper ${install.installedVersion}`);
  // render line.join(' · '), then, when an update exists, a link:
  if (install.updateAvailable && install.upgradeUrl) {
    // <a href={install.upgradeUrl}>Update to {install.latestVersion}</a>
  }
}
// "Connected to Places · Place Keeper 0.1.0 · Update to 0.3.0"
```

`installedVersion` is null when your agent has no manifest, the install is no
longer installed, or Wire cannot tell which version the container runs, so do
not assume it is set. `latestVersion` is null when your agent has no manifest.
Against an older Wire that does not send these fields, the SDK reads
`installedVersion` and `latestVersion` as null, `updateAvailable` as false, and
leaves `upgradeUrl` out.

| Method | Wire endpoint | Returns |
|---|---|---|
| `getInstall(installId)` | `GET /api/v1/agents/{agentId}/installs/{installId}` | `WireInstall`, or `null` for an install your agent does not have |
| `listInstalls(agentUserId)` | `GET /api/v1/agents/{agentId}/users/{agentUserId}/installs` | `WireInstall[]`, newest first; `[]` for a user your agent does not know |
| `revokeInstall(installId)` | `DELETE /api/v1/agents/{agentId}/installs/{installId}` | `WireInstall` (revoked, `uninstalled`) |

An agent only ever sees its own installs: another agent's ids answer as if they did
not exist. A revoked install stays readable, with `connection.status:
"revoked"` and a `reason`. The install never includes an API key, the
container's contents, the user's Wire account id, or their email.

`revokeInstall` does what the container owner's **Uninstall** button does: your
agent's connections to that container end (every user's, since uninstalling is
per container), Wire's built-in tools and the analysis graphs go back to their
defaults, and the data stays. Disconnecting without uninstalling stays a
dashboard action.

Each call signs a fresh token (`iss` your agent id, `aud: "wire-agent-api"`, a
60-second lifetime, a single-use `jti`, and on `DELETE` a `body_sha256` of the
empty body). Before 0.10 the client called `/api/v1/apps/{appId}/...` with
`aud: "wire-app-api"`; Wire still answers those, marked deprecated, and
`new WireAgentClient({ ..., apiVersion: 'apps' })` selects them for a Wire
deployment that predates the agent paths. Failures throw `WireAgentApiError`,
a `WireSdkError` with Wire's `code`, the HTTP `status`, and `retryable`:

| `code` | `status` | Meaning |
|---|---|---|
| `UNAUTHORIZED`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `REPLAY_DETECTED`, `CREDENTIAL_REVOKED`, `RUNTIME_KEY_REQUIRED`, `UNKNOWN_AGENT` | 401 | The key or token was refused (a publish key, a revoked key, a clock more than a minute off) |
| `AGENT_DISABLED` | 403 | Your agent is disabled |
| `NOT_FOUND` | 404 | `revokeInstall` of an install your agent does not have, or whose container is gone |
| `CONTAINER_UNAVAILABLE` | 502 | `revokeInstall`: the connections ended but the container could not finish the uninstall yet. `retryable`: call it again |
| `UNAVAILABLE` | 503 | Wire could not answer. `retryable` |
| `NETWORK_ERROR`, `HTTP_<status>` | | No answer, or not Wire's. `retryable` for network errors, 429, 502, 503 and 504 |

### Webhooks

Wire can POST a signed event to your server whenever one of your installs
changes, so your records stay right between visits. Register the URL and the
events on your agent record (same permission as adding a key):

```bash
curl -X PATCH https://app.usewire.io/api/v1/agents/place-keeper \
  -H 'content-type: application/json' --cookie "$WIRE_SESSION" \
  -d '{ "webhooks": { "url": "https://places.example.com/webhooks/wire", "events": ["install.created", "install.uninstalled", "install.disconnected", "install.claimed", "install.expiring"] } }'
```

The URL follows the action URL rules: https only, no credentials, no private
address, not a Wire domain. `"webhooks": null` stops them.

| Event | Sent when |
|---|---|
| `install.created` | A connect made the install active: the first connect, or a reconnect after it was revoked |
| `install.upgraded` | An active install was updated to a newer version of your manifest. The user approved it in Wire, either through your connect flow or from Wire's dashboard (for example after following `upgradeUrl`) |
| `install.disconnected` | The install's last live connection ended (the user disconnected, or you rotated your agent's credentials) |
| `install.uninstalled` | Your agent was uninstalled from the container, by its owner or by your `revokeInstall` |
| `install.claimed` | The install's trial container was claimed; `install.agentUserId` is now set |
| `install.expiring` | About a day before a trial container expires, once |
| `install.expired` | A trial container expired and is being deleted |
| `install.container_deleted` | The container was permanently deleted |

The body is `{ id, type, createdAt, install }`, where `install` is the same
`WireInstall` the agent API returns, as it was when the event happened. While
older SDKs are still in use, Wire sends the pairwise id as both `agentUserId`
and the deprecated `appUserId`; the SDK reads either.

`defineWebhook` returns a complete endpoint. It verifies the request, answers
`200` once your handler returns, and dispatches by event type:

```typescript
// worker.ts
import { defineWebhook } from '@usewire/sdk/agent';

const webhook = defineWebhook(
  {
    'install.created': async (event) => {
      await db.upsertInstall(event.install.installId, event.install.agentUserId, event.install.container.name);
    },
    'install.uninstalled': async (event) => {
      await db.markRemoved(event.install.installId);
    },
    'install.claimed': async (event) => {
      await db.setAgentUserId(event.install.installId, event.install.agentUserId);
    },
    default: (event) => console.log('unhandled', event.type, event.id),
  },
  {
    agentId: 'place-keeper',
    // url: 'https://places.example.com/webhooks/wire', // behind a proxy: the registered URL
    replayStore, // durable and shared in production: see below
  }
);

export default {
  fetch(request: Request) {
    if (new URL(request.url).pathname === '/webhooks/wire') return webhook.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
```

Or one function for every event: `defineWebhook((event, ctx) => { ... }, opts)`.
**Hono:** `app.post('/webhooks/wire', webhook.hono)`. **Node:**
`toNodeHandler(webhook, { origin: 'https://places.example.com' })`, mounted before
any JSON body parser.

How it answers, and what Wire does with it:

| Answer | When | Wire |
|---|---|---|
| `200 { received: true }` | Your handler returned | Done |
| `200 { received: true, duplicate: true }` | An event id already received | Done (your handler is not called again) |
| `200 { received: true, ignored: true }` | No handler for the type and no `default` | Done |
| `401` / `413` | Not a genuine Wire webhook | Retries, which fail the same way |
| `500` | Your handler threw | Retries; the event is released, so the retry runs your handler |
| `503` | Wire's keys or your replay store could not be reached | Retries |
| Your `Response` | The handler returned one | A non-2xx is retried; **`410 Gone` stops retries of that event at once** |

Wire retries anything but a 2xx for about 24 hours: each round is one attempt
and one quick retry, and the waits between rounds grow from 1 minute to 8
hours. It never follows a redirect and waits 8 seconds for an answer, so
acknowledge quickly and do slow work in the background (a queue, or
`ctx.waitUntil` in a Worker).

**Duplicates.** Delivery is at least once, and an event keeps its `id` on every
retry. The SDK records each event id in the replay store before your handler
runs, and answers a repeat with 200 without calling the handler again. The
default store is in memory, per instance, and forgets on restart, so **in
production pass a durable, shared store** that implements `release` (called
when your handler fails, so the retry is handled):

```typescript
const replayStore: ReplayStore = {
  async markUsed(key, ttlSeconds) {
    return (await redis.set(`wire:${key}`, '1', { NX: true, EX: ttlSeconds })) === 'OK';
  },
  async release(key) {
    await redis.del(`wire:${key}`);
  },
};
```

Event ids are kept for 7 days (`dedupeTtlSec`). Or pass `dedupe: false` and
dedupe on `event.id` yourself, for example with a unique key in the same
database transaction as the work.

To verify inside a server you already have, call the check on its own. It takes
a Fetch `Request` or the raw parts:

```typescript
import { verifyWireWebhook, WireWebhookError } from '@usewire/sdk/agent';

try {
  const { event, release } = await verifyWireWebhook(request, { agentId: 'place-keeper', replayStore });
  // or: verifyWireWebhook({ headers: req.headers, rawBody, url: req.url }, { agentId, origin: 'https://places.example.com' })
  try {
    await handle(event);
  } catch {
    await release(); // so Wire's retry is handled
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 200 });
} catch (err) {
  // DUPLICATE_EVENT has status 200: acknowledge it.
  if (err instanceof WireWebhookError) return new Response(err.code, { status: err.status });
  throw err;
}
```

What the verifier checks, for anyone verifying without the SDK:

1. `Authorization: Bearer <jwt>` with header `alg: "EdDSA"`,
   `typ: "wire-webhook+jwt"` (an action token is not a webhook) and a `kid`,
   signed by a key in the same JWKS as action calls,
   `https://app.usewire.io/.well-known/wire-actions-jwks.json`.
2. `iss` is `"wire"`, `aud` is your agent id, `exp - iat <= 60`
   and not expired (30 s of skew).
3. `wire_url` is your registered webhook URL (normalized as for actions).
4. `wire_body_sha256` is the base64url SHA-256 of the raw body, checked before
   parsing.
5. `wire_event` equals the `X-Wire-Event-Id` header and the body's `id`.
6. `jti` is single use; the event `id` is deduplicated.

### Trials

A trial is a connect by someone with no Wire account: an ephemeral container
that lasts 7 days, with the same tools and endpoint. Its install has an
`installId` right away and `agentUserId: null`, and reads
`container.isEphemeral: true`, `container.ephemeralExpiresAt` and
`claimed: false`.

While the trial is active, the install also carries `claimUrl`, where the
person creates an account and keeps the container. It is not a credential and
works until the trial expires, so it can go in an email; it stops working if
your agent is disconnected or uninstalled first. Since a trial has no
`agentUserId`, keep its `installId` (for example in the user's session or your
own record of them) to look it up.

An agent offering trials usually subscribes to two events:

- **`install.expiring`**, about a day before the container goes: remind the
  person, with `event.install.claimUrl`.
- **`install.claimed`**, when they keep it: `event.install.agentUserId` is now
  set. Store it on your user, as after a normal connect.

If they do not claim it, `install.expired` follows, and the container and its
data are deleted. After `install.expired` and `install.container_deleted`,
`getInstall` answers `null`.

## Runtime

Node 18+, Cloudflare Workers, Deno, Bun. `connect()` needs to drive the
user's browser; browser-only environments work for `getStatus`, `claim`, and
`disconnect`. `@usewire/sdk/agent` runs anywhere with `fetch` and Web Crypto,
and imports nothing Node-specific.

## Errors

Rejected promises throw `WireSdkError` with a `code` and HTTP `status` when
applicable. On `@usewire/sdk/agent`, a failed verification throws
`WireActionAuthError` (`code`, and `status`: 401, 413, or 503 when your agent
could not check), and `defineManifest` throws `WireManifestError` with
`issues`. `WireAgentClient` throws `WireAgentApiError` (a `WireSdkError` with
`retryable`), and `verifyWireWebhook` throws `WireWebhookError`, whose `status`
is what to answer with (200 for `DUPLICATE_EVENT`).

### Agent-managed containers

Installing an agent's manifest on a container hands the container's tools and
analysis to the manifest until the agent is uninstalled. Changing what the
manifest owns (a tool's visibility, a custom tool, an API key's own tool list,
the analysis switches) is refused with HTTP 409 and the code
`container_agent_managed`, naming the agent in `managedBy`. Wire used the code
`container_app_managed` and `managedBy.appId` before 0.10; these helpers accept
both:

```typescript
import { isAgentManagedError, managedByFromError } from '@usewire/sdk';

try {
  await doSomething();
} catch (err) {
  if (isAgentManagedError(err)) {
    const by = managedByFromError(err); // { agentId, name, version, status, installer } | null
    console.log(`Tools are set by ${by?.name ?? 'an agent'}`);
  }
}
```

## Migrating to 0.10

0.10.0 finishes the move from "app" to "agent": an SDK-built agent may bring a
manifest, and installing it on a container is an install. Every old name keeps
working and is marked deprecated, so nothing breaks on upgrade.

| 0.9.x (deprecated, still works) | 0.10.0 |
|---|---|
| `@usewire/sdk/app` | `@usewire/sdk/agent` (the same module) |
| `WireAppClient`, `WireAppClientOptions` | `WireAgentClient`, `WireAgentClientOptions` |
| `new WireAppClient({ appId })` | `new WireAgentClient({ agentId })` |
| `client.appId` | `client.agentId` |
| `listInstalls(appUserId)` | `listInstalls(agentUserId)` |
| `WireAppApiError` | `WireAgentApiError` |
| `APP_API_AUDIENCE` (`wire-app-api`) | `AGENT_API_AUDIENCE` (`wire-agent-api`) |
| `APP_API_TOKEN_LIFETIME_SEC`, `APP_API_BODY_HASH_CLAIM` | `AGENT_API_TOKEN_LIFETIME_SEC`, `AGENT_API_BODY_HASH_CLAIM` |
| `install.appUserId`, `connection.appUserId` | `install.agentUserId`, `connection.agentUserId` |
| reason `app_disconnected` | reason `agent_disconnected` (an older server's value is mapped) |
| `verifyWireAction` / `defineAction` / `verifyWireWebhook` / `defineWebhook` `{ appId }` | `{ agentId }` |

The client now calls `/api/v1/agents/{agentId}/...` with
`aud: "wire-agent-api"`. Pass `apiVersion: 'apps'` for a Wire deployment that
has not shipped the agent paths yet.

## License

MIT.
