import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const membership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, locals.user.id) as { role: string } | undefined;

  if (!membership) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const members = db.prepare(`
    SELECT u.id, u.email, TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS name, m.role, m.created_at
    FROM org_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ?
    ORDER BY
      CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
      m.created_at
  `).all(params.org_id);

  return json({ members });
};
