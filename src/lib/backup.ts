/**
 * Arc backup and restore (#13): what /api/v1/backup returns, the requests
 * Launchpad sends, and the wording of each outcome. Pure and isomorphic; the
 * I/O lives in src/lib/server/backups.ts.
 *
 * Shapes are checked against Arc v26.09.4 and main. Fields only main sends
 * (scope, targets, partial_view, the incompleteness counts, the listing's
 * warning and incomplete_runs, the restore's mode) are optional here, and a
 * v26.09.4 answer without them reads as a complete, single-destination,
 * whole-instance backup, which is what it is.
 */

/** Arc's backup id shape (internal/backup/manager.go backupIDShape). */
export const BACKUP_ID_RE = /^backup-\d{8}-\d{6}-[a-f0-9]{8}$/;

/** Backups listed; more is not a list Launchpad renders. */
export const MAX_BACKUPS = 1000;
const MAX_DATABASES = 1000;
/** Measurements across all databases of one backup. */
const MAX_MEASUREMENTS = 10_000;
const MAX_NAMES = 64;
const MAX_SAMPLE = 32;
const MAX_TEXT = 1000;

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Arc's text, bounded and without control characters; null when absent. */
export function arcText(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(CONTROL, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** A non-negative count; 0 when absent (Arc omits zero counts) or not a count. */
function count(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/** An ISO timestamp, or null for an absent, invalid or Go zero time. */
function time(v: unknown): string | null {
  if (typeof v !== 'string' || v.startsWith('0001-01-01')) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function names(v: unknown, max = MAX_NAMES): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = arcText(x, 256);
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The list

export interface BackupSummary {
  id: string;
  createdAt: string | null;
  /** "full" on every Arc so far. */
  type: string;
  /** The databases a scoped backup was limited to; empty for a whole-instance backup. */
  scope: string[];
  totalFiles: number;
  totalBytes: number;
  databaseCount: number;
  /**
   * Data files the backup inventoried but does not hold: unreadable at copy
   * time (less those the cluster had removed by the end of the run, which
   * are not missing data), never listable, or not yet pulled to the primary.
   * Arc's own definition of an incomplete backup (internal/backup/manifest.go).
   */
  missingFiles: number;
  /** Destinations that hold it; empty when Arc names none (one configured destination). */
  targets: string[];
  /** Counts are from fewer destinations than hold the backup: lower bounds. */
  partialView: boolean;
}

/** Shared by a list entry and the top level of a backup's detail. */
function parseSummaryFields(o: Record<string, unknown>): Omit<BackupSummary, 'id' | 'databaseCount'> {
  const target = arcText(o.target, 256);
  const targets = names(o.targets);
  return {
    createdAt: time(o.created_at),
    type: arcText(o.backup_type, 32) ?? 'full',
    scope: names(o.scope, MAX_DATABASES),
    totalFiles: count(o.total_files),
    totalBytes: count(o.total_size_bytes),
    missingFiles:
      Math.max(0, count(o.skipped_files) - count(o.skipped_reconciled)) + count(o.unaddressable_files) + count(o.manifest_only_files),
    targets: targets.length ? targets : target ? [target] : [],
    partialView: o.partial_view === true,
  };
}

/** One entry of GET /api/v1/backup; null when it is not one. */
export function parseBackupSummary(raw: unknown): BackupSummary | null {
  const o = obj(raw);
  const id = typeof o?.backup_id === 'string' && BACKUP_ID_RE.test(o.backup_id) ? o.backup_id : null;
  if (!o || !id) return null;
  return { id, databaseCount: count(o.database_count), ...parseSummaryFields(o) };
}

/** A backup run that has not landed on every destination it was written to (Arc main). */
export interface IncompleteRun {
  id: string;
  createdAt: string | null;
  missingTargets: string[];
}

export interface BackupList {
  backups: BackupSummary[];
  truncated: boolean;
  /** What Arc says about the listing itself: unreachable destinations, backups it left out. */
  notes: string[];
  incompleteRuns: IncompleteRun[];
}

/** GET /api/v1/backup, newest first; null when it is not that response. */
export function parseBackupList(raw: unknown): BackupList | null {
  const o = obj(raw);
  if (!o || !Array.isArray(o.backups)) return null;
  const seen = new Set<string>();
  const backups: BackupSummary[] = [];
  for (const entry of o.backups) {
    const b = parseBackupSummary(entry);
    if (b && !seen.has(b.id)) {
      seen.add(b.id);
      backups.push(b);
    }
  }
  // The id starts with its UTC creation time, so it orders backups the same
  // way when created_at is missing.
  backups.sort((a, b) => (b.createdAt ?? b.id).localeCompare(a.createdAt ?? a.id) || b.id.localeCompare(a.id));
  const runs = Array.isArray(o.incomplete_runs) ? o.incomplete_runs : [];
  const incompleteRuns: IncompleteRun[] = [];
  for (const r of runs.slice(0, MAX_NAMES)) {
    const x = obj(r);
    if (typeof x?.backup_id === 'string' && BACKUP_ID_RE.test(x.backup_id)) {
      incompleteRuns.push({ id: x.backup_id, createdAt: time(x.created_at), missingTargets: names(x.missing_targets) });
    }
  }
  return {
    backups: backups.slice(0, MAX_BACKUPS),
    truncated: backups.length > MAX_BACKUPS,
    notes: [arcText(o.warning), arcText(o.hint)].filter((s): s is string => !!s),
    incompleteRuns,
  };
}

// ---------------------------------------------------------------------------
// One backup

export interface BackupMeasurement {
  name: string;
  fileCount: number;
  sizeBytes: number;
}

export interface BackupDatabase extends BackupMeasurement {
  measurements: BackupMeasurement[];
}

export interface BackupDetail extends BackupSummary {
  /** The Arc version that wrote it ("dev" for a source build). */
  version: string | null;
  databases: BackupDatabase[];
  /** Databases or measurements past what Launchpad lists. */
  truncated: boolean;
  /** Arc's SQLite database (tokens, retention policies, continuous queries, audit log). */
  hasMetadata: boolean;
  /** arc.toml. */
  hasConfig: boolean;
  /** Up to 32 of the files the copy skipped. */
  skippedSample: string[];
  /**
   * Destinations a restore refuses (Arc main): no longer configured, not
   * answering, or no longer holding their part of the backup.
   */
  unavailableTargets: string[];
}

function parseEntry(raw: unknown): BackupMeasurement | null {
  const o = obj(raw);
  const name = arcText(o?.name, 256);
  if (!o || !name) return null;
  return { name, fileCount: count(o.file_count), sizeBytes: count(o.size_bytes) };
}

/** GET /api/v1/backup/:id; null when it is not that backup's manifest. */
export function parseBackupDetail(raw: unknown, id: string): BackupDetail | null {
  const o = obj(raw);
  if (!o || o.backup_id !== id) return null;
  const databases: BackupDatabase[] = [];
  let measurements = 0;
  let truncated = false;
  for (const d of Array.isArray(o.databases) ? o.databases : []) {
    const db = parseEntry(d);
    if (!db) continue;
    if (databases.length >= MAX_DATABASES) {
      truncated = true;
      break;
    }
    const list: BackupMeasurement[] = [];
    for (const m of (Array.isArray(obj(d)?.measurements) ? (obj(d)?.measurements as unknown[]) : [])) {
      const entry = parseEntry(m);
      if (!entry) continue;
      if (measurements >= MAX_MEASUREMENTS) {
        truncated = true;
        break;
      }
      measurements++;
      list.push(entry);
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    databases.push({ ...db, measurements: list });
  }
  databases.sort((a, b) => a.name.localeCompare(b.name));
  return {
    id,
    // The manifest has no database_count; its list is the count.
    databaseCount: Array.isArray(o.databases) ? o.databases.length : 0,
    ...parseSummaryFields(o),
    version: arcText(o.version, 64),
    databases,
    truncated,
    hasMetadata: o.has_metadata === true,
    hasConfig: o.has_config === true,
    skippedSample: names(o.skipped_sample, MAX_SAMPLE),
    unavailableTargets: [...new Set([...names(o.unknown_targets), ...names(o.unreachable_targets), ...names(o.missing_targets)])],
  };
}

// ---------------------------------------------------------------------------
// The running or last operation

export type BackupOperation = 'backup' | 'restore';
export type ProgressStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface BackupProgress {
  status: ProgressStatus;
  /** Null when idle. */
  operation: BackupOperation | null;
  backupId: string | null;
  scope: string[];
  totalFiles: number;
  processedFiles: number;
  skippedFiles: number;
  totalBytes: number;
  processedBytes: number;
  startedAt: string | null;
  completedAt: string | null;
  /** Restore only: "merge" or "replace" (Arc main). */
  mode: string | null;
  /** Restore only: files the backup lists that are gone from it. */
  missingFiles: number;
  error: string | null;
}

export const IDLE: BackupProgress = {
  status: 'idle', operation: null, backupId: null, scope: [], totalFiles: 0, processedFiles: 0, skippedFiles: 0,
  totalBytes: 0, processedBytes: 0, startedAt: null, completedAt: null, mode: null, missingFiles: 0, error: null,
};

/**
 * GET /api/v1/backup/status: `{status: "idle"}` until the first backup or
 * restore since Arc started, then the progress of the running or last one.
 * Null when it is not that response.
 */
export function parseProgress(raw: unknown): BackupProgress | null {
  const o = obj(raw);
  if (!o) return null;
  if (o.status === 'idle') return IDLE;
  if (o.status !== 'running' && o.status !== 'completed' && o.status !== 'failed') return null;
  if (o.operation !== 'backup' && o.operation !== 'restore') return null;
  const id = typeof o.backup_id === 'string' && BACKUP_ID_RE.test(o.backup_id) ? o.backup_id : null;
  return {
    status: o.status,
    operation: o.operation,
    backupId: id,
    scope: names(o.scope, MAX_DATABASES),
    totalFiles: count(o.total_files),
    processedFiles: count(o.processed_files),
    skippedFiles: count(o.skipped_files),
    totalBytes: count(o.total_bytes),
    processedBytes: count(o.processed_bytes),
    startedAt: time(o.started_at),
    completedAt: time(o.completed_at),
    mode: o.mode === 'merge' || o.mode === 'replace' ? o.mode : null,
    missingFiles: count(o.missing_files),
    error: arcText(o.error),
  };
}

/** Share of the work done, 0–100; null when Arc does not know the total yet. */
export function progressPercent(p: BackupProgress): number | null {
  if (p.totalBytes > 0) return Math.min(100, Math.floor((p.processedBytes / p.totalBytes) * 100));
  if (p.totalFiles > 0) return Math.min(100, Math.floor(((p.processedFiles + p.skippedFiles) / p.totalFiles) * 100));
  return null;
}

// ---------------------------------------------------------------------------
// Requests

export interface CreateBackupInput {
  /** Arc's SQLite database: tokens, retention policies, continuous queries, the audit log. */
  includeMetadata: boolean;
  /** arc.toml, which holds the credentials of any remote backup destination. */
  includeConfig: boolean;
}

export interface RestoreInput {
  restoreData: boolean;
  restoreMetadata: boolean;
  restoreConfig: boolean;
}

/** Validate a request body from the browser; null when it is not one. */
export function parseCreateInput(raw: unknown): CreateBackupInput | null {
  const o = obj(raw);
  if (!o || typeof o.includeMetadata !== 'boolean' || typeof o.includeConfig !== 'boolean') return null;
  return { includeMetadata: o.includeMetadata, includeConfig: o.includeConfig };
}

export function parseRestoreInput(raw: unknown): RestoreInput | null {
  const o = obj(raw);
  if (!o || typeof o.restoreData !== 'boolean' || typeof o.restoreMetadata !== 'boolean' || typeof o.restoreConfig !== 'boolean') return null;
  if (!o.restoreData && !o.restoreMetadata && !o.restoreConfig) return null;
  return { restoreData: o.restoreData, restoreMetadata: o.restoreMetadata, restoreConfig: o.restoreConfig };
}

/**
 * Both flags are always sent, so the backup is what the admin chose on every
 * Arc version: v26.09.4 includes arc.toml unless told not to, and main does
 * unless a destination is remote.
 */
export function createBackupBody(input: CreateBackupInput): Record<string, boolean> {
  return { include_metadata: input.includeMetadata, include_config: input.includeConfig };
}

/**
 * The restore request. All three flags are sent for the same reason. `mode`
 * is not: Arc resolves it from the backup's scope and echoes it, and v26.09.4
 * has no modes.
 */
export function restoreBody(id: string, input: RestoreInput): Record<string, unknown> {
  return {
    backup_id: id,
    restore_data: input.restoreData,
    restore_metadata: input.restoreMetadata,
    restore_config: input.restoreConfig,
    confirm: true,
  };
}

/**
 * What a restore will do, in the order it happens, for the confirmation.
 * `clustered`: Arc refuses the metadata and the config on a cluster node,
 * which the dialog does not offer there.
 */
export function restoreImpact(d: Pick<BackupDetail, 'scope' | 'databases' | 'hasMetadata' | 'hasConfig' | 'missingFiles'>, input: RestoreInput, clustered: boolean): string[] {
  const lines: string[] = [];
  if (input.restoreData) {
    const dbs = d.scope.length ? d.scope : d.databases.map((x) => x.name);
    const which = dbs.length ? `${dbs.length === 1 ? 'database' : 'databases'} ${dbs.join(', ')}` : 'every database in the backup';
    if (clustered && d.scope.length) {
      // Arc main resolves a scoped restore on a cluster node to "replace"
      // (internal/backup/restore.go ResolveRestoreMode); v26.09.x has no modes.
      lines.push(`Data of ${which}: Arc replaces the current files of each with the backup's (an Arc without restore modes adds them instead). It says which once the restore starts.`);
    } else {
      lines.push(`Data of ${which} is copied back. Files are added, not removed: data written since the backup stays, and data deleted since the backup comes back.`);
    }
    if (d.missingFiles > 0) lines.push(`The backup is incomplete: ${d.missingFiles} data ${d.missingFiles === 1 ? 'file was' : 'files were'} not stored, so ${d.missingFiles === 1 ? 'it' : 'they'} cannot be restored.`);
  }
  if (input.restoreMetadata && d.hasMetadata && !clustered) {
    lines.push('Arc\'s metadata (tokens, retention policies, continuous queries, audit log) is replaced with the backup\'s at the next restart. Tokens created since the backup stop working then, Launchpad\'s included if it is one of them.');
  }
  if (input.restoreConfig && d.hasConfig && !clustered) {
    lines.push('arc.toml is replaced with the backup\'s, and takes effect at the next restart.');
  }
  return lines;
}

// ---------------------------------------------------------------------------
// API contract between Launchpad's backup routes and the Backups view

/** Where Arc runs backups: the endpoint, or a cluster's primary writer. */
export interface BackupNode {
  nodeId: string;
  /** host:port. */
  source: string;
  clustered: boolean;
}

export interface BackupsView extends BackupList {
  node: BackupNode;
  progress: BackupProgress;
  fetchedAt: number;
}

export interface ProgressView {
  node: BackupNode;
  progress: BackupProgress;
  fetchedAt: number;
}

export interface BackupDetailView {
  node: BackupNode;
  backup: BackupDetail;
}

/** What happened to a create, delete or restore. */
export type ActionResult =
  /** Arc accepted it: a backup or restore started, or the backup was deleted. */
  | 'done'
  /** Another backup, restore or delete holds Arc's one operation slot. */
  | 'busy'
  /** Arc refused it; `message` is Arc's reason. */
  | 'refused';

export interface ActionOutcome {
  result: ActionResult;
  message: string;
  /** Restore: Arc needs a restart for the metadata or config to apply. */
  restartRequired: boolean;
  /** Restore: the mode Arc runs it in, when it says (Arc main). */
  mode: string | null;
}

const OPERATION_TEXT: Record<string, string> = { backup: 'A backup', restore: 'A restore', delete: 'A backup deletion' };

/** The sentence for Arc's 409: its single operation slot is taken. */
export function busyMessage(operation: unknown): string {
  const what = typeof operation === 'string' ? OPERATION_TEXT[operation] : undefined;
  return `${what ?? 'Another backup operation'} is already running on Arc. Wait for it to finish, then try again.`;
}

/** Progress in a sentence, for the status card. */
export function describeProgress(p: BackupProgress): string {
  if (p.status === 'idle') return 'No backup or restore has run since Arc last started.';
  const what = p.operation === 'restore' ? 'Restore' : 'Backup';
  const of = p.backupId ? ` ${p.backupId}` : '';
  if (p.status === 'running') return `${what}${of} is running.`;
  if (p.status === 'completed') {
    const skipped = p.skippedFiles > 0 ? ` ${p.skippedFiles} ${p.skippedFiles === 1 ? 'file was' : 'files were'} skipped.` : '';
    const missing = p.missingFiles > 0 ? ` ${p.missingFiles} ${p.missingFiles === 1 ? 'file listed in the backup is' : 'files listed in the backup are'} missing from it.` : '';
    return `${what}${of} completed.${skipped}${missing}`;
  }
  return `${what}${of} failed${p.error ? `: ${p.error}` : '.'}`;
}
