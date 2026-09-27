# Changelog

## 0.9.0

Know your installs without holding a key (SUP-958).

- Connection results carry the install's stable, non-secret ids: `installId`
  (`ins_…`, one per app, user and container) and `appUserId` (`au_…`, pairwise
  per app and user, null on an unclaimed trial). On `connect`,
  `checkConnection`, `connectInBrowser` / `completeConnectInBrowser`, and on
  `getStatus().connection`. Null from an older server.
- `WireAppClient` in `@usewire/sdk/app`: `getInstall(installId)`,
  `listInstalls(appUserId)` and `revokeInstall(installId)` (uninstalls), signed
  with the app's runtime key (a fresh 60-second EdDSA JWT per call,
  `aud: "wire-app-api"`, `body_sha256` on DELETE). Returns typed `WireInstall`
  objects: container name, status and reason, last use, `manageUrl`, and for a
  trial `isEphemeral`, `ephemeralExpiresAt` and `claimUrl`. Failures throw
  `WireAppApiError` with `code`, `status` and `retryable` (network errors, 429,
  502, 503, 504).
- `generateRuntimeKey()`: the Ed25519 key `WireAppClient` signs with. Register
  its public half with `purpose: "runtime"` on
  `POST /api/v1/agents/{appId}/publisher-keys`.
- `verifyWireWebhook` and `defineWebhook` (Hono and Node adapters) for install
  webhooks: `install.created`, `.upgraded`, `.disconnected`, `.uninstalled`,
  `.claimed`, `.expiring`, `.expired`, `.container_deleted`. Verified against
  the same JWKS as action calls, pinned to `typ: "wire-webhook+jwt"`,
  `iss: "wire"`, your app id and your webhook URL, with the body hash checked
  before parsing and the event id bound to the `X-Wire-Event-Id` header and the
  body. Each event id is deduplicated through the replay store (a repeat
  answers 200 without running the handler; a handler failure releases it so
  Wire's retry runs). `WireWebhookError.status` is what to answer with.
- `ReplayStore` gains an optional `release(key)`, which `MemoryReplayStore`
  implements.

## 0.8.1

- Vendors the manifest validator at usewire/wire@429678f (SUP-957): a manifest can set
  `builtin_tools` to show or hide Wire's built-in tools (`wire_explore`, `wire_navigate`,
  `wire_search`, `wire_write`, `wire_delete`, `wire_query`, `wire_status`, `wire_export`),
  with the same `enabled` / `transports` shape as app tools. Installing an app makes the
  container app-managed: the manifest sets its tools and analysis, one app per container.
- Connect action calls are free; a tool call costs what its base tool costs.

## 0.8.0

- `@usewire/sdk/app`, a separate entry point for Connect apps (SUP-946):
  `defineManifest`, `defineAction` (with Hono and Node adapters),
  `verifyWireAction` (requires `appId` and `action`), `MemoryReplayStore`. Verifies Wire's Ed25519-signed
  action calls against Wire's JWKS. The root entry does not import it.
- `WireClient.registerManifest()` registers a Connect app manifest, signed
  with the agent's key and bound to the request body.
- `defineManifest` and action input/output validation run Wire's own manifest
  validator, vendored from usewire/wire at the commit in `MANIFEST_REF`
  (`scripts/vendor-manifest.sh`; CI fails if the copy drifts). `registerManifest`
  sends that commit in the `X-Wire-Manifest-Validator` header, and signs with
  `aud: "wire-manifest"` and a publisher key.
- Action calls are bound to their URL (`wire_url`), checked against the request
  URL or an explicit `url` / `origin` behind a proxy.
- Manifest v2 fields (SUP-954), from the validator at usewire/wire@52b46d7:
  `tools[i].enabled` and `tools[i].transports` (`{ mcp, rest }`, each defaulting
  to true) set an app tool's visibility on install, whatever it was before; a
  top-level `analysis: { provenance, entity }` asks Wire to turn those analysis
  graphs on for the container (each defaults to false; each costs 1 credit per
  entry written, and installing an app that asks for one needs an org owner or
  admin).

## 0.7.0

- Removed case containers (the `container.case(id)` / `container.cases` surface on
  `WireProvisionClient`, along with `WireCase`, `ProvisionedContainerHandle`,
  `CaseSummary`, `CaseListResult`, and `CaseToolResult`). The surface had zero
  production usage. If you need per-matter isolation, create separate containers
  and share them with grants. Provision mode itself is unchanged:
  `containers.create` / `list` / `update` / `delete` and `whoami` all work as before;
  container methods now return plain `ProvisionedContainer` objects again.

## 0.6.0

- Case surface on `WireProvisionClient` (removed in 0.7.0).
- `baseUrl` option on `WireClient` — parity with `WireProvisionClient`.

## 0.5.0

- `WireProvisionClient` — provision-mode container management.

## 0.4.0

- `connectInBrowser` — browser-native connect via OAuth Auth Code + PKCE.

## 0.3.0

- `WireClient.claim()` — ephemeral container claim flow.

## 0.2.0

- Renamed `appId` to `agentId` across the SDK surface.

Releases before 0.2.0 predate this changelog.
