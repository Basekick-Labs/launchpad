import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { createInstance, listInstances } from '$lib/server/instance';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify user belongs to org
  const db = getDb();
  const membership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, locals.user.id);

  if (!membership) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const instances = listInstances(params.org_id).map(
    ({ admin_token, ...safe }) => safe
  );
  return json({ instances });
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const membership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, locals.user.id) as { role: string } | undefined;

  if (!membership || !['owner', 'admin', 'member'].includes(membership.role)) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const { name, endpoint_url, admin_token: adminToken } = await request.json();

  if (!endpoint_url) {
    return json({ error: 'Arc server URL is required' }, { status: 400 });
  }

  try {
    const instance = await createInstance({
      orgId: params.org_id,
      userId: locals.user.id,
      name: name || null,
      endpointUrl: endpoint_url,
      adminToken: adminToken || null,
    });

    const { admin_token, ...safeInstance } = instance;
    return json({ instance: safeInstance }, { status: 201 });
  } catch (err: any) {
    return json({ error: err.message }, { status: 400 });
  }
};
