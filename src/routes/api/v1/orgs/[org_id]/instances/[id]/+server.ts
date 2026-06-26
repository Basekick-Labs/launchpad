import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getInstance, deleteInstance, getInstanceEvents, updateInstanceConnection } from '$lib/server/instance';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const membership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, locals.user.id);

  if (!membership) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const instance = getInstance(params.id);
  if (!instance || instance.org_id !== params.org_id) {
    return json({ error: 'Instance not found' }, { status: 404 });
  }

  const events = getInstanceEvents(params.id, 20);

  // Strip sensitive fields from response
  const { admin_token, ...safeInstance } = instance;
  return json({ instance: safeInstance, events });
};

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

  const instance = getInstance(params.id);
  if (!instance || instance.org_id !== params.org_id) {
    return json({ error: 'Instance not found' }, { status: 404 });
  }

  const { name, endpoint_url, admin_token } = await request.json();

  try {
    const updated = await updateInstanceConnection(params.id, {
      ...(name !== undefined ? { name } : {}),
      ...(endpoint_url !== undefined ? { endpointUrl: endpoint_url } : {}),
      ...(admin_token !== undefined ? { adminToken: admin_token } : {}),
    });
    const { admin_token: _t, ...safeInstance } = updated!;
    return json({ instance: safeInstance });
  } catch (err: any) {
    return json({ error: err.message }, { status: 400 });
  }
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
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

  const instance = getInstance(params.id);
  if (!instance || instance.org_id !== params.org_id) {
    return json({ error: 'Instance not found' }, { status: 404 });
  }

  await deleteInstance(params.id);

  return json({ ok: true });
};
