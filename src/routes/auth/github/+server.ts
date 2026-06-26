import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import crypto from 'crypto';
import { env } from '$env/dynamic/private';
import { isRateLimited } from '$lib/server/ratelimit';

export const GET: RequestHandler = async ({ cookies, getClientAddress }) => {
  const ip = getClientAddress();

  if (isRateLimited(`github_oauth_init:${ip}`, 10, 15 * 60 * 1000)) {
    return new Response('Too many requests. Please try again later.', { status: 429 });
  }

  const GITHUB_CLIENT_ID = env.GITHUB_CLIENT_ID || '';
  const BASE_URL = env.LAUNCHPAD_BASE_URL || 'http://localhost:5173';

  if (!GITHUB_CLIENT_ID) {
    return new Response('GitHub OAuth not configured', { status: 500 });
  }

  const state = crypto.randomBytes(16).toString('hex');

  cookies.set('github_oauth_state', state, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 300,
  });

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/callback/github`,
    scope: 'read:user user:email',
    state,
  });

  throw redirect(302, `https://github.com/login/oauth/authorize?${params}`);
};
