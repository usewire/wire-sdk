/**
 * @usewire/sdk — connection manager for Wire context containers.
 *
 * Two surfaces for two modes:
 * - WireClient (connect mode): your user authorizes against their own Wire
 *   account — connect / connectInBrowser / getStatus / claim / disconnect.
 * - WireProvisionClient (provision mode): your backend holds an org API key
 *   and manages containers in your own organization — containers.create /
 *   list / update / delete, plus whoami.
 *
 * The agent side (verifying Wire's calls to an agent's actions and webhooks,
 * serving them, typing the manifest, reading installs) lives on the separate
 * `@usewire/sdk/agent` entry (`@usewire/sdk/app` is the same entry under its
 * pre-0.10 name) so this one stays small. `WireClient.registerManifest()` is
 * here because it is an agent→Wire call like connect.
 *
 * The SDK is stateless. connect() returns a Connection with everything
 * you need (mcpUrl, apiKey, deviceKey, container metadata). The caller
 * decides what to persist and where.
 */
export {
  WireClient,
  MANIFEST_JWT_AUDIENCE,
  MANIFEST_REGISTER_PATH,
  MANIFEST_VALIDATOR_HEADER,
} from './client.js';
export type { WireClientOptions } from './client.js';

export { WireProvisionClient } from './provision.js';
export type {
  WireProvisionClientOptions,
  ProvisionedContainer,
  ProvisionIdentity,
} from './provision.js';

export type {
  BrowserConnectOptions,
  ClaimLink,
  ClaimOptions,
  ClaimResult,
  Connection,
  ConnectOptions,
  DeviceKey,
  ManifestRegistration,
  PendingConnection,
  StatusSnapshot,
} from './types.js';

export { WireSdkError } from './types.js';

export {
  CONTAINER_AGENT_MANAGED,
  CONTAINER_APP_MANAGED,
  isAgentManagedCode,
  isAgentManagedError,
  managedByFromError,
  readManagedBy,
} from './managed.js';
export type { WireManagedBy } from './managed.js';

// Type-only: the manifest shape registerManifest() takes. The runtime lives
// on @usewire/sdk/agent.
export type { WireManifest } from './app/manifest.js';
