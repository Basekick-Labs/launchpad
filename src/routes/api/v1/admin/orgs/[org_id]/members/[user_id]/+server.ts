import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { logOperatorAction } from '$lib/server/audit';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user?.is_operator) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = getDb();
  const membership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, params.user_id) as { role: string } | undefined;
  if (!membership) {
    return json({ error: 'Member not found' }, { status: 404 });
  }

  const { role } = await request.json();
  if (!role || !['owner', 'admin', 'member', 'viewer'].includes(role)) {
    return json({ error: 'Invalid role' }, { status: 400 });
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?')
      .run(role, params.org_id, params.user_id);
    // Promoting to owner: demote the previous owner to admin and update the org's owner pointer.
    if (role === 'owner') {
      const org = db.prepare('SELECT owner_user_id FROM organizations WHERE id = ?')
        .get(params.org_id) as { owner_user_id: string } | undefined;
      if (org && org.owner_user_id !== params.user_id) {
        db.prepare("UPDATE org_members SET role = 'admin' WHERE org_id = ? AND user_id = ?")
          .run(params.org_id, org.owner_user_id);
      }
      db.prepare('UPDATE organizations SET owner_user_id = ? WHERE id = ?')
        .run(params.user_id, params.org_id);
    }
  });
  tx();

  logOperatorAction(locals.user.id, 'update_member', 'org', params.org_id, { user_id: params.user_id, role });

  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user?.is_operator) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = getDb();
  const org = db.prepare('SELECT owner_user_id FROM organizations WHERE id = ?')
    .get(params.org_id) as { owner_user_id: string } | undefined;
  if (!org) {
    return json({ error: 'Organization not found' }, { status: 404 });
  }
  if (org.owner_user_id === params.user_id) {
    return json({ error: 'Cannot remove the org owner. Assign a new owner first.' }, { status: 400 });
  }

  db.prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?')
    .run(params.org_id, params.user_id);

  logOperatorAction(locals.user.id, 'remove_member', 'org', params.org_id, { user_id: params.user_id });

  return json({ ok: true });
};
