/**
 * Arc backup and restore (#13): list backups, read one, follow the running
 * operation, and create, delete or restore a backup.
 *
 * Every request goes to the node Arc runs backups on: the endpoint of a
 * standalone instance, or a cluster's primary writer
 * (clusterNodes.pinnedPrimaryWriter), pinned and identity-checked like the
 * Cluster view. Arc main refuses a backup, restore or delete on any other
 * node, and keeps the progress of the running one in that node's memory, so
 * the load-balanced endpoint would show a random node's idle status and
 * have its changes refused.
 *
 * Every create, delete and restore sent is recorded in the instance change
 * log with the Launchpad user and its outcome. None is retried.
 *
 * Free of $env imports (the caller passes options) so it runs under vitest.
 */

import { SharedCache } from './sharedCache.js';
import { recordChange } from './instanceChangeLog.js';
import { ClusterError, fingerprint, pinnedGet, pinnedPrimaryWriter, pinnedSend, type ClusterOptions, type ClusterTarget, type NodeAnswer, type WriterNode } from './clusterNodes.js';
import { ADMIN_403 } from '../capabilities.js';
import {
  arcText,
  busyMessage,
  createBackupBody,
  parseBackupDetail,
  parseBackupList,
  parseProgress,
  restoreBody,
  type ActionOutcome,
  type BackupDetailView,
  type BackupNode,
  type BackupProgress,
  type BackupsView,
  type CreateBackupInput,
  type ProgressView,
  type RestoreInput,
} from '../backup.js';

/**
 * Arc gives the listing, a manifest read and a delete 30 s each against the
 * backup destination, which may be remote; the deadlines leave it that.
 */
const SLOW_DEADLINE_MS = 35_000;
const SLOW_IDLE_MS = 32_000;
const STATUS_DEADLINE_MS = 8000;
/** Create and restore read the manifest and check the scope before answering. */
const SEND_DEADLINE_MS = 35_000;
const LIST_MAX_BYTES = 8 * 1024 * 1024;
const DETAIL_MAX_BYTES = 8 * 1024 * 1024;
const SMALL_MAX_BYTES = 64 * 1024;
/** Under the view's refresh while an operation runs, so viewers share a read. */
const VIEW_TTL_MS = 1500;

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

type Target = WriterNode['target'];

const nodeOf = (w: WriterNode): BackupNode => ({ nodeId: w.nodeId, source: w.target.display, clustered: w.clustered });

/** Arc's own reason, from the full body (NodeAnswer.message is cut short). */
const arcReason = (a: NodeAnswer): string | null => arcText(obj(a.body)?.error);

/** Arc's 404 for a route it did not register: backups are off (backup.enabled = false). */
const routeAbsent = (a: NodeAnswer) => a.status === 404 && /^cannot (get|post|delete)\b/i.test(a.message ?? '');
/** The handlers' own 404 for an id the destination does not hold. */
const backupUnknown = (a: NodeAnswer) => a.status === 404 && /^backup not found$/i.test(a.message ?? '');

const OFF = 'Backups are turned off on this Arc: set enabled = true in the [backup] section of arc.toml, or ARC_BACKUP_ENABLED=true';

/** An answer that is not the one asked for, as the error the route returns. */
function refusalError(a: NodeAnswer): ClusterError {
  if (routeAbsent(a)) return new ClusterError('upstream_status', OFF);
  if (a.status === 401) return new ClusterError('token_rejected', 'Arc rejected the stored token');
  if (a.status === 403) {
    return new ClusterError('token_not_admin', ADMIN_403.test(a.message ?? '') ? 'Backups need an admin token' : arcReason(a) ?? 'Arc refused the request');
  }
  // Arc main's 503s name the destination that failed and what to do.
  if (a.status === 503 && arcReason(a)) return new ClusterError('upstream_status', arcReason(a) as string);
  return new ClusterError('upstream_status', `Arc answered ${a.status}`);
}

