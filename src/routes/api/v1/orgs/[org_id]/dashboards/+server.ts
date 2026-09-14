import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireOrgRole } from '$lib/server/orgAccess';
import { insertDashboard, listDashboards } from '$lib/server/dashboards';
import { assertInstancesInOrg } from '$lib/server/dashboardInstance';
import { readBoundedBody } from '$lib/server/util';
import { parseAndValidate } from '$lib/dashboard/validate';
import { LIMITS } from '$lib/dashboard/model';
import { toErrorResponse } from './_shared';

export const GET: RequestHandler = async ({ locals, params }) => {
  try {
    const { orgId } = requireOrgRole(locals, params.org_id, 'viewer');
    return json({ dashboards: listDashboards(orgId) });
  } catch (err) {
    return toErrorResponse(err);
  }
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  try {
    const { orgId, userId } = requireOrgRole(locals, params.org_id, 'member');

    const raw = await readBoundedBody(request, LIMITS.maxPayloadBytes);
    const result = parseAndValidate(raw);
    if (!result.ok) {
      // The validator's errors are already value-free by construction, so they
      // are forwarded verbatim — the import dialog needs the path and code.
      return json({ error: 'Invalid dashboard', errors: result.errors, truncated: result.truncated }, { status: 400 });
    }

    assertInstancesInOrg(orgId, result.referencedInstanceIds);

    const record = insertDashboard({
      orgId,
      userId,
      model: result.model,
      instanceIds: result.referencedInstanceIds,
    });
    return json({ dashboard: record, warnings: result.warnings }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
};
