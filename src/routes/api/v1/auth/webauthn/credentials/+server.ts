import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const credentials = db.prepare(
    'SELECT id, name, created_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC'
  ).all(locals.user.id);

  return json({ credentials });
};
