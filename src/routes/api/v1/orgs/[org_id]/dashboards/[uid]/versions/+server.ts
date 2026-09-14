import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireOrgRole } from '$lib/server/orgAccess';
import { listVersions } from '$lib/server/dashboards';
import { toErrorResponse } from '../../_shared';

export const GET: RequestHandler = async ({ locals, params }) => {
  try {
    const { orgId } = requireOrgRole(locals, params.org_id, 'viewer');
    return json({ versions: listVersions(orgId, params.uid!) });
  } catch (err) {
    return toErrorResponse(err);
  }
};
