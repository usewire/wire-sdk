/**
 * @usewire/sdk/agent — the agent side of Wire (SUP-946). Also published as
 * `@usewire/sdk/app`, its pre-0.10 name: the two entries are the same module.
 *
 * An agent may bring a manifest: custom tools and the HTTPS actions those
 * tools call before or after their base tool. Installing it on a container
 * applies the manifest there. Wire calls the actions, signing every call with
 * its own Ed25519 key. This entry point verifies those calls and serves the
 * actions:
 *
 *   - defineManifest(manifest)                  typed, locally checked manifest
 *   - defineAction(manifest, name, handler)     a verified fetch handler for one action
 *   - verifyWireAction(request, { agentId, action })  verification alone, for your own server
 *   - toNodeHandler(endpoint)                   Node (req, res) adapter
 *
 * And the agent's own view of its installs (SUP-958):
 *
 *   - new WireAgentClient({ agentId, runtimeKey })  getInstall / listInstalls / revokeInstall
 *   - verifyWireWebhook(request, { agentId })       verify one install webhook
 *   - defineWebhook(handlers, { agentId })          a verified webhook endpoint
 *   - generateRuntimeKey()                          the key WireAgentClient signs with
 *
 * The pre-0.10 names (WireAppClient, APP_API_AUDIENCE, WireAppApiError, the
 * `appId` option) still work and are marked deprecated.
 *
 * Kept apart from the root entry (the connection manager) so agents that only
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
/** SUP-962: the manifest's skill (SKILL.md), checked with Wire's own reader. */
export { defineSkill, skillFrontmatter } from './skill.js';
export type { SkillInput } from './skill.js';
export {
  parseSkill,
  skillUri,
  SKILL_NAME_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_COMPATIBILITY_MAX,
  SKILL_LICENSE_MAX,
  SKILL_METADATA_MAX_KEYS,
  SKILL_METADATA_VALUE_MAX,
  SKILLS_EXTENSION,
  INSTRUCTIONS_MAX,
  SKILL_MAX,
} from '../vendor/manifest/manifest.js';
export type { SkillFrontmatter, SkillParse } from '../vendor/manifest/manifest.js';
/** The engine's manifest validator itself (vendored at MANIFEST_REF), for tooling and CI checks. */
export { validateManifest } from '../vendor/manifest/manifest.js';
export type { ConnectManifest, ManifestValidation } from '../vendor/manifest/manifest.js';
export { MANIFEST_VALIDATOR_REF } from '../vendor/manifest/ref.js';
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
  normalizeActionUrl,
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

export {
  WireAgentClient,
  generateRuntimeKey,
  AGENT_API_AUDIENCE,
  AGENT_API_BODY_HASH_CLAIM,
  AGENT_API_TOKEN_LIFETIME_SEC,
  // Deprecated pre-0.10 names.
  WireAppClient,
  APP_API_AUDIENCE,
  APP_API_BODY_HASH_CLAIM,
  APP_API_TOKEN_LIFETIME_SEC,
} from './agent-client.js';
export type { WireAgentClientOptions, WireAppClientOptions, WireRuntimeKey } from './agent-client.js';

export { normalizeRevokedReason } from './installs.js';
export type { WireInstall, WireInstallRevokedReason } from './installs.js';

export {
  CONTAINER_AGENT_MANAGED,
  CONTAINER_APP_MANAGED,
  isAgentManagedCode,
  isAgentManagedError,
  managedByFromError,
  readManagedBy,
} from '../managed.js';
export type { WireManagedBy } from '../managed.js';

export {
  defineWebhook,
  verifyWireWebhook,
  DEFAULT_WEBHOOK_DEDUPE_TTL_SEC,
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  WIRE_WEBHOOK_CLAIMS,
  WIRE_WEBHOOK_EVENT_ID_HEADER,
  WIRE_WEBHOOK_EVENT_TYPE_HEADER,
  WIRE_WEBHOOK_EVENT_TYPES,
  WIRE_WEBHOOK_ISSUER,
  WIRE_WEBHOOK_JWT_TYP,
  WIRE_WEBHOOK_TOKEN_LIFETIME_SEC,
} from './webhook.js';
export type {
  DefineWebhookOptions,
  RawWebhookRequest,
  VerifiedWireWebhook,
  VerifyWireWebhookOptions,
  WebhookContext,
  WebhookErrorEvent,
  WebhookHandler,
  WebhookHandlers,
  WireWebhookClaims,
  WireWebhookEndpoint,
  WireWebhookEvent,
  WireWebhookEventType,
} from './webhook.js';

export {
  WireActionAuthError,
  WireActionError,
  WireAgentApiError,
  WireAppApiError,
  WireManifestError,
  WireWebhookError,
} from './errors.js';
export type { WireActionAuthErrorCode, WireWebhookErrorCode } from './errors.js';

export type { JsonSchema, SchemaIssue } from './schema.js';
