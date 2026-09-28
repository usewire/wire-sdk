/**
 * An install of an agent (SUP-958): one agent, one user, one container. An
 * install is the agent's manifest applied to a container.
 *
 * What Wire lets an agent know about its own installs, by two stable ids that
 * grant nothing on their own:
 *
 *   - `installId` (`ins_…`): one per (agent, user, container). A reconnect of
 *     the same user to the same container keeps it.
 *   - `agentUserId` (`au_…`): one per (agent, user), PAIRWISE (another agent
 *     gets a different id for the same person, and it never reveals the Wire
 *     user id). Null while the user is on an unclaimed trial; set on claim.
 *
 * The same shape comes back from WireAgentClient and in every install webhook.
 * Wire owns it (wire-platform `InstallView`); this module only maps its JSON
 * to typed values. It reads both the current field names and the ones Wire
 * sent before the agent rename (`appUserId`, reason `app_disconnected`), so it
 * works against either server.
 */

/** Why an install is revoked. */
export type WireInstallRevokedReason =
  /** The user disconnected the agent (dashboard, or the SDK's disconnect). */
  | 'user_disconnected'
  /** The agent's side ended it (credential rotation, the agent disabled, a revoked credential). */
  | 'agent_disconnected'
  /**
   * @deprecated The pre-0.10 spelling of `agent_disconnected`. The SDK maps it
   * to `agent_disconnected` when it reads an install, so it never appears on a
   * WireInstall; kept in the type so older comparisons still compile.
   */
  | 'app_disconnected'
  /** The agent was uninstalled from the container (by its owner, or by the agent's own revokeInstall). */
  | 'uninstalled'
  /** The container was deleted (or is in the trash). */
  | 'container_deleted'
  /** The trial container expired. */
  | 'expired';

export interface WireInstall {
  /** `ins_…`: one per agent, user and container. Not a credential. */
  installId: string;
  /** `au_…`: pairwise per agent and user. Null while the user is on an unclaimed trial. */
  agentUserId: string | null;
  /** @deprecated Use `agentUserId` (the same value). */
  appUserId: string | null;
  container: {
    id: string;
    /** Null once the container is deleted (or being deleted). */
    name: string | null;
    /** Null once the container is deleted. */
    mcpEndpoint: string | null;
    orgSlug: string | null;
    /** A trial container (7 days, no Wire account yet). */
    isEphemeral: boolean;
    /** When a trial container expires; null for a permanent one. */
    ephemeralExpiresAt: Date | null;
  };
  /** False while the container is an unclaimed trial. */
  claimed: boolean;
  /**
   * Where the person creates an account and keeps the trial container. Present
   * only while the install is active and its container is an unclaimed trial.
   * Not a credential, and it stops working if the agent is disconnected or
   * uninstalled first.
   */
  claimUrl?: string;
  connection: {
    /** `active` while any of the install's connections is live. */
    status: 'active' | 'revoked';
    /** Set when `status` is `revoked`. */
    reason?: WireInstallRevokedReason;
    connectedAt: Date;
    /** The last time the install's credential was used. */
    lastUsedAt: Date | null;
  };
  /** Opens the container's installed agents in the Wire dashboard: link to it from your manage screen. */
  manageUrl: string;
  /**
   * The version of your agent's manifest the install's container runs. Null
   * when your agent has no manifest, the install is no longer installed, or
   * Wire cannot tell (and from an older Wire that does not send it).
   */
  installedVersion: string | null;
  /**
   * The version your agent currently has registered with Wire. Null when your
   * agent has no manifest (and from an older Wire that does not send it).
   */
  latestVersion: string | null;
  /**
   * True when the install is active and its container runs an older version
   * than `latestVersion`. Registering a version never updates an install: the
   * user approves the update in Wire, at `upgradeUrl`. False from an older
   * Wire that does not send it.
   */
  updateAvailable: boolean;
  /**
   * Opens the review screen for this install's update in the Wire dashboard,
   * where the user (signing in to Wire if needed) approves or declines it.
   * Present only when `updateAvailable` is true. Not a credential.
   */
  upgradeUrl?: string;
}

/** Thrown by installFromWire for anything that is not an install. */
export class InstallShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallShapeError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || !v) throw new InstallShapeError(`${path} is not a string`);
  return v;
}

function strOrNull(v: unknown, path: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new InstallShapeError(`${path} is not a string or null`);
  return v;
}

function date(v: unknown, path: string): Date {
  const d = new Date(str(v, path));
  if (Number.isNaN(d.getTime())) throw new InstallShapeError(`${path} is not a date`);
  return d;
}

function dateOrNull(v: unknown, path: string): Date | null {
  return v === null || v === undefined ? null : date(v, path);
}

/** Map Wire's install JSON to a WireInstall (ISO strings become Dates). Throws InstallShapeError. */
export function installFromWire(raw: unknown): WireInstall {
  if (!isRecord(raw)) throw new InstallShapeError('install is not an object');
  const c = raw.container;
  const conn = raw.connection;
  if (!isRecord(c)) throw new InstallShapeError('install.container is not an object');
  if (!isRecord(conn)) throw new InstallShapeError('install.connection is not an object');
  const status = conn.status;
  if (status !== 'active' && status !== 'revoked') {
    throw new InstallShapeError('install.connection.status is not active or revoked');
  }
  // `agentUserId` since the agent rename; `appUserId` from a server before it.
  const agentUserId =
    raw.agentUserId !== undefined
      ? strOrNull(raw.agentUserId, 'install.agentUserId')
      : strOrNull(raw.appUserId, 'install.appUserId');
  const install: WireInstall = {
    installId: str(raw.installId, 'install.installId'),
    agentUserId,
    appUserId: agentUserId,
    container: {
      id: str(c.id, 'install.container.id'),
      name: strOrNull(c.name, 'install.container.name'),
      mcpEndpoint: strOrNull(c.mcpEndpoint, 'install.container.mcpEndpoint'),
      orgSlug: strOrNull(c.orgSlug, 'install.container.orgSlug'),
      isEphemeral: c.isEphemeral === true,
      ephemeralExpiresAt: dateOrNull(c.ephemeralExpiresAt, 'install.container.ephemeralExpiresAt'),
    },
    claimed: raw.claimed === true,
    connection: {
      status,
      connectedAt: date(conn.connectedAt, 'install.connection.connectedAt'),
      lastUsedAt: dateOrNull(conn.lastUsedAt, 'install.connection.lastUsedAt'),
    },
    manageUrl: str(raw.manageUrl, 'install.manageUrl'),
    // An older Wire sends none of these: they read as null, null, false.
    installedVersion: strOrNull(raw.installedVersion, 'install.installedVersion'),
    latestVersion: strOrNull(raw.latestVersion, 'install.latestVersion'),
    updateAvailable: raw.updateAvailable === true,
  };
  if (typeof conn.reason === 'string') install.connection.reason = normalizeRevokedReason(conn.reason);
  if (typeof raw.claimUrl === 'string' && raw.claimUrl) install.claimUrl = raw.claimUrl;
  if (install.updateAvailable && typeof raw.upgradeUrl === 'string' && raw.upgradeUrl) install.upgradeUrl = raw.upgradeUrl;
  return install;
}

/** A revocation reason in the current vocabulary: `app_disconnected` (before the agent rename) reads as `agent_disconnected`. */
export function normalizeRevokedReason(reason: string): WireInstallRevokedReason {
  return (reason === 'app_disconnected' ? 'agent_disconnected' : reason) as WireInstallRevokedReason;
}
