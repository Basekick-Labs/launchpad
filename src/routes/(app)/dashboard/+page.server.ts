import type { PageServerLoad } from './$types';
import { listInstances } from '$lib/server/instance';
import { getDb } from '$lib/server/db';
import { resolveActiveOrg } from '$lib/server/activeOrg';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  const { org } = resolveActiveOrg(locals.user!.id, cookies);
  if (!org) {
    return { instances: [], memberCount: 0 };
  }

  const db = getDb();
  const instances = listInstances(org.id);

  const memberCount = (db.prepare(
    'SELECT COUNT(*) as count FROM org_members WHERE org_id = ?'
  ).get(org.id) as { count: number }).count;

  return {
    instances,
    memberCount,
  };
};
