import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ACTIVE_ORG_COOKIE } from '$lib/server/activeOrg';
import { dev } from '$app/environment';

export const POST: RequestHandler = async ({ locals, request, cookies }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { org_id } = await request.json();
  if (!org_id) {
    return json({ error: 'org_id is required' }, { status: 400 });
  }

  // Only allow switching to an org the user actually belongs to.
  const db = getDb();
  const membership = db.prepare(
    'SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(org_id, locals.user.id);
  if (!membership) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  cookies.set(ACTIVE_ORG_COOKIE, org_id, {
    path: '/',
    httpOnly: true,
    secure: !dev,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  });

  return json({ ok: true });
};
