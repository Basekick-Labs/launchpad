import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getInstance } from '$lib/server/instance';
import { allowPrivateEndpoints } from '$lib/server/arcConnection';
import { discoverCapabilities } from '$lib/server/capabilities';
import { roleAtLeast } from '$lib/roles';
import { viewForRole } from '$lib/capabilities';

/**
 * What the connected Arc instance supports (#6), filtered for the caller's
 * role. License tier and notices go to owner/admin only. That is presentation,
 * not an access boundary: members can read Arc's /health through the proxy.
 *
 * `?refresh=1` re-probes (owner/admin only, rate-limited by the cache).
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const membership = getDb()
    .prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?')
    .get(params.org_id, locals.user.id) as { role: string } | undefined;
  if (!membership) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const instance = getInstance(params.id);
  if (!instance || instance.org_id !== params.org_id) {
    return json({ error: 'Instance not found' }, { status: 404 });
  }

  const force = url.searchParams.get('refresh') === '1' && roleAtLeast(membership.role, 'admin');
  const caps = await discoverCapabilities(instance, { allowPrivate: allowPrivateEndpoints(), force });
  return json(viewForRole(caps, membership.role));
};
