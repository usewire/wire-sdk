/**
 * @usewire/sdk/app — the app side of Wire Connect (SUP-946).
 *
 * A Connect app declares, in a manifest, custom tools and the HTTPS actions
 * those tools call before or after their base tool. Wire calls the actions,
 * signing every call with its own Ed25519 key. This entry point verifies those
 * calls and serves the actions:
 *
 *   - defineManifest(manifest)                typed, locally checked manifest
 *   - defineAction(manifest, name, handler)   a verified fetch handler for one action
 *   - verifyWireAction(request, { appId, action })  verification alone, for your own server
 *   - toNodeHandler(endpoint)                 Node (req, res) adapter
 *
 * Kept apart from the root entry (the connection manager) so apps that only
 * connect never bundle any of this. Registering the manifest is
 * `WireClient.registerManifest()` on the root entry.
 */
export { defineAction } from './action.js';
export type {
  ActionContext,
  ActionErrorEvent,
  ActionHandler,
  DefineActionOptions,
  WireActionEndpoint,
} from './action.js';

export { defineManifest, MANIFEST_VERSION, MAX_ACTION_TIMEOUT_MS } from './manifest.js';
export type {
  ActionName,
  DefinedManifest,
  ManifestAction,
  ManifestActionStep,
  ManifestApp,
  ManifestObject,
  ManifestObjectField,
  ManifestTool,
  WireManifest,
} from './manifest.js';

export {
  verifyWireAction,
  sha256Base64Url,
  DEFAULT_CLOCK_TOLERANCE_SEC,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_WIRE_JWKS_URL,
  MAX_TOKEN_LIFETIME_SEC,
  WIRE_ACTION_CLAIMS,
  WIRE_ACTION_ISSUER,
  WIRE_ACTION_JWT_TYP,
  WIRE_REQUEST_ID_HEADER,
} from './verify.js';
export type { VerifiedWireAction, VerifyWireActionOptions, WireActionClaims } from './verify.js';

export { MemoryReplayStore } from './replay.js';
export type { MemoryReplayStoreOptions, ReplayStore } from './replay.js';

export { toNodeHandler } from './node.js';
export type { NodeHandlerOptions, NodeRequestLike, NodeResponseLike } from './node.js';

export { WireActionAuthError, WireActionError, WireManifestError } from './errors.js';
export type { WireActionAuthErrorCode } from './errors.js';

export type { JsonSchema, SchemaIssue } from './schema.js';
