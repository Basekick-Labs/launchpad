import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clusterOptions } from '$lib/server/arcConnection';
import { getTokenUsage } from '$lib/server/governanceAdmin';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { clusterErrorResponse } from '$lib/server/clusterResponse';

/** One token's query usage on every node (#10). Owner/admin. */
export const GET: RequestHandler = async ({ locals, params }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  if (!/^[1-9]\d{0,15}$/.test(params.token_id)) return json({ error: 'not_found', message: 'Invalid token id' }, { status: 404 });
  try {
    return json({ nodes: await getTokenUsage(access.instance, Number(params.token_id), clusterOptions()) }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
