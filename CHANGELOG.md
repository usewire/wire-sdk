# Changelog

## Unreleased

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
- The registration endpoint is provisional until the matching Wire release.

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
