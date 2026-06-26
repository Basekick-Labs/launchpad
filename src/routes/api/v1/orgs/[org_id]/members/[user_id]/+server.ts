import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const callerMembership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, locals.user.id) as { role: string } | undefined;

  if (!callerMembership || callerMembership.role !== 'owner') {
    return json({ error: 'Only the owner can change roles' }, { status: 403 });
  }

  if (params.user_id === locals.user.id) {
    return json({ error: 'Cannot change your own role' }, { status: 400 });
  }

  const { role } = await request.json();
  if (!role || !['admin', 'member', 'viewer'].includes(role)) {
    return json({ error: 'Role must be admin, member, or viewer' }, { status: 400 });
  }

  const targetMembership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, params.user_id) as { role: string } | undefined;

  if (!targetMembership) {
    return json({ error: 'Member not found' }, { status: 404 });
  }

  if (targetMembership.role === 'owner') {
    return json({ error: 'Cannot change the owner role' }, { status: 403 });
  }

  db.prepare('UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?')
    .run(role, params.org_id, params.user_id);

  return json({ role });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const callerMembership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, locals.user.id) as { role: string } | undefined;

  if (!callerMembership || !['owner', 'admin'].includes(callerMembership.role)) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  if (params.user_id === locals.user.id) {
    return json({ error: 'Cannot remove yourself' }, { status: 400 });
  }

  const targetMembership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, params.user_id) as { role: string } | undefined;

  if (!targetMembership) {
    return json({ error: 'Member not found' }, { status: 404 });
  }

  if (targetMembership.role === 'owner') {
    return json({ error: 'Cannot remove the owner' }, { status: 403 });
  }

  if (callerMembership.role === 'admin' && targetMembership.role === 'admin') {
    return json({ error: 'Admins cannot remove other admins' }, { status: 403 });
  }

  db.prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?')
    .run(params.org_id, params.user_id);

  return json({ ok: true });
};
