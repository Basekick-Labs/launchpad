import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { allowPrivateEndpoints } from '$lib/server/arcConnection';
import { getNodeLogs } from '$lib/server/clusterNodes';
import { clusterErrorResponse } from '$lib/server/clusterResponse';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { LOG_LEVELS, NODE_ID_RE, type LogLevel } from '$lib/cluster';

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,5}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/** One node's Arc application logs (#7). Owner/admin, as in Arc. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  if (!NODE_ID_RE.test(params.node_id)) return json({ error: 'not_found', message: 'Invalid node id' }, { status: 404 });

  const limit = intParam(url, 'limit', 200, 1, 1000);
  const sinceMinutes = intParam(url, 'since', 60, 1, 1440);
  const levelRaw = url.searchParams.get('level')?.toLowerCase() ?? null;
  const level = levelRaw && (LOG_LEVELS as readonly string[]).includes(levelRaw) ? (levelRaw as LogLevel) : null;
  if (limit === null || sinceMinutes === null || (levelRaw && !level)) {
    return json({ error: 'bad_request', message: 'limit 1-1000, since 1-1440 minutes, level debug|info|warn|error' }, { status: 400 });
  }
  try {
    return json(await getNodeLogs(access.instance, params.node_id, { limit, level, sinceMinutes }, { allowPrivate: allowPrivateEndpoints() }));
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
