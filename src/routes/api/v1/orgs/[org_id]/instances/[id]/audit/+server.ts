import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clusterOptions } from '$lib/server/arcConnection';
import { getAuditPage, parseAuditQuery } from '$lib/server/auditLog';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { clusterErrorResponse } from '$lib/server/clusterResponse';

/** Arc audit events from every node of the instance, newest first (#12). Owner/admin, as in Arc. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  const query = parseAuditQuery(url);
  if (typeof query === 'string') return json({ error: 'bad_request', message: query }, { status: 400 });
  try {
    // Audit events carry client addresses and token names.
    return json(await getAuditPage(access.instance, query, clusterOptions()), { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
