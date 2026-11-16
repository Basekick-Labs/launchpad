import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clusterOptions } from '$lib/server/arcConnection';
import { cancelQuery, getQueryDetail } from '$lib/server/queryManagement';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { clusterErrorResponse } from '$lib/server/clusterResponse';
import { NODE_ID_RE } from '$lib/cluster';
import { QUERY_ID_RE } from '$lib/queryManagement';

/** Ids that cannot name a node or an Arc query: nothing to find (as the Cluster node routes answer). */
function invalid(params: { node_id: string; query_id: string }): Response | null {
  if (!NODE_ID_RE.test(params.node_id)) return json({ error: 'not_found', message: 'Invalid node id' }, { status: 404 });
  if (!QUERY_ID_RE.test(params.query_id)) return json({ error: 'not_found', message: 'Invalid query id' }, { status: 404 });
  return null;
}

/** One query in full, from the node that runs or ran it (#11). Owner/admin. */
export const GET: RequestHandler = async ({ locals, params, request }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  const bad = invalid(params);
  if (bad) return bad;
  try {
    return json(await getQueryDetail(access.instance, params.node_id, params.query_id, clusterOptions(), request.signal), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    return clusterErrorResponse(err);
  }
};

/** Cancel a running query on its node (#11). Owner/admin. Recorded in the change log. */
export const DELETE: RequestHandler = async ({ locals, params }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  const bad = invalid(params);
  if (bad) return bad;
  try {
    return json(await cancelQuery(access.instance, params.node_id, params.query_id, locals.user!.id, clusterOptions()), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
