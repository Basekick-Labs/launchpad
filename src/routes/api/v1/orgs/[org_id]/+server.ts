import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
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

  const body = await request.json();

  const allowedFields = ['name'];
  const updates: string[] = [];
  const params_: any[] = [];

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates.push(`${field} = ?`);
      params_.push(body[field].trim() || null);
    }
  }

  if (updates.length === 0) {
    return json({ error: 'No fields to update' }, { status: 400 });
  }

  params_.push(params.org_id);
  db.prepare(`UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`).run(...params_);

  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(params.org_id);
  return json({ organization: org });
};
