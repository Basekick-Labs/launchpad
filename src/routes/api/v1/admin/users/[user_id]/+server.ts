import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { logOperatorAction } from '$lib/server/audit';

function countOtherAdmins(db: ReturnType<typeof getDb>, excludeUserId: string): number {
  return (db.prepare(
    'SELECT COUNT(*) as count FROM users WHERE is_operator = 1 AND deleted_at IS NULL AND id != ?'
  ).get(excludeUserId) as { count: number }).count;
}

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user?.is_operator) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = getDb();
  const target = db.prepare(
    'SELECT id, is_operator, suspended_at FROM users WHERE id = ? AND deleted_at IS NULL'
  ).get(params.user_id) as { id: string; is_operator: number; suspended_at: string | null } | undefined;
  if (!target) {
    return json({ error: 'User not found' }, { status: 404 });
  }

  const body = await request.json();
  const changes: Record<string, unknown> = {};

  // Toggle admin (is_operator)
  if (typeof body.is_operator === 'boolean') {
    // Don't allow removing the last admin.
    if (!body.is_operator && target.is_operator === 1 && countOtherAdmins(db, target.id) === 0) {
      return json({ error: 'Cannot remove the last administrator.' }, { status: 400 });
    }
    db.prepare(
      "UPDATE users SET is_operator = ?, token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?"
    ).run(body.is_operator ? 1 : 0, target.id);
    changes.is_operator = body.is_operator;
  }

  // Suspend / unsuspend
  if (typeof body.suspended === 'boolean') {
    if (body.suspended && target.id === locals.user.id) {
      return json({ error: 'You cannot suspend your own account.' }, { status: 400 });
    }
    if (body.suspended) {
      db.prepare(
        "UPDATE users SET suspended_at = datetime('now'), token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?"
      ).run(target.id);
    } else {
      db.prepare(
        "UPDATE users SET suspended_at = NULL, updated_at = datetime('now') WHERE id = ?"
      ).run(target.id);
    }
    changes.suspended = body.suspended;
  }

  if (Object.keys(changes).length === 0) {
    return json({ error: 'No changes requested.' }, { status: 400 });
  }

  logOperatorAction(locals.user.id, 'update_user', 'user', target.id, changes);

  const updated = db.prepare(
    'SELECT id, email, first_name, last_name, is_operator, email_verified, suspended_at, deleted_at, created_at FROM users WHERE id = ?'
  ).get(target.id);
  return json({ user: updated });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user?.is_operator) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = getDb();
  const target = db.prepare(
    'SELECT id, is_operator FROM users WHERE id = ? AND deleted_at IS NULL'
  ).get(params.user_id) as { id: string; is_operator: number } | undefined;
  if (!target) {
    return json({ error: 'User not found' }, { status: 404 });
  }

  if (target.id === locals.user.id) {
    return json({ error: 'You cannot delete your own account.' }, { status: 400 });
  }
  if (target.is_operator === 1 && countOtherAdmins(db, target.id) === 0) {
    return json({ error: 'Cannot delete the last administrator.' }, { status: 400 });
  }

  // Soft-delete and revoke sessions. Remove org memberships so freed orgs don't
  // retain a phantom member.
  db.prepare(
    "UPDATE users SET deleted_at = datetime('now'), token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?"
  ).run(target.id);
  db.prepare('DELETE FROM org_members WHERE user_id = ?').run(target.id);

  logOperatorAction(locals.user.id, 'delete_user', 'user', target.id, null);

  return json({ ok: true });
};
