import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clusterOptions } from '$lib/server/arcConnection';
import { getTokenUsage } from '$lib/server/governanceAdmin';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { clusterErrorResponse } from '$lib/server/clusterResponse';

/** One token's query usage on every node (#10). Owner/admin. */
export const GET: RequestHandler = async ({ locals, params, request }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  const tokenId = /^[1-9]\d{0,15}$/.test(params.token_id) ? Number(params.token_id) : NaN;
  if (!Number.isSafeInteger(tokenId)) return json({ error: 'bad_request', message: 'Invalid token id' }, { status: 400 });
  try {
    return json({ nodes: await getTokenUsage(access.instance, tokenId, clusterOptions(), request.signal) }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
