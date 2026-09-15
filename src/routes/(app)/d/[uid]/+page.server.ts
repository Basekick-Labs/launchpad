import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDashboardForUser } from '$lib/server/dashboards';
import { ORG_ROLES, type OrgRole } from '$lib/roles';

/**
 * Loads the dashboard for `/d/[uid]` — a short route, Grafana-style, so shared
 * links stay compact.
 *
 * ## This load MUST NOT read `event.url`
 *
 * The page writes `?from`, `?to`, `?refresh`, `?kiosk` and `?viewPanel` with
 * `goto`, and SvelteKit re-runs a load only when something it actually USED has
 * changed — it tracks `url` and individual search params per load node. Because
 * this function destructures only `params` and `locals`, a range change issues
 * zero requests and zero database reads.
 *
 * Reading `url.searchParams` here would register that dependency and turn every
 * zoom into a round trip that re-reads the dashboard document. If this ever
 * needs a query parameter, read it in the PAGE, not here.
 *
 * ## Why there is no org in the route
 *
 * `getDashboardForUser` joins `org_members` in SQL, so the caller cannot supply
 * an org at all and a shared link resolves the same for every viewer — unlike a
 * lookup keyed on the active-org cookie, which made the same link mean different
 * things to different people. The org for the query runner and for the save call
 * therefore comes from the record, which is server-derived.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
  if (!locals.user) throw error(401, 'Not signed in');

  const found = getDashboardForUser(params.uid, locals.user.id);
  // Deliberately the same 404 whether the dashboard does not exist or the user
  // is not a member of its org: distinguishing them tells an outsider that a
  // given uid is real.
  if (!found) throw error(404, 'Dashboard not found');

  const role = (ORG_ROLES as readonly string[]).includes(found.role)
    ? (found.role as OrgRole)
    : null;

  return { record: found.record, role, user: { id: locals.user.id } };
};
