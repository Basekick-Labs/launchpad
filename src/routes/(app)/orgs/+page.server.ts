import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) {
    throw redirect(302, '/login');
  }
  if (!locals.user.is_operator) {
    throw redirect(302, '/dashboard');
  }
  return {
    currentUserId: locals.user.id,
  };
};
