import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { allowPrivateEndpoints } from '$lib/server/arcConnection';
import { getClusterView } from '$lib/server/clusterNodes';
import { clusterErrorResponse } from '$lib/server/clusterResponse';
import { requireInstanceRole } from '$lib/server/orgAccess';

/**
 * Cluster topology as the instance endpoint's node sees it, plus whether
 * Launchpad can reach each node (#7). Owner/admin: it lists internal node
 * addresses. Cached 10 s and shared; not tied to request.signal for that reason.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  try {
    return json(await getClusterView(access.instance, { allowPrivate: allowPrivateEndpoints() }));
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