async function readProgress(target: Target, t: ClusterTarget, opts: ClusterOptions, signal: AbortSignal): Promise<BackupProgress> {
  const a = await pinnedGet(target, '/api/v1/backup/status', t, opts, signal, SMALL_MAX_BYTES);
  if (a.status !== 200) throw refusalError(a);
  const p = parseProgress(a.body);
  if (!p) throw new ClusterError('upstream_status', 'Arc returned an unreadable backup status');
  return p;
}

const viewCache = new SharedCache<BackupsView>({ ttlMs: VIEW_TTL_MS, errorTtlMs: () => 0, maxEntries: 128 });
const progressCache = new SharedCache<ProgressView>({ ttlMs: VIEW_TTL_MS, errorTtlMs: () => 0, maxEntries: 128 });

/**
 * The backups on Arc's destination and the running or last operation.
 * Shared for a moment between viewers, so it does not take a request's
 * abort signal: one viewer leaving must not fail the read for the others.
 */
export function getBackupsView(t: ClusterTarget, opts: ClusterOptions): Promise<BackupsView> {
  return viewCache.get(fingerprint(t, opts), async () => {
    const node = await pinnedPrimaryWriter(t, opts);
    const signal = AbortSignal.timeout(SLOW_DEADLINE_MS);
    const [list, progress] = await Promise.all([
      pinnedGet(node.target, '/api/v1/backup', t, opts, signal, LIST_MAX_BYTES, SLOW_IDLE_MS),
      readProgress(node.target, t, opts, signal),
    ]);
    if (list.status !== 200) throw refusalError(list);
    const parsed = parseBackupList(list.body);
    if (!parsed) throw new ClusterError('upstream_status', 'Arc returned an unreadable backup list');
    return { node: nodeOf(node), ...parsed, progress, fetchedAt: Date.now() };
  });
}

/** The running or last operation alone, which the view polls while one runs. */
export function getBackupProgress(t: ClusterTarget, opts: ClusterOptions): Promise<ProgressView> {
  return progressCache.get(fingerprint(t, opts), async () => {
    const node = await pinnedPrimaryWriter(t, opts);
    const progress = await readProgress(node.target, t, opts, AbortSignal.timeout(STATUS_DEADLINE_MS));
    return { node: nodeOf(node), progress, fetchedAt: Date.now() };
  });
}

const backupPath = (id: string) => `/api/v1/backup/${encodeURIComponent(id)}`;

/** One backup's manifest: its databases and measurements, and what it holds. */
export async function getBackupDetail(t: ClusterTarget, id: string, opts: ClusterOptions, abort?: AbortSignal): Promise<BackupDetailView> {
  const node = await pinnedPrimaryWriter(t, opts);
  const deadline = AbortSignal.timeout(SLOW_DEADLINE_MS);
  const a = await pinnedGet(node.target, backupPath(id), t, opts, abort ? AbortSignal.any([deadline, abort]) : deadline, DETAIL_MAX_BYTES, SLOW_IDLE_MS);
  if (backupUnknown(a)) throw new ClusterError('not_found', 'Arc has no backup with this id');
  if (a.status !== 200) throw refusalError(a);
  const backup = parseBackupDetail(a.body, id);
  if (!backup) throw new ClusterError('upstream_status', 'Arc returned an unreadable backup manifest');
  return { node: nodeOf(node), backup };
}

const outcome = (result: ActionOutcome['result'], message: string, extra: Partial<ActionOutcome> = {}): ActionOutcome => ({
  result,
  message,
  restartRequired: false,
  mode: null,
  ...extra,
});

/**
 * Arc's answers that settle a change other than success: the slot is taken,
 * or Arc refused it with a reason. Null when the answer settles nothing (a 5xx
 * without a reason), and a refusal Arc gives no reason for is thrown.
 */
