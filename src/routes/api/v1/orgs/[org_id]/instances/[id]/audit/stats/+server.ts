import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clusterOptions } from '$lib/server/arcConnection';
import { getAuditStats, parseStatsQuery } from '$lib/server/auditLog';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { clusterErrorResponse } from '$lib/server/clusterResponse';

/** Arc audit event counts per type, summed over every node (#12). Owner/admin, as in Arc. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  const query = parseStatsQuery(url);
  if (typeof query === 'string') return json({ error: 'bad_request', message: query }, { status: 400 });
  try {
    return json(await getAuditStats(access.instance, query, clusterOptions()), { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
