import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const orgs = db.prepare(`
    SELECT o.* FROM organizations o
    JOIN org_members m ON o.id = m.org_id
    WHERE m.user_id = ?
    ORDER BY o.created_at
  `).all(locals.user.id);

  return json({ organizations: orgs });
};
