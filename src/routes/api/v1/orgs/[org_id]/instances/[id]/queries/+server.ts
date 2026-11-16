import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clusterOptions } from '$lib/server/arcConnection';
import { getQueriesView } from '$lib/server/queryManagement';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { clusterErrorResponse } from '$lib/server/clusterResponse';
import type { QueriesView } from '$lib/queryManagement';

/**
 * Running and recently finished Arc queries on every node of the instance
 * (#11). Owner/admin, as in Arc. Shared and cached, so not tied to
 * request.signal.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  try {
    const body: QueriesView = { ...(await getQueriesView(access.instance, clusterOptions())), servedAt: Date.now() };
    // Queries carry SQL, token names and client addresses.
    return json(body, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
