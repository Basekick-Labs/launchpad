import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { listChanges } from '$lib/server/instanceChangeLog';

/**
 * The instance change log, newest first (`?before=<id>` pages back).
 * Owner/admin only: paths name databases, tokens and access-control structure.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  const raw = url.searchParams.get('before');
  if (raw !== null && !/^\d{1,15}$/.test(raw)) return json({ error: 'before must be an id' }, { status: 400 });
  return json({ changes: listChanges(access.instance.id, raw === null ? null : Number(raw)) });
};
