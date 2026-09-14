/**
 * Org membership and role checks for API routes.
 *
 * Fifteen route files currently inline `SELECT role FROM org_members WHERE
 * org_id = ? AND user_id = ?`. This is for NEW code — retrofitting those is
 * deliberately out of scope, because they are not all the same check: some gate
 * on membership alone, some on `['owner','admin']`, one on
 * `['owner','admin','member']`, and one on `role !== 'owner'`. Collapsing them
 * to an ordering would change behaviour, so that needs its own change.
 *
 * Two things this does NOT do, both on purpose:
 *
 * - **It never treats a non-member as a viewer.** `activeOrg.ts` does that when
 *   resolving the active org for a page, which is reasonable there and would be
 *   fail-open here: it would grant every signed-in user read access to every
 *   org. A missing membership row is 403.
 * - **It has no operator bypass.** `is_operator` grants nothing under
 *   `/api/v1/orgs/**` today, and adding a convenience bypass here would give
 *   every route later retrofitted onto this helper an unaudited backdoor into
 *   tenant data. Operator paths live under `/admin` and go through
 *   `logOperatorAction`.
 */

import { getDb } from './db';
import { roleAtLeast, type OrgRole, type OrgScope } from '$lib/roles';

/** Thrown on a failed access check; routes map it to a JSON response. */
export class AccessError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

export interface OrgAccess {
  /** The caller's role in the org. */
  role: OrgRole;
  userId: string;
  /** The org id, branded so it can be passed to org-scoped queries. */
  orgId: OrgScope;
}

/**
 * Assert the caller is signed in and holds at least `minRole` in `orgId`.
 *
 * `minRole` is a literal union rather than `string`, so a transposed call —
 * `requireOrgRole(locals, 'admin', orgId)` — is a compile error.
 *
 * Throws {@link AccessError}. A non-member and a nonexistent org both yield
 * 403, never 404: a 404 would be an org-existence oracle.
 */
export function requireOrgRole(
  locals: App.Locals,
  orgId: string | undefined,
  minRole: OrgRole,
): OrgAccess {
  if (!locals.user) throw new AccessError(401, 'Unauthorized');
  if (typeof orgId !== 'string' || orgId.length === 0) {
    throw new AccessError(403, 'Forbidden');
  }

  const db = getDb();
  const membership = db
    .prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?')
    .get(orgId, locals.user.id) as { role: string } | undefined;

  if (!membership) throw new AccessError(403, 'Forbidden');
  if (!roleAtLeast(membership.role, minRole)) throw new AccessError(403, 'Forbidden');

  return {
    role: membership.role as OrgRole,
    userId: locals.user.id,
    orgId: orgId as OrgScope,
  };
}
