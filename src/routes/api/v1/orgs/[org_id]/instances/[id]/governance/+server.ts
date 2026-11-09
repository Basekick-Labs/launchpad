import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clusterOptions } from '$lib/server/arcConnection';
import { getGovernanceView } from '$lib/server/governanceAdmin';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { clusterErrorResponse } from '$lib/server/clusterResponse';

/** Query governance on every node of the instance (#10). Owner/admin. */
export const GET: RequestHandler = async ({ locals, params }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  try {
    return json(await getGovernanceView(access.instance, clusterOptions()), { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
