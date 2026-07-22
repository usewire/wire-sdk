/**
 * @usewire/sdk — connection manager for Wire context containers.
 *
 * Two surfaces for two modes:
 * - WireClient (connect mode): your user authorizes against their own Wire
 *   account — connect / connectInBrowser / getStatus / claim / disconnect.
 * - WireProvisionClient (provision mode): your backend holds an org API key
 *   and manages containers in your own organization — containers.create /
 *   list / update / delete, plus whoami. Each container exposes a case
 *   surface: container.case(id) for scoped data ops, container.cases.list().
 *
 * The SDK is stateless. connect() returns a Connection with everything
 * you need (mcpUrl, apiKey, deviceKey, container metadata). The caller
 * decides what to persist and where.
 */
export { WireClient } from './client.js';
export type { WireClientOptions } from './client.js';

export { WireProvisionClient, ProvisionedContainerHandle, WireCase } from './provision.js';
export type {
  WireProvisionClientOptions,
  ProvisionedContainer,
  ProvisionIdentity,
  CaseSummary,
  CaseListResult,
  CaseToolResult,
} from './provision.js';

export type {
  BrowserConnectOptions,
  ClaimLink,
  ClaimOptions,
  ClaimResult,
  Connection,
  ConnectOptions,
  DeviceKey,
  PendingConnection,
  StatusSnapshot,
} from './types.js';

export { WireSdkError } from './types.js';
