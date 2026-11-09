import { json } from '@sveltejs/kit';
import { requireInstanceRole } from '$lib/server/orgAccess';
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
  // arc_version is the legacy GitHub-release guess; detected_arc_version replaces it.
  const { admin_token, arc_version, ...safeInstance } = instance;
  return json({ instance: safeInstance, events });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;

  let body: { name?: string; endpoint_url?: string; admin_token?: string | null; node_scheme?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Request body must be JSON' }, { status: 400 });
  }
  const { name, endpoint_url, admin_token, node_scheme } = body ?? {};
  if (node_scheme !== undefined && node_scheme !== null && node_scheme !== 'http' && node_scheme !== 'https') {
    return json({ error: 'node_scheme must be "http", "https" or null' }, { status: 400 });
  }

  try {
    const updated = await updateInstanceConnection(params.id, {
      ...(name !== undefined ? { name } : {}),
      ...(endpoint_url !== undefined ? { endpointUrl: endpoint_url } : {}),
      ...(admin_token !== undefined ? { adminToken: admin_token } : {}),
      ...(node_scheme !== undefined ? { nodeScheme: node_scheme } : {}),
    });
    const { admin_token: _t, arc_version: _v, ...safeInstance } = updated!;
    return json({ instance: safeInstance });
  } catch (err: any) {
    const known = err?.name === 'PrivateEndpointBlockedError' || /valid Arc server URL/i.test(err?.message || '');
    const message = known
      ? err.message
      : 'Could not update the instance. Check the endpoint URL and try again.';
    return json({ error: message }, { status: 400 });
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
