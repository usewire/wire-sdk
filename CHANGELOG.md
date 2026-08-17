# Changelog

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
