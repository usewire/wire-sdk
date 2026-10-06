# Changelog

## Unreleased

- Docs: Wire now gives a spent refresh token a ten-second grace window. Sent
  again within it, with the same request, it gets the same new tokens back, so
  an immediate retry after a lost answer is safe. After it, a spent refresh
  token still signs the person out of your agent. The README's refresh section
  and `refresh()`'s documentation say so.
- `WireSignIn.refresh()` tries once more, after 300 ms, when Wire answers
  `INVALID_GRANT`, before it reports it. Two refreshes with the same token at
  the same instant can leave one of them refused for a moment with nothing
  ended; the second try gets the same new tokens the other request got. A
  token that is really no longer good is refused twice instead of once, and
  the error is the same. `refreshRetryDelayMs` sets the pause. A code exchange
  is never tried again.

## 0.17.0

- **Sign in with Wire.** Two new server-side clients on `@usewire/sdk/agent`,
  for an agent whose manifest declares `access`:
  - `WireSignIn`: `createAuthorizeRequest()` / `authorizeUrl()` (a code flow
    with PKCE that never names a `resource`), `exchangeCode()` and `refresh()`
    (authenticated with your client secret), `verifyIdToken()` and
    `userInfo()`. The ID token is verified against Wire's published keys
    (EdDSA, issuer, audience, expiry, one audience only) and its `sub` must be
    a per-agent user id (`au_…`, Wire's own pattern). `exchangeCode` requires
    the `nonce` (`nonce: false` to opt out). It refuses to be constructed where
    both `window` and `document` exist.
  - **A refresh never loses the new refresh token.** Wire's keys are fetched
    before the token is sent, so a key failure costs nothing; an answer with no
    ID token (Wire may leave it out of a refresh) gives the tokens with
    `identity: null`; and if the ID token does not verify after Wire has
    answered, the thrown `WireSignInError` carries the new tokens as `tokens`
    and is not `retryable`. A key set that is unreachable or answers anything
    but 200 is `UNAVAILABLE`, never `INVALID_ID_TOKEN`.
  - **Runs on Cloudflare Workers.** Requests use `redirect: 'manual'` and
    treat any redirect as an error; nothing is followed. A test runs the built
    package inside workerd.
  - `WireAgentEndpoint`: `listTools(accessToken)` and
    `callTool(accessToken, name, args)` against your agent's own hostname
    (`GET /tools`, `POST /tools/{name}`).
  - New errors `WireSignInError` and `WireEndpointError`, each with a typed
    `code` and a `retryable` flag.
- **The manifest validator matches what Wire accepts today.** The vendored
  validator moves to the engine commit Wire runs
  (`c590e34c3d4d9bd0d3c3c9cd8bf4a3ebeab098cb`), and `defineManifest` now
  checks a manifest the way Wire's registration does:
  - `access` (`level`, `read`, `write`, `identity`) and
    `app.privacy_policy_url` are accepted. 0.16.0 refused both. A privacy
    policy is required when `access.identity` asks for anything.
  - A tool of your own may wrap `wire_claim`. 0.16.0 refused it as an unknown
    tool, though Wire requires it of an agent that allows connecting without an
    account.
  - Two of Wire's own rules are now checked locally, with Wire's messages:
    `wire_claim` is never in `base_tools` and its wrapping tool runs no action
    and has no view; `app.privacy_policy_url` is never on usewire.io.
  - The retired built-in tool name `wire_export` is accepted and ignored.
- **New: `validateWireManifest(raw)`**, the non-throwing form of the above. It
  answers the normalized manifest, `access` with every key filled, and
  `warnings` (today: `access_undeclared`, a manifest whose tools send records
  to your server while it has no `access` block). `manifestWarnings(manifest)`
  answers the warnings alone. The engine's `validateManifest` is still
  exported, unchanged; on its own it does not know `wire_claim`.
- **New: `claimMapping(manifest)`**, the rule for an agent that lets people
  connect without an account: exactly one usable tool wraps `wire_claim`.
- **Manifest types now cover the whole contract:** `access`,
  `app.privacy_policy_url`, `analysis`, `builtin_tools`, and a tool's `enabled`
  and `transports`. Wire already accepted the last four; the types did not let
  you write them.
- **`connectInBrowser()` when Wire answers `invalid_client`** now throws
  `WireSdkError` with `code: 'ACCESS_AGENT_NEEDS_SERVER'`. The message says to
  use `WireSignIn` on your server if your manifest declares `access`, and
  otherwise to check the agent id and that the agent is active. Before, this
  was a generic `OAUTH_ERROR`. `connectInBrowser()` is unchanged for every
  other agent.
- `WireAgentEndpoint` refuses an `endpoint` that carries credentials or whose
  host ends with a dot.
- New dev dependencies, for the workerd test only: `miniflare`, `esbuild`.
- README: "Sign in with Wire", including moving an agent from in-browser
  connect, and mapping the claim for trials.

## 0.16.0

- **Export an install's container.** `WireAgentClient` gains two methods, on
  the same runtime-key auth as the installs API:
  - `requestExport(installId)` calls
    `POST /api/v1/agents/{agentId}/installs/{installId}/export` and resolves
    with `{ exportId, status, createdAt, reused }`.
  - `getExport(installId, exportId)` calls
    `GET …/installs/{installId}/exports/{exportId}` and resolves with
    `{ exportId, status, createdAt, completedAt, expiresAt }`, or `null` for an
    export your agent did not start on that install.
  - Wire emails the container's owner when the archive is ready, and
    downloading it means signing in to Wire. The agent gets an id and a status,
    never the archive or a download URL.
  - Limits are per container: one new archive per 24 hours (asking again
    within that window returns the existing one, `reused: true`), and 5 per
    calendar month.
- **New error: `WireExportLimitError`** (`code: "EXPORT_LIMIT"`, status 429),
  a `WireAgentApiError` with a typed `retryAfter: Date | null`. Its
  `retryable` is false. Other 429s are unchanged and stay retryable.
- `requestExport` of a revoked install is refused with 409
  `AGENT_DISCONNECTED`, and of an unclaimed trial with 409 `INSTALL_IS_TRIAL`,
  both thrown as `WireAgentApiError` (not `retryable`).
- New types: `WireExportRequest`, `WireExport`, `WireExportStatus`; new
  constant `EXPORT_LIMIT`.
- The client now signs `body_sha256` on `POST` as well as `DELETE`
  (`signRequestToken('POST', body)`), over the exact bytes sent.
- A 2xx answer whose envelope has `data` but no `success` field is now read by
  its `data`. An envelope with `success: false` is still an error.

## 0.15.2

- **Browser connect finishes in a new tab.** `connectInBrowser()` kept its
  PKCE verifier in `sessionStorage`, which belongs to one tab. When a user
  signed up by magic link, the email opened a new tab, the callback landed
  there, and `completeConnectInBrowser()` found nothing and returned `null`.
  The code was never exchanged, and the app had nothing to show.
  - The verifier now lives in `localStorage` under the flow's `state`
    (`sessionStorage` if `localStorage` is unavailable). It expires after
    10 minutes and is deleted once used, whether the exchange succeeds or
    fails. Expired entries are swept when a new connect starts.
  - A connect started on 0.15.1 or earlier, whose verifier is in this tab's
    `sessionStorage`, still completes.
- **New error: `CONNECT_STATE_LOST`.** `completeConnectInBrowser()` throws it
  when the URL has a code but this browser has no record of starting the
  connect (a different browser, or more than 10 minutes later). Show the user
  a way to start again. `null` now means only "this page isn't a callback"
  (no `code` and no `error` in the URL).
- Popup mode is unchanged: it stores nothing, and the popup's callback page
  relays the code to its opener.
- If neither storage is writable, a redirect-mode `connectInBrowser()` now
  throws `STORAGE_UNAVAILABLE` before leaving the page, instead of the
  browser's own exception.

## 0.15.1

- `examples/places-map-ui`: map tiles now load in ChatGPT, whose widget CSP is
  `worker-src blob:` only. Before this, the pins rendered but the tiles never
  loaded ("Worker failed to load").
  - Cause: MapLibre's worker wrapper uses a static `import` from jsDelivr
    inside the worker, which is checked against `worker-src` and refused.
  - Fix: the view starts the worker from its own blob: wrapper, which loads it
    with a dynamic `import()`. That is checked against `script-src`, where
    `resourceDomains` puts jsDelivr.
  - The view now probes that exact path before the first map, and falls back
    to running the worker on the main thread if it fails for any reason.
  - The dev server's basic-host patch gains `CHATGPT_CSP=1`. No SDK code
    changed, and `csp.json` is unchanged.

## 0.15.0

Tool annotations, output schemas, view-only results and hashed view URIs
(SUP-953). Vendors the manifest validator at usewire/wire@027a1cf
(usewire/wire#129).

**Breaking: view URIs carry a hash.** Wire serves a view at
`ui://<app id>/<name>-<hash>`, where `hash` is the first 8 hex digits of the
HTML's SHA-256, so a host that caches views by URI never renders an old one
after an upgrade. The helpers change with it:

- `uiUri(appId, name)` → `uiUri(appId, name, hash)`, with
  `hash = uiResourceHash(html)`.
- `parseUiUri(uri)` now returns `{ appId, name, hash }`, and returns null for an
  unhashed `ui://<app id>/<name>`.

Migration: build a URI with `uiUri(appId, name, uiResourceHash(html))`. Don't
hard-code `ui://…/<name>`: read the tool's `_meta.ui.resourceUri` from
`tools/list`. A manifest's `ui[].name` and a tool's `ui.resource` are
unchanged: the hash is never part of the name.

Everything else is additive:

- **`ManifestTool.annotations?: { title?, readOnlyHint?, destructiveHint?, openWorldHint? }`.**
  A custom tool inherits its base tool's annotations, and `openWorldHint` is
  true when it calls an action. A manifest may override them **only toward
  caution**: `readOnlyHint: true` is refused on a tool that writes (e.g. over
  `wire_write`), and `destructiveHint: false` on one that deletes (over
  `wire_delete`). Marking a tool less read-only, more destructive or
  open-world is always accepted, and so is a `title` (at most 120 characters).
- **`ManifestTool.outputSchema?`**: the JSON Schema of the tool's result data,
  checked on every call and listed on the tool. Without one, a tool that
  returns its base tool's result unchanged (no `result` mapping, no action)
  inherits the base tool's schema.
- **`result._meta`**: a top-level `_meta` in a result mapping is view-only data.
  Wire returns it as the MCP result's `_meta.view`, never in
  `structuredContent` or `content`, so the model never reads it.
- New exports: `uiResourceHash`, `parseUiUri`, `UI_HASH_LEN`,
  `sha256HexSync`, `VIEW_META_KEY`, `TOOL_ANNOTATION_KEYS`, `TOOL_TITLE_MAX`,
  and the types `ManifestToolAnnotations` and `ToolAnnotations`.
- `examples/places-map-ui` renders a `render_places_map` result: wire_query's
  `{ columns, rows }`, plus `_meta.view` `{ title, center }`. Its
  `manifest-snippet.ts` and README show the recommended split: `search_places`
  without a view, and `render_places_map { place_ids }` over `wire_query`. The
  ids are bound as one JSON text param, `'{"ids":{{input.place_ids}}}'` with
  `json_each(?1, '$.ids')`, because wire_query params are scalars and a
  whole-value array substitution is refused. The dev server serves the view at
  its hashed URI and runs that SQL.

## 0.14.2

- Vendors the manifest validator at usewire/wire@0d73867 (usewire/wire#128).
  `wire_search` has two new abilities, and a manifest tool may fix or fill both:
  - `object` accepts a list (1-20 names), and every record match carries its
    `object`.
  - `matchLinked: { objects, types?, direction? }`: the same query also ranks
    records of `objects`, and each hit lifts the records it is linked to. A
    place is found through its note "best cortado in town". A lifted result
    still has to pass `object` and `near`. It lists the records that lifted it
    in `matchedVia: [{ id, object, type, score, content, fields? }]`, best
    first. `direction` is `'incoming'` (the default), `'outgoing'` or `'both'`.

  Someday-style tools:

  ```ts
  // Places, found by name or by what the user wrote about them.
  {
    name: 'search_places',
    // ...
    tool: {
      name: 'wire_search',
      args: {
        object: 'place',
        query: '{{input.query}}',
        near: { lat: '{{input.lat}}', lng: '{{input.lng}}', radius_km: '{{input.radius_km}}' },
        matchLinked: { objects: ['note', 'visit', 'event'] },
      },
    },
  }

  // Everything the user saved, one search across objects.
  {
    name: 'search_saved',
    // ...
    tool: {
      name: 'wire_search',
      args: { object: ['place', 'note', 'visit', 'event'], query: '{{input.query}}' },
    },
  }
  ```

- `examples/places-map-ui` shows why a place matched when it has `matchedVia`,
  in its list row and popup: "Matched your note: “best cortado in town”", with
  "+N more" when several records matched. The wording follows the object
  (note, visit, event). The dev server's sample data has a place found only
  through its note (search "cortado").

## 0.14.1

- Vendors the manifest validator at usewire/wire@25f3ecb (usewire/wire#127). In
  relationships mode, `wire_navigate` now returns the anchor `entry` and the
  `linked` records themselves, newest first, not only the edges. It takes two
  new arguments that a manifest tool may fix or fill:
  - `direction`: `'incoming'` (records whose links point at this one),
    `'outgoing'` or `'both'` (the default).
  - `limit`: the most linked records to return, 1-200 (default 50).

  A place's history, for example:
  `{ name: 'wire_navigate', args: { entryId: '{{input.place_id}}', mode: 'relationships', type: ['about', 'visited', 'held_at'], direction: 'incoming' } }`.

## 0.14.0

Interactive views (MCP Apps, SUP-953). A manifest can ship HTML views that
clients supporting MCP Apps (`io.modelcontextprotocol/ui`) render for a tool's
result.

- Vendors the manifest validator at usewire/wire@744815c (usewire/wire#126).
  `defineManifest` accepts and checks:
  - `ui?: ManifestUi[]`: `{ name, title?, html, csp?, permissions?,
    prefersBorder? }`, at most 8 views, each `html` at most 512 KB and 1 MB in
    total. `csp` holds `connectDomains`, `resourceDomains`, `frameDomains` and
    `baseUriDomains`, each a list of https origins (never Wire's own domain).
    `permissions` holds `camera`, `microphone`, `geolocation` and
    `clipboardWrite`, each `{}`.
  - `ManifestTool.ui?: { resource, visibility? }`: the view that renders the
    tool's result, by name, and who may call the tool (`'model'`, `'app'`).
    Only tools take it, not actions.
- New types `ManifestUi`, `ManifestUiCsp`, `ManifestUiPermissions` and
  `ManifestToolUi`. New exports from the engine: `UI_MIME_TYPE`,
  `UI_EXTENSION`, `UI_URI_SCHEME`, the limits (`UI_HTML_MAX_BYTES`,
  `UI_TOTAL_HTML_MAX_BYTES`, `UI_MAX_RESOURCES`, `UI_NAME_MAX`,
  `UI_TITLE_MAX`, `UI_CSP_DOMAINS_MAX`), `uiUri(appId, name)` and
  `uiDomainProblem(origin)`.
- README: "Interactive views (MCP Apps)". `examples/places-map-ui` (PR #16) is
  a complete view: saved places on a map, one HTML file plus its CSP.

## 0.13.0

Update available (SUP-948). Registering a new manifest version never updates an
install: the user approves the update in Wire. An install now says which
version its container runs and links to the review screen when a newer one is
registered.

- `WireInstall` gains four fields, from `getInstall`, `listInstalls`,
  `revokeInstall` and every install webhook:
  - `installedVersion: string | null`: the manifest version the install's
    container runs. Null when the agent has no manifest, the install is no
    longer installed, or Wire cannot tell.
  - `latestVersion: string | null`: the version the agent has registered with
    Wire. Null when the agent has no manifest.
  - `updateAvailable: boolean`: the install is active and runs an older version
    than `latestVersion`.
  - `upgradeUrl?: string`: present only when `updateAvailable` is true. Opens
    the install's update in the Wire dashboard, where the user approves or
    declines it.
- Against an older Wire that does not send them, the SDK reads the versions as
  null, `updateAvailable` as false, and leaves `upgradeUrl` out.
- README: `install.upgraded` is described as what it is: an active install was
  updated to a newer version of your manifest, approved by the user in Wire
  (through your connect flow, or from Wire's dashboard after `upgradeUrl`).

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
