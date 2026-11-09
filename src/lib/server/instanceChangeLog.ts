/**
 * The instance change log: Arc changes made through Launchpad, attributed to
 * the Launchpad user. Owner/admin only to read (paths name databases, tokens
 * and RBAC structure). Free of $env imports so it is unit tested.
 */

import type Database from 'better-sqlite3';
import { getDb } from './db.js';
import type { ChangeEntry, ChangeOutcome, ChangePage } from '../changeLog.js';

export interface ChangeRecord {
  instanceId: string;
  actorUserId: string;
  method: string;
  /** Canonical Arc path, never a query string or a body. */
  path: string;
  /** Arc's HTTP status; null when Arc never answered. */
  status: number | null;
  dryRun?: boolean;
}

/** How a status reads in the log: 2xx ok, a definite refusal error, no answer or 5xx unknown. */
export function outcomeFor(status: number | null): ChangeOutcome {
  if (status === null || status >= 500) return 'unknown';
  return status >= 200 && status < 300 ? 'ok' : 'error';
}

const MAX_PATH = 512;
export const CHANGE_LOG_PAGE = 50;
/** Rows older than this are purged. */
export const CHANGE_LOG_RETENTION_DAYS = 365;
const PURGE_BATCH = 5000;

// Prepared once per database handle (tests and the app each have one).
let stmts: { db: Database.Database; insert: Database.Statement; first: Database.Statement; before: Database.Statement; purge: Database.Statement } | null = null;

const SELECT = `SELECT l.id, l.method, l.path, l.status, l.outcome, l.dry_run, l.created_at,
         u.id AS user_id, u.email, TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS name
  FROM instance_change_log l
  LEFT JOIN users u ON u.id = l.actor_user_id`;

function statements() {
  const db = getDb();
  if (stmts?.db !== db) {
    stmts = {
      db,
      insert: db.prepare(
        `INSERT INTO instance_change_log (instance_id, actor_user_id, method, path, status, outcome, dry_run) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      // Two statements rather than "? IS NULL OR id < ?", so both seek on
      // (instance_id, id) instead of scanning everything newer than the cursor.
      first: db.prepare(`${SELECT} WHERE l.instance_id = ? ORDER BY l.id DESC LIMIT ?`),
      before: db.prepare(`${SELECT} WHERE l.instance_id = ? AND l.id < ? ORDER BY l.id DESC LIMIT ?`),
      purge: db.prepare(
        `DELETE FROM instance_change_log WHERE id IN (SELECT id FROM instance_change_log WHERE created_at < ? LIMIT ${PURGE_BATCH})`,
      ),
    };
  }
  return stmts;
}

/**
 * Record a change. Never throws: a failing log write must not turn a change
 * that already happened in Arc into an error for the user.
 */
export function recordChange(r: ChangeRecord): void {
  try {
    statements().insert.run(r.instanceId, r.actorUserId, r.method, `/${r.path}`.slice(0, MAX_PATH), r.status, outcomeFor(r.status), r.dryRun ? 1 : 0);
  } catch (err) {
    console.error('[change-log] could not record change', {
      instance_id: r.instanceId,
      method: r.method,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

type Row = {
  id: number; method: string; path: string; status: number | null; outcome: ChangeOutcome; dry_run: number; created_at: string;
  user_id: string | null; email: string | null; name: string | null;
};

/** Newest first; `beforeId` pages back. */
export function listChanges(instanceId: string, beforeId: number | null, limit = CHANGE_LOG_PAGE): ChangePage {
  const s = statements();
  // One extra row says whether there is another page.
  const rows = (beforeId === null ? s.first.all(instanceId, limit + 1) : s.before.all(instanceId, beforeId, limit + 1)) as Row[];
  const page = rows.slice(0, limit);
  const changes: ChangeEntry[] = page.map((r) => ({
    id: r.id,
    method: r.method,
    path: r.path,
    status: r.status,
    outcome: r.outcome,
    dryRun: r.dry_run === 1,
    createdAt: r.created_at,
    actor: r.user_id ? { id: r.user_id, email: r.email ?? '', name: r.name || null } : null,
  }));
  return { changes, nextBefore: rows.length > limit ? page[page.length - 1].id : null };
}

/**
 * Delete entries older than the retention window, in batches so one large
 * delete does not hold the (synchronous) database for long. Returns the count.
 */
export function purgeOldChanges(now = Date.now(), retentionDays = CHANGE_LOG_RETENTION_DAYS): number {
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const s = statements();
  let total = 0;
  for (;;) {
    const n = s.purge.run(cutoff).changes;
    total += n;
    if (n < PURGE_BATCH) return total;
  }
}
