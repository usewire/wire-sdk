/**
 * An export of an install's container, started by the agent: Wire builds an
 * archive of the container and emails the container's owner a link. Downloading
 * it means signing in to Wire. The agent gets an id and a status to poll, never
 * the archive and never a download URL.
 *
 * Limits are per container: one new archive per 24 hours (a request inside that
 * window is answered with the archive already made, `reused: true`), and at most
 * 5 per calendar month. Past either, Wire answers 429 and the client throws
 * WireExportLimitError, with `retryAfter`.
 *
 * Wire owns the shape; this module only maps its JSON to typed values (ISO
 * strings become Dates), the same way installs.ts does.
 */

/** Where an export is. `completed` means the archive is built and Wire has emailed the owner. */
export type WireExportStatus = 'queued' | 'running' | 'completed' | 'failed';

/** What `requestExport` resolves with. */
export interface WireExportRequest {
  /** The export's id. Keep it to poll `getExport`. */
  exportId: string;
  status: WireExportStatus;
  createdAt: Date;
  /**
   * True when Wire answered with an archive made in the last 24 hours instead of
   * starting a new one. `exportId` and `createdAt` are that archive's.
   */
  reused: boolean;
}

/** What `getExport` resolves with. Never a download URL: the owner downloads from Wire, signed in. */
export interface WireExport {
  exportId: string;
  status: WireExportStatus;
  createdAt: Date;
  /** When the export completed; null before then. */
  completedAt: Date | null;
  /** When the archive stops being downloadable; null until it is built. */
  expiresAt: Date | null;
}

const STATUSES: ReadonlySet<string> = new Set<WireExportStatus>(['queued', 'running', 'completed', 'failed']);

/** Thrown by the mappers below for anything that is not an export. */
export class ExportShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportShapeError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || !v) throw new ExportShapeError(`${path} is not a string`);
  return v;
}

function date(v: unknown, path: string): Date {
  const d = new Date(str(v, path));
  if (Number.isNaN(d.getTime())) throw new ExportShapeError(`${path} is not a date`);
  return d;
}

function dateOrNull(v: unknown, path: string): Date | null {
  return v === null || v === undefined ? null : date(v, path);
}

function status(v: unknown): WireExportStatus {
  if (typeof v !== 'string' || !STATUSES.has(v)) {
    throw new ExportShapeError('export.status is not queued, running, completed or failed');
  }
  return v as WireExportStatus;
}

/** Map Wire's answer to `POST …/installs/{installId}/export`. Throws ExportShapeError. */
export function exportRequestFromWire(raw: unknown): WireExportRequest {
  if (!isRecord(raw)) throw new ExportShapeError('export is not an object');
  if (typeof raw.reused !== 'boolean') throw new ExportShapeError('export.reused is not a boolean');
  return {
    exportId: str(raw.exportId, 'export.exportId'),
    status: status(raw.status),
    createdAt: date(raw.createdAt, 'export.createdAt'),
    reused: raw.reused,
  };
}

/** Map Wire's answer to `GET …/installs/{installId}/exports/{exportId}`. Throws ExportShapeError. */
export function exportFromWire(raw: unknown): WireExport {
  if (!isRecord(raw)) throw new ExportShapeError('export is not an object');
  return {
    exportId: str(raw.exportId, 'export.exportId'),
    status: status(raw.status),
    createdAt: date(raw.createdAt, 'export.createdAt'),
    completedAt: dateOrNull(raw.completedAt, 'export.completedAt'),
    expiresAt: dateOrNull(raw.expiresAt, 'export.expiresAt'),
  };
}
