/**
 * Dashboard persistence. All dashboard SQL lives here; routes contain none.
 *
 * Two properties this file is built around:
 *
 * 1. **`org_id` is in the WHERE clause of every query.** Every exported
 *    function takes an {@link OrgScope}, which only `requireOrgRole` can
 *    produce — so passing an unchecked `params.org_id` is a compile error.
 *    The one exception, {@link getDashboardForUser}, takes no org at all and
 *    joins `org_members` in SQL instead; see its doc.
 *
 * 2. **One writer.** `writeHead` is the only statement in the repo that
 *    mentions `dashboards.model_json`, and it derives the projection columns
 *    and the instance refs from the same model object it serializes. Restore
 *    writes an *older* blob, so any path that set the blob without recomputing
 *    the projections would leave the list showing one title and the dashboard
 *    opening with another.
 *
 * No function here may become `async`. The 404-vs-409 disambiguation relies on
 * the UPDATE and its follow-up read happening in one synchronous transaction;
 * an `await` between them would reintroduce the race that argument rules out.
 */

import { getDb } from './db';
import {
  LIMITS,
  newDashboardUid,
  serializeForSave,
  type Dashboard,
  type DashboardRecord,
  type DashboardSummary,
  type VersionSummary,
} from '$lib/dashboard/model';
import type { OrgScope } from '$lib/roles';

/** A write lost an optimistic-concurrency check. */
export class VersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('Dashboard was modified by someone else');
    this.name = 'VersionConflictError';
  }
}

/** The dashboard, or the requested version of it, does not exist in this org. */
export class DashboardNotFoundError extends Error {
  constructor(message = 'Dashboard not found') {
    super(message);
    this.name = 'DashboardNotFoundError';
  }
}

