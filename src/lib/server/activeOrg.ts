import type { Cookies } from '@sveltejs/kit';
import { getDb } from './db';

export const ACTIVE_ORG_COOKIE = 'active_org';

export interface OrgSummary {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
}

/** All orgs the user belongs to, oldest first. */
export function listUserOrgs(userId: string): OrgSummary[] {
  const db = getDb();
  return db.prepare(`
    SELECT o.id, o.name, o.owner_user_id, o.created_at
    FROM organizations o
    JOIN org_members m ON o.id = m.org_id
    WHERE m.user_id = ?
    ORDER BY o.created_at
  `).all(userId) as OrgSummary[];
}

/**
 * Resolve the active org for a user from the `active_org` cookie. Falls back to
 * the first org the user belongs to if the cookie is missing or points at an
 * org the user is no longer a member of. Returns the org plus the user's role
 * in it, or null when the user has no orgs.
 */
export function resolveActiveOrg(
  userId: string,
  cookies: Cookies,
): { org: OrgSummary; role: string; orgs: OrgSummary[] } | { org: null; role: null; orgs: OrgSummary[] } {
  const orgs = listUserOrgs(userId);
  if (orgs.length === 0) {
    return { org: null, role: null, orgs };
  }

  const wanted = cookies.get(ACTIVE_ORG_COOKIE);
  const active = (wanted && orgs.find((o) => o.id === wanted)) || orgs[0];

  const db = getDb();
  const membership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(active.id, userId) as { role: string } | undefined;

  return { org: active, role: membership?.role ?? 'viewer', orgs };
}
