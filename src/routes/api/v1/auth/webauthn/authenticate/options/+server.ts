import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { generateAuthenticationChallenge } from '$lib/server/webauthn';
import { isRateLimited } from '$lib/server/ratelimit';

export const POST: RequestHandler = async ({ getClientAddress }) => {
  const ip = getClientAddress();

  if (isRateLimited(`webauthn_auth:${ip}`, 10, 15 * 60 * 1000)) {
    return json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
  }

  const { options, challengeId } = await generateAuthenticationChallenge();

  return json({ options, challengeId });
};
