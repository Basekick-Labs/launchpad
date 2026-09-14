import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireOrgRole } from '$lib/server/orgAccess';
import {
  DashboardNotFoundError,
  deleteDashboard,
  getDashboard,
  getDashboardMeta,
  updateDashboard,
} from '$lib/server/dashboards';
import { assertInstancesInOrg } from '$lib/server/dashboardInstance';
import { readBoundedBody } from '$lib/server/util';
import { parseAndValidate } from '$lib/dashboard/validate';
import { LIMITS } from '$lib/dashboard/model';
import { roleAtLeast } from '$lib/roles';
import { toErrorResponse, parseVersionParam } from '../_shared';

export const GET: RequestHandler = async ({ locals, params }) => {
  try {
    const { orgId } = requireOrgRole(locals, params.org_id, 'viewer');
    const record = getDashboard(orgId, params.uid!);
    if (!record) throw new DashboardNotFoundError();
    return json({ dashboard: record });
  } catch (err) {
    return toErrorResponse(err);
  }
};

export const PUT: RequestHandler = async ({ locals, params, request, url }) => {
  try {
    const { orgId, userId, role } = requireOrgRole(locals, params.org_id, 'member');

    // expectedVersion travels in the query string, NOT the body, so the body
    // stays exactly the model: the byte cap then bounds the thing it is meant
    // to bound, and there is no `version` field sitting next to the blob for a
    // careless spread to fold back into it (which is what made a restored
    // dashboard permanently unsaveable).
    //
    // Named `expectedVersion` rather than `version` because the restore route
    // has a `version` in its PATH meaning something else entirely.
    const expectedVersion = parseVersionParam(url.searchParams.get('expectedVersion') ?? undefined);
    if (Number.isNaN(expectedVersion)) {
      return json(
        { error: 'An ?expectedVersion= query parameter is required' },
        { status: 400 },
      );
    }

    const existing = getDashboardMeta(orgId, params.uid!);
    if (!existing) throw new DashboardNotFoundError();
    // Members may edit their own dashboards; changing someone else's shared
    // dashboard needs admin.
    if (existing.createdBy !== userId && !roleAtLeast(role, 'admin')) {
      return json({ error: 'Forbidden' }, { status: 403 });
    }

    const raw = await readBoundedBody(request, LIMITS.maxPayloadBytes);
    const result = parseAndValidate(raw);
    if (!result.ok) {
      return json(
        { error: 'Invalid dashboard', errors: result.errors, truncated: result.truncated },
        { status: 400 },
      );
    }

    assertInstancesInOrg(orgId, result.referencedInstanceIds);

    const record = updateDashboard({
      orgId,
      uid: params.uid!,
      userId,
      model: result.model,
      expectedVersion,
      instanceIds: result.referencedInstanceIds,
      message: url.searchParams.get('message')?.slice(0, LIMITS.maxVersionMessage) ?? null,
    });
    return json({ dashboard: record, warnings: result.warnings });
  } catch (err) {
    return toErrorResponse(err);
  }
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  try {
    const { orgId, userId, role } = requireOrgRole(locals, params.org_id, 'member');
    const existing = getDashboardMeta(orgId, params.uid!);
    if (!existing) throw new DashboardNotFoundError();
    if (existing.createdBy !== userId && !roleAtLeast(role, 'admin')) {
      return json({ error: 'Forbidden' }, { status: 403 });
    }
    deleteDashboard(orgId, params.uid!);
    return new Response(null, { status: 204 });
  } catch (err) {
    return toErrorResponse(err);
  }
};
