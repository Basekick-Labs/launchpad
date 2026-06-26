import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import crypto from 'crypto';
import { env } from '$env/dynamic/private';
import { isRateLimited } from '$lib/server/ratelimit';

export const GET: RequestHandler = async ({ cookies, getClientAddress }) => {
  const ip = getClientAddress();

  if (isRateLimited(`google_oauth_init:${ip}`, 10, 15 * 60 * 1000)) {
    return new Response('Too many requests. Please try again later.', { status: 429 });
  }

  const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID || '';
  const BASE_URL = env.LAUNCHPAD_BASE_URL || 'http://localhost:5173';

  if (!GOOGLE_CLIENT_ID) {
    return new Response('Google OAuth not configured', { status: 500 });
  }

  const state = crypto.randomBytes(16).toString('hex');

  cookies.set('google_oauth_state', state, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 300,
  });

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/callback/google`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
  });

  throw redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
};