function definite(a: NodeAnswer): ActionOutcome | null {
  if (a.status === 409) return outcome('busy', busyMessage(obj(a.body)?.operation));
  // 400: Arc validated the request (a cluster node refusing the metadata, a
  // config this node cannot write). 503 on Arc main: this node is not the
  // primary writer (a promotion since the topology was read), or the
  // destination could not be read. Each names what to do.
  const reason = arcReason(a);
  if ((a.status === 400 || a.status === 503) && reason) return outcome('refused', reason);
  if (a.status < 500) throw refusalError(a);
  return null;
}

interface Sent {
  node: WriterNode;
  answer: NodeAnswer | null;
  /** The status before sending, to tell this request's run from an earlier one. */
  before: BackupProgress | null;
  /** Where the change log points; never a body. */
  path: string;
  method: 'POST' | 'DELETE';
}

/**
 * Send one change to the backup node. Its deadline is its own, not the
 * admin's request: once sent, an abort could not unsend it, only hide its
 * outcome. Not retried: a POST that reached Arc may have started a backup.
 */
async function send(t: ClusterTarget, opts: ClusterOptions, method: 'POST' | 'DELETE', path: string, body: unknown): Promise<Sent> {
  const node = await pinnedPrimaryWriter(t, opts);
  const before = method === 'POST' ? await readProgress(node.target, t, opts, AbortSignal.timeout(STATUS_DEADLINE_MS)).catch(() => null) : null;
  let answer: NodeAnswer | null = null;
  try {
    answer = await pinnedSend(method, node.target, path, body, t, opts, AbortSignal.timeout(SEND_DEADLINE_MS), SMALL_MAX_BYTES, SLOW_IDLE_MS);
  } catch {
    answer = null; // no answer: settled by the caller reading back
  }
  viewCache.clear();
  progressCache.clear();
  return { node, answer, before, path, method };
}

/** Record a change that was sent, whatever came of it. Settled: the outcome read back after a 5xx or no answer. */
function record(s: Sent, t: ClusterTarget, actorUserId: string, settled?: 'ok' | 'error' | 'unknown'): void {
  recordChange({ instanceId: t.id, actorUserId, method: s.method, path: s.path.slice(1), status: s.answer?.status ?? null, outcome: settled });
}

/**
 * After a 5xx or no answer: whether Arc's status shows a run this request
 * started. Arc keeps one progress record, replaced when a run starts, so a
 * record of this operation (and backup, for a restore) that is not the one
 * read before sending is a new run. Null when that cannot be told.
 */
async function startedBySend(s: Sent, t: ClusterTarget, opts: ClusterOptions, operation: 'backup' | 'restore', backupId: string | null): Promise<boolean | null> {
  if (!s.before) return null;
  let p: BackupProgress;
  try {
    p = await readProgress(s.node.target, t, opts, AbortSignal.timeout(STATUS_DEADLINE_MS));
  } catch {
    return null;
  }
  const changed = p.status !== 'idle' && (p.startedAt !== s.before.startedAt || p.backupId !== s.before.backupId || p.operation !== s.before.operation);
  return changed && p.operation === operation && (backupId === null || p.backupId === backupId);
}

function unsettled(s: Sent, what: string): ClusterError {
  return s.answer
    ? new ClusterError('upstream_status', `Arc answered ${s.answer.status}; whether ${what} is not known. Check the status before trying again`)
    : new ClusterError('unreachable', `Arc did not answer; whether ${what} is not known. Check the status before trying again`);
}

/** Settle an answer that is neither success nor otherwise definite, recording it either way. */
function settleDefinite(s: Sent, t: ClusterTarget, actorUserId: string): ActionOutcome | null {
  if (!s.answer) return null;
  try {
    const d = definite(s.answer);
    if (d) record(s, t, actorUserId);
    return d;
  } catch (err) {
    record(s, t, actorUserId);
    throw err;
  }
}

