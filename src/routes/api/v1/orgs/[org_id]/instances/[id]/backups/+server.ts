import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clusterOptions } from '$lib/server/arcConnection';
import { createBackup, getBackupsView } from '$lib/server/backups';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { clusterErrorResponse } from '$lib/server/clusterResponse';
import { readBoundedJsonBody } from '$lib/server/util';
import { parseCreateInput } from '$lib/backup';

/** Two booleans. */
const MAX_BODY_BYTES = 1024;

/**
 * Arc's backups and its running or last backup operation (#13), read from the
 * node that runs them. Owner/admin, as in Arc. Shared and cached, so not tied
 * to request.signal.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  try {
    return json(await getBackupsView(access.instance, clusterOptions()), { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return clusterErrorResponse(err);
  }
};

/** Start a whole-instance backup: `{ includeMetadata, includeConfig }`. Owner/admin. Recorded in the change log. */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  // Bounded and content-type checked (413/415/400 on a bad body).
  const input = parseCreateInput(await readBoundedJsonBody(request, MAX_BODY_BYTES));
  if (!input) return json({ error: 'bad_request', message: 'includeMetadata and includeConfig must be true or false' }, { status: 400 });
  try {
    return json(await createBackup(access.instance, input, locals.user!.id, clusterOptions()), { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return clusterErrorResponse(err);
  }
};
