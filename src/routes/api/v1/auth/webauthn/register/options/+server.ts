import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { generateRegistrationChallenge } from '$lib/server/webauthn';
import { isRateLimited } from '$lib/server/ratelimit';

export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (isRateLimited(`webauthn_register:${locals.user.id}`, 10, 15 * 60 * 1000)) {
    return json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
  }

  const db = getDb();
  const existingCreds = db.prepare(
    'SELECT id FROM webauthn_credentials WHERE user_id = ?'
  ).all(locals.user.id) as Array<{ id: string }>;

  const displayName = [locals.user.first_name, locals.user.last_name].filter(Boolean).join(' ');

  const { options, challengeId } = await generateRegistrationChallenge(
    { id: locals.user.id, email: locals.user.email, name: displayName || locals.user.email },
    existingCreds.map(c => c.id)
  );

  return json({ options, challengeId });
};
