import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
  const { currentRole } = await parent();
  if (currentRole === 'viewer') {
    throw redirect(302, '/instances');
  }
};
