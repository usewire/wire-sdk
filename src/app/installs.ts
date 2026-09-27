/**
 * An install of a Connect app (SUP-958): one app, one user, one container.
 *
 * What Wire lets an app know about its own installs, by two stable ids that
 * grant nothing on their own:
 *
 *   - `installId` (`ins_…`): one per (app, user, container). A reconnect of
 *     the same user to the same container keeps it.
 *   - `appUserId` (`au_…`): one per (app, user), PAIRWISE (another app gets a
 *     different id for the same person, and it never reveals the Wire user
 *     id). Null while the user is on an unclaimed trial; set on claim.
 *
 * The same shape comes back from WireAppClient and in every install webhook.
 * Wire owns it (wire-platform `apps/server/src/lib/app-installs.ts`,
 * `InstallView`); this module only maps its JSON to typed values.
 */

/** Why an install is revoked. */
export type WireInstallRevokedReason =
  /** The user disconnected the app (dashboard, or the SDK's disconnect). */
  | 'user_disconnected'
  /** The app's side ended it (credential rotation, the app disabled, a revoked credential). */
  | 'app_disconnected'
  /** The app was uninstalled from the container (by its owner, or by the app's own revokeInstall). */
  | 'uninstalled'
  /** The container was deleted (or is in the trash). */
  | 'container_deleted'
  /** The trial container expired. */
  | 'expired';

export interface WireInstall {
  /** `ins_…`: one per app, user and container. Not a credential. */
  installId: string;
  /** `au_…`: pairwise per app and user. Null while the user is on an unclaimed trial. */
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
   * Not a credential, and it stops working if the app is disconnected or
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
  /** Opens the container's installed apps in the Wire dashboard: link to it from your manage screen. */
  manageUrl: string;
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
  const install: WireInstall = {
    installId: str(raw.installId, 'install.installId'),
    appUserId: strOrNull(raw.appUserId, 'install.appUserId'),
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
  };
  if (typeof conn.reason === 'string') install.connection.reason = conn.reason as WireInstallRevokedReason;
  if (typeof raw.claimUrl === 'string' && raw.claimUrl) install.claimUrl = raw.claimUrl;
  return install;
}
