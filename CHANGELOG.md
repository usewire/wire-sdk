# Changelog

## 0.12.0

Agent links. A manifest's tools can now connect the records they write, and
delete a record together with the records linked to it.

- Vendors the manifest validator at usewire/wire@f8b83f7 (the engine PR's head;
  re-pin to the merged commit before release). `defineManifest` accepts two new
  base-tool arguments and checks them like any other:
  - `wire_write` `links`: `[{ to, type, properties? }]`, for example
    `links: [{ to: '{{input.place_id}}', type: 'about' }]`. `to` is required,
    so an input it comes from must be required in the tool's `inputSchema`.
  - `wire_delete` `withLinked`: `{ types, direction: 'incoming' }`, for example
    `withLinked: { types: ['about'], direction: 'incoming' }` to delete a place
    and the notes about it.

## 0.11.0

Agent skills (SUP-962). A manifest's `skill` and `instructions` now reach the
agents that use a container your agent manages: the container serves the skill
over MCP's Skills extension as `skill://<name>/SKILL.md`, and sends
`instructions` as the MCP server instructions.

- `defineSkill({ name, description, license?, compatibility?, metadata?, body })`
  writes a `SKILL.md` whose frontmatter Wire always accepts (every value
  quoted), and `defineSkill(text)` checks one you wrote. Both throw
  `WireManifestError` with paths like `skill.name`.
- `skillFrontmatter(text)` returns the frontmatter as a host reads it.
  `parseSkill` (Wire's own reader), `skillUri`, `SkillFrontmatter`,
  `SkillInput` and the limits (`SKILL_MAX`, `INSTRUCTIONS_MAX`,
  `SKILL_NAME_MAX`, `SKILL_DESCRIPTION_MAX`, ...) are exported from
  `@usewire/sdk/agent`.
- Vendors the manifest validator at usewire/wire@c1aa2a6, the engine release
  that serves skills. `defineManifest` now refuses a `skill` that is not a
  valid Agent Skills `SKILL.md`:
  - `name` and `description` are required;
  - `license`, `compatibility` and `metadata` are optional;
  - unknown fields and `allowed-tools` are refused;
  - the frontmatter is a strict YAML subset.

## 0.10.0

"App" becomes "agent" (SUP-948). There are no apps: an SDK-built agent may
bring a manifest, and installing it on a container is an install. Every
pre-0.10 name keeps working and is marked `@deprecated`, so upgrading breaks
nothing.

- New entry point `@usewire/sdk/agent`. `@usewire/sdk/app` is the same module
  and keeps working.
- `WireAgentClient` replaces `WireAppClient` (deprecated alias, the same
  class). It takes `{ agentId }` (`appId` still accepted), exposes
  `client.agentId` (`client.appId` is a deprecated getter), and
  `listInstalls(agentUserId)`. It now calls
  `/api/v1/agents/{agentId}/installs/{installId}`,
  `/api/v1/agents/{agentId}/users/{agentUserId}/installs` and
  `DELETE /api/v1/agents/{agentId}/installs/{installId}`, signing
  `aud: "wire-agent-api"`. `apiVersion: 'apps'` selects the deprecated
  `/api/v1/apps/...` paths and `aud: "wire-app-api"`, for a Wire deployment that
  has not shipped the agent paths yet.
- Renamed with deprecated aliases: `WireAppApiError` -> `WireAgentApiError`,
  `APP_API_AUDIENCE` -> `AGENT_API_AUDIENCE` (the old constant keeps its value,
  `wire-app-api`), `APP_API_TOKEN_LIFETIME_SEC` -> `AGENT_API_TOKEN_LIFETIME_SEC`,
  `APP_API_BODY_HASH_CLAIM` -> `AGENT_API_BODY_HASH_CLAIM`,
  `WireAppClientOptions` -> `WireAgentClientOptions`.
- `WireInstall.agentUserId`, `Connection.agentUserId` and
  `StatusSnapshot.connection.agentUserId` carry the pairwise user id
  (`au_…`, unchanged). `appUserId` stays on each as a deprecated copy of the
  same value. The SDK reads Wire's `agentUserId` / `agent_user_id` and falls
  back to `appUserId` / `app_user_id`, and reads `agent_id` / `agent` before
  `app_id` / `app`, so it works against a server from before or after the
  rename.
- The revocation reason `app_disconnected` is now `agent_disconnected`. An
  older server's `app_disconnected` is mapped to `agent_disconnected` when an
  install is read; `app_disconnected` stays in `WireInstallRevokedReason` as a
  deprecated member so existing comparisons compile.
- `verifyWireAction`, `defineAction`, `verifyWireWebhook` and `defineWebhook`
  take `agentId`; `appId` is still accepted. For actions, `agentId` is mapped
  to the manifest id Wire signs for (`geo-app` -> `geo_app`); `appId` is still
  compared as given.
- `ManifestRegistration.agentId` beside `appId` (the manifest id).
- Agent-managed containers: `isAgentManagedError`, `isAgentManagedCode`,
  `managedByFromError`, `readManagedBy` and the codes `CONTAINER_AGENT_MANAGED`
  / `CONTAINER_APP_MANAGED`. They recognize both `container_agent_managed` and
  the older `container_app_managed` (either case), and read `managedBy.agentId`
  or the older `managedBy.appId`.
- Verification failures say "not for this agent" instead of "not for this app";
  error codes are unchanged. Webhook tokens are still `typ: "wire-webhook+jwt"`.

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