interface DashboardRow {
  uid: string;
  org_id: string;
  title: string;
  description: string | null;
  tags: string;
  model_json: string;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToRecord(row: DashboardRow): DashboardRecord {
  return {
    uid: row.uid,
    orgId: row.org_id,
    version: row.version,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    model: JSON.parse(row.model_json) as Dashboard,
  };
}

/**
 * The single writer for dashboard content.
 *
 * Writes the blob, the projections derived from that same blob, the history
 * row for this version, and the instance refs — then prunes history. Callers
 * supply the already-incremented version.
 *
 * Must be called inside a transaction.
 */
function writeHead(args: {
  uid: string;
  orgId: OrgScope;
  model: Dashboard;
  version: number;
  userId: string;
  message: string | null;
  instanceIds: readonly string[];
  isCreate: boolean;
  createdAt?: string;
  createdBy?: string;
}): void {
  const db = getDb();
  const json = serializeForSave(args.model);
  const now = nowIso();
  const tags = JSON.stringify(args.model.tags);

  if (args.isCreate) {
    db.prepare(
      `INSERT INTO dashboards
         (uid, org_id, title, description, tags, model_json, version,
          created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      args.uid,
      args.orgId,
      args.model.title,
      args.model.description ?? null,
      tags,
      json,
      args.version,
      args.userId,
      args.userId,
      args.createdAt ?? now,
      now,
    );
  } else {
    db.prepare(
      `UPDATE dashboards
          SET title = ?, description = ?, tags = ?, model_json = ?,
              version = ?, updated_by = ?, updated_at = ?
        WHERE uid = ? AND org_id = ?`,
    ).run(
      args.model.title,
      args.model.description ?? null,
      tags,
      json,
      args.version,
      args.userId,
      now,
      args.uid,
      args.orgId,
    );
  }

  db.prepare(
    `INSERT INTO dashboard_versions
       (dashboard_uid, version, model_json, created_by, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(args.uid, args.version, json, args.userId, args.message, now);

  // Ordered by version, never by created_at: datetime('now') has one-second
  // granularity, so several saves in the same second would prune arbitrarily.
  db.prepare(
    `DELETE FROM dashboard_versions
      WHERE dashboard_uid = ?
        AND version NOT IN (
          SELECT version FROM dashboard_versions
           WHERE dashboard_uid = ?
           ORDER BY version DESC
           LIMIT ?
        )`,
  ).run(args.uid, args.uid, LIMITS.maxVersionHistory);

  db.prepare('DELETE FROM dashboard_instance_refs WHERE dashboard_uid = ?').run(args.uid);
  const insertRef = db.prepare(
    'INSERT INTO dashboard_instance_refs (dashboard_uid, instance_id) VALUES (?, ?)',
  );
  for (const id of args.instanceIds) insertRef.run(args.uid, id);
}

export function insertDashboard(args: {
  orgId: OrgScope;
  userId: string;
  model: Dashboard;
  instanceIds: readonly string[];
  /** Labels the v1 history row. Optional; the create route does not prompt. */
  message?: string | null;
}): DashboardRecord {
  const db = getDb();
  const uid = newDashboardUid();
  db.transaction(() => {
    writeHead({
      uid,
      orgId: args.orgId,
      model: args.model,
      version: 1,
      userId: args.userId,
      message: args.message ?? null,
      instanceIds: args.instanceIds,
      isCreate: true,
    });
  }).immediate();
  const created = getDashboard(args.orgId, uid);
  if (!created) throw new DashboardNotFoundError();
  return created;
}

/**
 * Identity and concurrency columns only, without the blob.
 *
 * The author checks in the PUT and DELETE handlers need exactly two fields, and
 * reaching for `getDashboard` made them `JSON.parse` up to a megabyte to read
 * one of them — on PUT, one of three separate reads of the same blob.
 */
export function getDashboardMeta(
  orgId: OrgScope,
  uid: string,
): { createdBy: string; version: number } | null {
  const db = getDb();
  const row = db
    .prepare('SELECT created_by, version FROM dashboards WHERE uid = ? AND org_id = ?')
    .get(uid, orgId) as { created_by: string; version: number } | undefined;
  return row ? { createdBy: row.created_by, version: row.version } : null;
}

export function getDashboard(orgId: OrgScope, uid: string): DashboardRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM dashboards WHERE uid = ? AND org_id = ?')
    .get(uid, orgId) as DashboardRow | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * Resolve a uid for a user WITHOUT being told which org it belongs to.
 *
 * `/d/[uid]` carries no org segment, and the org must not come from the
 * `active_org` cookie — a user in two orgs opening a link to the other one
 * would get a 404 on a dashboard they own, and the cookie is what made shared
 * links resolve differently per viewer in the first place.
 *
 * This is the only function here that does not take an {@link OrgScope}, and it
 * is safe for exactly one reason: `org_members` is in the WHERE clause, so the
 * caller cannot supply the org at all.
 */
export function getDashboardForUser(
  uid: string,
  userId: string,
): { record: DashboardRecord; role: string } | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT d.*, m.role AS member_role
         FROM dashboards d
         JOIN org_members m ON m.org_id = d.org_id AND m.user_id = ?
        WHERE d.uid = ?`,
    )
    .get(userId, uid) as (DashboardRow & { member_role: string }) | undefined;
  if (!row) return null;
  return { record: rowToRecord(row), role: row.member_role };
}

export function listDashboards(orgId: OrgScope): DashboardSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT uid, title, description, tags, version, created_by, updated_by,
              created_at, updated_at
         FROM dashboards WHERE org_id = ? ORDER BY updated_at DESC`,
    )
    .all(orgId) as Array<Omit<DashboardRow, 'org_id' | 'model_json'>>;

  // One query for the whole org rather than one per dashboard: the refs table
  // is keyed (dashboard_uid, instance_id), so this is an index scan.
  const refRows = db
    .prepare(
      `SELECT r.dashboard_uid, r.instance_id
         FROM dashboard_instance_refs r
         JOIN dashboards d ON d.uid = r.dashboard_uid
        WHERE d.org_id = ?`,
    )
    .all(orgId) as Array<{ dashboard_uid: string; instance_id: string }>;
  const refsByUid = new Map<string, string[]>();
  for (const ref of refRows) {
    const list = refsByUid.get(ref.dashboard_uid);
    if (list) list.push(ref.instance_id);
    else refsByUid.set(ref.dashboard_uid, [ref.instance_id]);
  }

  return rows.map((r) => ({
    uid: r.uid,
    title: r.title,
    description: r.description,
    tags: JSON.parse(r.tags) as string[],
    instanceIds: refsByUid.get(r.uid) ?? [],
    version: r.version,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function updateDashboard(args: {
  orgId: OrgScope;
  uid: string;
  userId: string;
  model: Dashboard;
  expectedVersion: number;
  instanceIds: readonly string[];
  message?: string | null;
}): DashboardRecord {
  const db = getDb();
  return db.transaction(() => {
    // Org in the WHERE clause here too: an unscoped lookup would answer with
    // another org's version number, turning 404-vs-409 into a cross-tenant
    // existence and edit-frequency oracle.
    const current = db
      .prepare('SELECT model_json, version, created_at, created_by FROM dashboards WHERE uid = ? AND org_id = ?')
      .get(args.uid, args.orgId) as
      | { model_json: string; version: number; created_at: string; created_by: string }
      | undefined;
    if (!current) throw new DashboardNotFoundError();
    if (current.version !== args.expectedVersion) {
      throw new VersionConflictError(current.version);
    }

    // A no-op save would otherwise burn a history slot; an editor that saves
    // on a timer would evict the real prior version within twenty keystrokes.
    if (serializeForSave(args.model) === current.model_json) {
      return getDashboard(args.orgId, args.uid)!;
    }

    writeHead({
      uid: args.uid,
      orgId: args.orgId,
      model: args.model,
      version: current.version + 1,
      userId: args.userId,
      message: args.message ?? null,
      instanceIds: args.instanceIds,
      isCreate: false,
    });
    return getDashboard(args.orgId, args.uid)!;
  }).immediate();
}

/**
 * Hard delete, with the version and instance-ref rows cascading.
 *
 * Not a soft delete: nothing un-deletes or purges a dashboard, so a tombstone
 * would keep up to {@link LIMITS.maxVersionHistory} blobs alive forever and
 * make the ON DELETE CASCADE dead code. The deletion is audited instead.
 */
export function deleteDashboard(orgId: OrgScope, uid: string): void {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM dashboards WHERE uid = ? AND org_id = ?')
    .run(uid, orgId);
  if (result.changes === 0) throw new DashboardNotFoundError();
}

export function listVersions(orgId: OrgScope, uid: string): VersionSummary[] {
  const db = getDb();
  const head = db
    .prepare('SELECT version FROM dashboards WHERE uid = ? AND org_id = ?')
    .get(uid, orgId) as { version: number } | undefined;
  if (!head) throw new DashboardNotFoundError();

  // dashboard_versions carries no org_id of its own, so every read of it joins
  // dashboards and predicates on org_id there.
  const rows = db
    .prepare(
      `SELECT v.version, v.created_by, v.created_at, v.message
         FROM dashboard_versions v
         JOIN dashboards d ON d.uid = v.dashboard_uid
        WHERE v.dashboard_uid = ? AND d.org_id = ?
        ORDER BY v.version DESC`,
    )
    .all(uid, orgId) as Array<{
    version: number;
    created_by: string;
    created_at: string;
    message: string | null;
  }>;

  return rows.map((r) => ({
    version: r.version,
    createdBy: r.created_by,
    createdAt: r.created_at,
    message: r.message,
    current: r.version === head.version,
  }));
}

/** The stored blob for one version, for the caller to re-validate before restoring. */
export function getVersionModelJson(orgId: OrgScope, uid: string, version: number): string {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT v.model_json
         FROM dashboard_versions v
         JOIN dashboards d ON d.uid = v.dashboard_uid
        WHERE v.dashboard_uid = ? AND v.version = ? AND d.org_id = ?`,
    )
    .get(uid, version, orgId) as { model_json: string } | undefined;
  if (!row) throw new DashboardNotFoundError('Version not found');
  return row.model_json;
}

/**
 * Write a previously-stored model back as a new version.
 *
 * The caller has already re-validated and re-authorized the model — restore is
 * a full write, not a copy. A stored blob can reference an instance that has
 * since left the org, or fail a validator that has since tightened, so
 * replaying the bytes verbatim would re-admit content nothing checked.
 */
export function restoreVersion(args: {
  orgId: OrgScope;
  uid: string;
  userId: string;
  model: Dashboard;
  expectedVersion: number;
  instanceIds: readonly string[];
  restoredFrom: number;
}): DashboardRecord {
  return updateDashboard({
    orgId: args.orgId,
    uid: args.uid,
    userId: args.userId,
    model: args.model,
    expectedVersion: args.expectedVersion,
    instanceIds: args.instanceIds,
    message: `Restored from version ${args.restoredFrom}`,
  });
}

/** Dashboards in this org that reference `instanceId` at any level. */
export function dashboardsUsingInstance(orgId: OrgScope, instanceId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.dashboard_uid
         FROM dashboard_instance_refs r
         JOIN dashboards d ON d.uid = r.dashboard_uid
        WHERE r.instance_id = ? AND d.org_id = ?`,
    )
    .all(instanceId, orgId) as Array<{ dashboard_uid: string }>;
  return rows.map((r) => r.dashboard_uid);
}
