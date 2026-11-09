/**
 * The instance change log: Arc changes made through Launchpad, attributed to
 * the Launchpad user. Owner/admin only to read (paths name databases, tokens
 * and RBAC structure). Free of $env imports so it is unit tested.
 */

import { getDb } from './db.js';

export type ChangeOutcome = 'ok' | 'error' | 'unknown';

export interface ChangeRecord {
  instanceId: string;
  actorUserId: string;
  method: string;
  /** Canonical Arc path, never a query string or a body. */
  path: string;
  /** Arc's HTTP status; null when Arc never answered. */
  status: number | null;
}

export interface ChangeEntry {
  id: number;
  method: string;
  path: string;
  status: number | null;
  outcome: ChangeOutcome;
  createdAt: string;
  actor: { id: string; email: string; name: string | null } | null;
}

/** How a status reads in the log: 2xx ok, a definite refusal error, no answer unknown. */
export function outcomeFor(status: number | null): ChangeOutcome {
  if (status === null || status >= 500) return 'unknown';
  return status >= 200 && status < 300 ? 'ok' : 'error';
}

const MAX_PATH = 512;

/**
 * Record a change. Never throws: a failing log write must not turn a change
 * that already happened in Arc into an error for the user.
 */
export function recordChange(r: ChangeRecord): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO instance_change_log (instance_id, actor_user_id, method, path, status, outcome)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(r.instanceId, r.actorUserId, r.method.toUpperCase().slice(0, 16), `/${r.path}`.slice(0, MAX_PATH), r.status, outcomeFor(r.status));
  } catch (err) {
    console.error('[change-log] could not record change', {
      instance_id: r.instanceId,
      method: r.method,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const CHANGE_LOG_PAGE = 50;

/** Newest first; `beforeId` pages back. */
export function listChanges(instanceId: string, beforeId: number | null, limit = CHANGE_LOG_PAGE): ChangeEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT l.id, l.method, l.path, l.status, l.outcome, l.created_at,
              u.id AS user_id, u.email, TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS name
       FROM instance_change_log l
       LEFT JOIN users u ON u.id = l.actor_user_id
       WHERE l.instance_id = ? AND (? IS NULL OR l.id < ?)
       ORDER BY l.id DESC
       LIMIT ?`,
    )
    .all(instanceId, beforeId, beforeId, limit) as Array<{
      id: number; method: string; path: string; status: number | null; outcome: ChangeOutcome; created_at: string;
      user_id: string | null; email: string | null; name: string | null;
    }>;
  return rows.map((r) => ({
    id: r.id,
    method: r.method,
    path: r.path,
    status: r.status,
    outcome: r.outcome,
    createdAt: r.created_at,
    actor: r.user_id ? { id: r.user_id, email: r.email ?? '', name: r.name || null } : null,
  }));
}
