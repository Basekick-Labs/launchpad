import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { logOperatorAction } from '$lib/server/audit';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user?.is_operator) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = getDb();
  const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(params.org_id);
  if (!org) {
    return json({ error: 'Organization not found' }, { status: 404 });
  }

  const { name } = await request.json();
  if (!name || typeof name !== 'string' || !name.trim()) {
    return json({ error: 'Organization name is required' }, { status: 400 });
  }

  db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run(name.trim(), params.org_id);
  logOperatorAction(locals.user.id, 'rename_org', 'org', params.org_id, { name: name.trim() });

  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user?.is_operator) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = getDb();
  const org = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(params.org_id) as
    | { id: string; name: string }
    | undefined;
  if (!org) {
    return json({ error: 'Organization not found' }, { status: 404 });
  }

  // Removing an org drops its instance connections, members, and pending invites.
  // Connections are just stored URLs/tokens — nothing external to tear down.
  const tx = db.transaction(() => {
    db.prepare("UPDATE instances SET deleted_at = datetime('now'), status = 'deleted' WHERE org_id = ? AND deleted_at IS NULL").run(params.org_id);
    db.prepare('DELETE FROM org_invitations WHERE org_id = ?').run(params.org_id);
    db.prepare('DELETE FROM org_members WHERE org_id = ?').run(params.org_id);
    db.prepare('DELETE FROM organizations WHERE id = ?').run(params.org_id);
  });
  tx();

  logOperatorAction(locals.user.id, 'delete_org', 'org', params.org_id, { name: org.name });

  return json({ ok: true });
};
