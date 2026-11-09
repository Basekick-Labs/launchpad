import { json } from '@sveltejs/kit';
import { getDb } from './db.js';
import { getInstance, type Instance } from './instance.js';
import { roleAtLeast, type OrgRole } from '../roles.js';

/**
 * The auth preamble every instance-scoped route repeats: signed in, member of
 * the org with at least `minRole`, and the instance belongs to that org.
 * Returns the instance and role, or the Response to send.
 */
export function requireInstanceRole(
  user: { id: string } | null | undefined,
  orgId: string,
  instanceId: string,
  minRole: OrgRole,
): { instance: Instance; role: string } | Response {
  if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
  const membership = getDb()
    .prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?')
    .get(orgId, user.id) as { role: string } | undefined;
  if (!membership || !roleAtLeast(membership.role, minRole)) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }
  const instance = getInstance(instanceId);
  if (!instance || instance.org_id !== orgId) {
    return json({ error: 'Instance not found' }, { status: 404 });
  }
  return { instance, role: membership.role };
}
