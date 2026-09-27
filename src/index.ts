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
 * The app side (verifying Wire's calls to a Connect app's actions, serving
 * them, typing the manifest) lives on the separate `@usewire/sdk/app` entry
 * so this one stays small. `WireClient.registerManifest()` is here because it
 * is an app→Wire call like connect.
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

// Type-only: the manifest shape registerManifest() takes. The runtime lives
// on @usewire/sdk/app.
export type { WireManifest } from './app/manifest.js';
