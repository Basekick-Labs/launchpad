import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { allowPrivateEndpoints } from '$lib/server/arcConnection';
import { getNodeSnapshot, SERIES_DURATIONS } from '$lib/server/clusterNodes';
import { clusterErrorResponse } from '$lib/server/clusterResponse';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { NODE_ID_RE } from '$lib/cluster';

/** One node's metrics snapshot and charted series (#7). Owner/admin. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  if (!NODE_ID_RE.test(params.node_id)) return json({ error: 'not_found', message: 'Invalid node id' }, { status: 404 });

  const duration = Number(url.searchParams.get('duration') ?? 15);
  if (!(SERIES_DURATIONS as readonly number[]).includes(duration)) {
    return json({ error: 'bad_request', message: `duration must be one of ${SERIES_DURATIONS.join(', ')}` }, { status: 400 });
  }
  try {
    return json(await getNodeSnapshot(access.instance, params.node_id, duration, { allowPrivate: allowPrivateEndpoints() }));
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
