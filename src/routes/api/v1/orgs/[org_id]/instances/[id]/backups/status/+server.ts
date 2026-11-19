import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clusterOptions } from '$lib/server/arcConnection';
import { getBackupProgress } from '$lib/server/backups';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { clusterErrorResponse } from '$lib/server/clusterResponse';

/** The running or last backup or restore (#13), which the Backups view polls while one runs. Owner/admin. */
export const GET: RequestHandler = async ({ locals, params }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  try {
    return json(await getBackupProgress(access.instance, clusterOptions()), { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
