/**
 * @usewire/sdk — connection manager for Wire context containers.
 *
 * Surface: WireClient with connect / getStatus / claim / disconnect.
 *
 * The SDK is stateless. connect() returns a Connection with everything
 * you need (mcpUrl, apiKey, deviceKey, container metadata). The caller
 * decides what to persist and where.
 */
export { WireClient } from './client.js';
export type { WireClientOptions } from './client.js';

export type {
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
