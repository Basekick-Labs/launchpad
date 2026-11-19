import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clusterOptions } from '$lib/server/arcConnection';
import { deleteBackup, getBackupDetail } from '$lib/server/backups';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { clusterErrorResponse } from '$lib/server/clusterResponse';
import { BACKUP_ID_RE } from '$lib/backup';

/** An id Arc could not have written: nothing to find (Arc itself answers 400). */
const invalid = (id: string) => (BACKUP_ID_RE.test(id) ? null : json({ error: 'not_found', message: 'Invalid backup id' }, { status: 404 }));

/** One backup's manifest (#13). Owner/admin. */
export const GET: RequestHandler = async ({ locals, params, request }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  const bad = invalid(params.backup_id);
  if (bad) return bad;
  try {
    return json(await getBackupDetail(access.instance, params.backup_id, clusterOptions(), request.signal), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    return clusterErrorResponse(err);
  }
};

/** Delete a backup from Arc's destination (#13). Owner/admin. Recorded in the change log. */
export const DELETE: RequestHandler = async ({ locals, params }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  const bad = invalid(params.backup_id);
  if (bad) return bad;
  try {
    return json(await deleteBackup(access.instance, params.backup_id, locals.user!.id, clusterOptions()), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
