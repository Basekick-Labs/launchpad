import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getInstance } from '$lib/server/instance';
import { getInstanceUrl } from '$lib/server/arcConnection';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const membership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, locals.user.id) as { role: string } | undefined;

  if (!membership) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const instance = getInstance(params.id);
  if (!instance || instance.org_id !== params.org_id) {
    return json({ error: 'Instance not found' }, { status: 404 });
  }

  return json({
    url: getInstanceUrl(instance.endpoint_url),
    resource_id: instance.resource_id,
    status: instance.status,
    arc_version: instance.arc_version,
  });
};