/** Start a whole-instance backup on the backup node. */
export async function createBackup(t: ClusterTarget, input: CreateBackupInput, actorUserId: string, opts: ClusterOptions): Promise<ActionOutcome> {
  const s = await send(t, opts, 'POST', '/api/v1/backup', createBackupBody(input));
  if (s.answer?.status === 202) {
    record(s, t, actorUserId);
    return outcome('done', 'Backup started.');
  }
  const d = settleDefinite(s, t, actorUserId);
  if (d) return d;
  const started = await startedBySend(s, t, opts, 'backup', null);
  record(s, t, actorUserId, started ? 'ok' : 'unknown');
  if (started) return outcome('done', 'Backup started.');
  throw unsettled(s, 'the backup started');
}

/** Delete one backup from Arc's destination. */
export async function deleteBackup(t: ClusterTarget, id: string, actorUserId: string, opts: ClusterOptions): Promise<ActionOutcome> {
  const s = await send(t, opts, 'DELETE', backupPath(id), undefined);
  if (s.answer?.status === 200) {
    record(s, t, actorUserId);
    return outcome('done', `Backup ${id} deleted.`);
  }
  const d = settleDefinite(s, t, actorUserId);
  if (d) return d;
  // Arc answers every failed delete with 500 "Failed to delete backup": one
  // that removed part of it, and one of a backup that was not there (deleted
  // by someone else since the list was read). Look before saying which.
  let gone: boolean | null;
  try {
    const back = await pinnedGet(s.node.target, backupPath(id), t, opts, AbortSignal.timeout(SLOW_DEADLINE_MS), DETAIL_MAX_BYTES, SLOW_IDLE_MS);
    gone = backupUnknown(back) ? true : back.status === 200 ? false : null;
  } catch {
    gone = null;
  }
  record(s, t, actorUserId, gone ? 'ok' : gone === false ? 'error' : 'unknown');
  if (gone) return outcome('done', `Backup ${id} is no longer on Arc's backup destination.`);
  if (gone === false) {
    throw new ClusterError('upstream_status', `Arc ${s.answer ? `answered ${s.answer.status}` : 'did not answer'}, and backup ${id} is still there: some of its files may already be gone`);
  }
  throw unsettled(s, 'the backup was deleted');
}

/**
 * Restore one backup on the backup node. On a cluster, only data: Arc's
 * metadata and arc.toml are that node's own state there (its tokens, tier
 * rows and node identity), and a copy from a backup would split it from the
 * cluster. Arc main refuses both too; v26.09.x would apply them.
 */
export async function restoreBackup(t: ClusterTarget, id: string, input: RestoreInput, actorUserId: string, opts: ClusterOptions): Promise<ActionOutcome> {
  if ((input.restoreMetadata || input.restoreConfig) && (await pinnedPrimaryWriter(t, opts)).clustered) {
    return outcome('refused', 'On a cluster, only data can be restored: Arc\'s metadata and arc.toml hold each node\'s own tokens, tier records and identity.');
  }
  const s = await send(t, opts, 'POST', '/api/v1/backup/restore', restoreBody(id, input));
  if (s.answer?.status === 202) {
    record(s, t, actorUserId);
    const body = obj(s.answer.body);
    const mode = body?.mode === 'merge' || body?.mode === 'replace' ? body.mode : null;
    return outcome('done', 'Restore started.', { restartRequired: body?.restart_required === true, mode });
  }
  const d = settleDefinite(s, t, actorUserId);
  if (d) return d;
  const started = await startedBySend(s, t, opts, 'restore', id);
  record(s, t, actorUserId, started ? 'ok' : 'unknown');
  // The answer that would say whether a restart is needed was lost.
  if (started) return outcome('done', 'Restore started. If it restores Arc\'s metadata or configuration, those apply at the next restart.');
  throw unsettled(s, 'the restore started');
}

/** Test hook. */
export function resetBackupCachesForTests(): void {
  viewCache.clear();
  progressCache.clear();
}
