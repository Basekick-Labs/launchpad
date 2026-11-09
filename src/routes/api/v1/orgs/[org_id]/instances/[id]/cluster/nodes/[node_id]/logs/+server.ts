import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clusterOptions } from '$lib/server/arcConnection';
import { getNodeLogs } from '$lib/server/clusterNodes';
import { clusterErrorResponse } from '$lib/server/clusterResponse';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { intParam } from '$lib/server/util';
import { LOG_LEVELS, LOG_LIMIT_MAX, LOG_SINCE_MAX_MINUTES, NODE_ID_RE, type LogLevel, type NodeLogsData } from '$lib/cluster';

/** One node's Arc application logs (#7). Owner/admin, as in Arc. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  if (!NODE_ID_RE.test(params.node_id)) return json({ error: 'not_found', message: 'Invalid node id' }, { status: 404 });

  const limit = intParam(url, 'limit', 200, 1, LOG_LIMIT_MAX);
  const sinceMinutes = intParam(url, 'since', 60, 1, LOG_SINCE_MAX_MINUTES);
  const levelRaw = url.searchParams.get('level')?.toLowerCase() ?? null;
  const level = levelRaw && (LOG_LEVELS as readonly string[]).includes(levelRaw) ? (levelRaw as LogLevel) : null;
  if (limit === null || sinceMinutes === null || (levelRaw && !level)) {
    return json({
      error: 'bad_request',
      message: `limit 1-${LOG_LIMIT_MAX}, since 1-${LOG_SINCE_MAX_MINUTES} minutes, level ${LOG_LEVELS.join('|')}`,
    }, { status: 400 });
  }
  try {
    const logs = await getNodeLogs(access.instance, params.node_id, { limit, level, sinceMinutes }, clusterOptions());
    const body: NodeLogsData = { ...logs, servedAt: Date.now() };
    // Arc logs can carry SQL and internal addresses.
    return json(body, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
