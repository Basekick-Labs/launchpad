import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clusterOptions } from '$lib/server/arcConnection';
import { getClusterView } from '$lib/server/clusterNodes';
import { clusterErrorResponse } from '$lib/server/clusterResponse';
import { requireInstanceRole } from '$lib/server/orgAccess';
import type { ClusterViewData } from '$lib/cluster';

/**
 * Cluster topology as the instance endpoint's node sees it, plus whether
 * Launchpad can reach each node (#7). Owner/admin: it lists internal node
 * addresses. Shared and cached, so not tied to request.signal.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  try {
    const view = await getClusterView(access.instance, clusterOptions());
    const body: ClusterViewData = { ...view, servedAt: Date.now() };
    return json(body);
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
