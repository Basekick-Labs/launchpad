import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const result = db.prepare(
    'DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?'
  ).run(params.id, locals.user.id);

  if (result.changes === 0) {
    return json({ error: 'Passkey not found' }, { status: 404 });
  }

  return json({ success: true });
};
