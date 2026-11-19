import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clusterOptions } from '$lib/server/arcConnection';
import { restoreBackup } from '$lib/server/backups';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { clusterErrorResponse } from '$lib/server/clusterResponse';
import { readBoundedJsonBody } from '$lib/server/util';
import { BACKUP_ID_RE, parseRestoreInput } from '$lib/backup';

/** Three booleans. */
const MAX_BODY_BYTES = 1024;

/**
 * Restore a backup: `{ restoreData, restoreMetadata, restoreConfig }`, at
 * least one true (#13). Owner/admin. Recorded in the change log.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  if (!BACKUP_ID_RE.test(params.backup_id)) return json({ error: 'not_found', message: 'Invalid backup id' }, { status: 404 });
  // Bounded and content-type checked (413/415/400 on a bad body).
  const input = parseRestoreInput(await readBoundedJsonBody(request, MAX_BODY_BYTES));
  if (!input) {
    return json({ error: 'bad_request', message: 'restoreData, restoreMetadata and restoreConfig must be true or false, and one must be true' }, { status: 400 });
  }
  try {
    return json(await restoreBackup(access.instance, params.backup_id, input, locals.user!.id, clusterOptions()), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
