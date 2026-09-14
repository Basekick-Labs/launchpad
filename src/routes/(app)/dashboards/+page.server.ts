import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { AccessError, requireOrgRole } from '$lib/server/orgAccess';
import { listDashboards } from '$lib/server/dashboards';
import type { DashboardSummary } from '$lib/dashboard/model';
import type { OrgRole } from '$lib/roles';

/**
 * Server-loaded so the first paint has the list, rather than a spinner.
 *
 * `await parent()` reuses the layout's already-resolved org instead of calling
 * `resolveActiveOrg` a second time — see `team/+page.server.ts` for the same
 * shape.
 *
 * On the `requireOrgRole` call: it is NOT adding an authorization check.
 * `resolveActiveOrg` already constrains the active-org cookie to orgs the user
 * belongs to, so a cookie naming someone else's org never reaches here. It is
 * called for two other reasons — it mints the `OrgScope` that org-scoped
 * queries require, and it returns a typed `OrgRole` so the page gates on the
 * same value the API will, rather than on `currentRole`, which is a bare
 * `string` that the layout defaults to `'viewer'`.
 */
export const load: PageServerLoad = async ({ parent, locals }) => {
  const { activeOrg } = await parent();

  const empty: {
    dashboards: DashboardSummary[];
    role: OrgRole | null;
    loadError: string | null;
  } = { dashboards: [], role: null, loadError: null };

  // A user can legitimately belong to no orgs; that is an empty state, not an
  // error, and reading `activeOrg.id` here would throw before any check runs.
  if (!activeOrg) return empty;

  try {
    const { orgId, role } = requireOrgRole(locals, activeOrg.id, 'viewer');
    return { dashboards: listDashboards(orgId), role, loadError: null };
  } catch (err) {
    // An AccessError is not an HttpError, so throwing it from a load would
    // render a bare 500 outside the app layout rather than a 403.
    if (err instanceof AccessError) throw error(err.status, 'No access to this organization');
    // Anything else (a locked database, a malformed row) renders in-page, so
    // the user keeps the sidebar and a way out.
    console.error('Failed to load dashboards:', err);
    return { ...empty, loadError: 'Could not load dashboards.' };
  }
};
