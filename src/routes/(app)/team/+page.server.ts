import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
  const { activeOrg } = await parent();
  if (!activeOrg) throw redirect(302, '/dashboard');

  return {
    orgId: activeOrg.id,
    orgName: activeOrg.name,
  };
};
