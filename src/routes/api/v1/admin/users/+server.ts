import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.is_operator) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = getDb();
  const users = db.prepare(`
    SELECT id, email, first_name, last_name, is_operator, email_verified,
           suspended_at, deleted_at, created_at,
           (github_id IS NOT NULL OR google_id IS NOT NULL) as is_oauth
    FROM users
    WHERE deleted_at IS NULL
    ORDER BY created_at ASC
  `).all();

  return json({ users });
};
