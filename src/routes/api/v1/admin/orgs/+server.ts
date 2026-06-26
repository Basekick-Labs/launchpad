import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '$lib/server/db';
import { logOperatorAction } from '$lib/server/audit';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.is_operator) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = getDb();
  const orgs = db.prepare(`
    SELECT
      o.id, o.name, o.created_at, o.owner_user_id,
      owner.email AS owner_email,
      (SELECT COUNT(*) FROM org_members m WHERE m.org_id = o.id) AS member_count,
      (SELECT COUNT(*) FROM instances i WHERE i.org_id = o.id AND i.deleted_at IS NULL) AS instance_count
    FROM organizations o
    LEFT JOIN users owner ON owner.id = o.owner_user_id
    ORDER BY o.created_at ASC
  `).all();

  return json({ orgs });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user?.is_operator) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const { name, owner_user_id } = await request.json();
  if (!name || typeof name !== 'string' || !name.trim()) {
    return json({ error: 'Organization name is required' }, { status: 400 });
  }

  const db = getDb();

  // The owner defaults to the creating super-admin, or an explicit existing user.
  const ownerId = owner_user_id || locals.user.id;
  const owner = db.prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL').get(ownerId);
  if (!owner) {
    return json({ error: 'Owner user not found' }, { status: 400 });
  }

  const orgId = uuidv4();
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)')
    .run(orgId, name.trim(), ownerId);
  db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')")
    .run(orgId, ownerId);

  logOperatorAction(locals.user.id, 'create_org', 'org', orgId, { name: name.trim(), owner: ownerId });

  return json({ org: { id: orgId, name: name.trim() } }, { status: 201 });
};
