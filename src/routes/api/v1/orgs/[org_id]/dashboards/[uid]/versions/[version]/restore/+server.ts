import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireOrgRole } from '$lib/server/orgAccess';
import {
  DashboardNotFoundError,
  getDashboard,
  getVersionModelJson,
  restoreVersion,
} from '$lib/server/dashboards';
import { assertInstancesInOrg } from '$lib/server/dashboardInstance';
import { parseAndValidate } from '$lib/dashboard/validate';
import { roleAtLeast } from '$lib/roles';
import { toErrorResponse, parseVersionParam } from '../../../../_shared';

/**
 * Restore a stored version as a new version.
 *
 * Reads NO request body. A body-supplied dashboard uid would let a caller copy
 * another org's stored model into their own dashboard and then GET it, turning
 * a write route into a cross-tenant read primitive. Every identifier comes from
 * the path, and the version row is read through a join predicated on org_id.
 *
 * The stored blob is re-validated and re-authorized on the way out rather than
 * copied verbatim: it may reference an instance that has since left the org, or
 * fail a validator that has since tightened.
 */
export const POST: RequestHandler = async ({ locals, params, url }) => {
  try {
    const { orgId, userId, role } = requireOrgRole(locals, params.org_id, 'member');

    const version = parseVersionParam(params.version);
    if (Number.isNaN(version)) {
      return json({ error: 'Invalid version' }, { status: 400 });
    }

    const expectedVersion = Number(url.searchParams.get('version'));
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return json({ error: 'A ?version= query parameter is required' }, { status: 400 });
    }

    const existing = getDashboard(orgId, params.uid!);
    if (!existing) throw new DashboardNotFoundError();
    if (existing.createdBy !== userId && !roleAtLeast(role, 'admin')) {
      return json({ error: 'Forbidden' }, { status: 403 });
    }

    const storedJson = getVersionModelJson(orgId, params.uid!, version);
    const result = parseAndValidate(storedJson);
    if (!result.ok) {
      return json(
        {
          error: 'That version can no longer be restored',
          errors: result.errors,
          truncated: result.truncated,
        },
        { status: 409 },
      );
    }

    assertInstancesInOrg(orgId, result.referencedInstanceIds);

    const record = restoreVersion({
      orgId,
      uid: params.uid!,
      userId,
      model: result.model,
      expectedVersion,
      instanceIds: result.referencedInstanceIds,
      restoredFrom: version,
    });
    return json({ dashboard: record, warnings: result.warnings });
  } catch (err) {
    return toErrorResponse(err);
  }
};
