import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const membership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, locals.user.id) as { role: string } | undefined;

  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const result = db.prepare(
    'DELETE FROM org_invitations WHERE id = ? AND org_id = ?'
  ).run(params.id, params.org_id);

  if (result.changes === 0) {
    return json({ error: 'Invitation not found' }, { status: 404 });
  }

  return json({ ok: true });
};
