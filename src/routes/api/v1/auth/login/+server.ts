import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { verifyPassword, createToken, sessionCookieOptions } from '$lib/server/auth';
import { createMfaToken } from '$lib/server/mfa';
import { isRateLimited } from '$lib/server/ratelimit';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
  const ip = getClientAddress();

  // Rate limit: 10 attempts per IP per 15 minutes
  if (isRateLimited(`login:${ip}`, 10, 15 * 60 * 1000)) {
    return json({ error: 'Too many login attempts. Please try again later.' }, { status: 429 });
  }

  const { email: rawEmail, password } = await request.json();

  if (!rawEmail || !password) {
    return json({ error: 'Email and password are required' }, { status: 400 });
  }

  if (password.length > 128) {
    return json({ error: 'Invalid email or password' }, { status: 401 });
  }

  const email = String(rawEmail).trim().toLowerCase();
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;

  if (!user) {
    return json({ error: 'Invalid email or password' }, { status: 401 });
  }

  if (!user.password_hash) {
    return json({ error: 'This account uses GitHub login. Please sign in with GitHub.' }, { status: 400 });
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return json({ error: 'Invalid email or password' }, { status: 401 });
  }

  if (user.deleted_at) {
    return json({ error: 'Invalid email or password' }, { status: 401 });
  }

  if (user.suspended_at) {
    return json({ error: 'This account has been suspended. Please contact support.' }, { status: 403 });
  }

  if (!user.email_verified) {
    return json({ error: 'Please verify your email before signing in.', requiresVerification: true, email: user.email }, { status: 403 });
  }

  // Check for pending invite cookie
  const pendingInvite = cookies.get('arc_pending_invite');
  const redirectTo = pendingInvite ? `/invite/${pendingInvite}` : '/dashboard';

  // MFA check — issue short-lived MFA token instead of session
  if (user.mfa_secret) {
    const mfaToken = createMfaToken(user.id);
    return json({
      requiresMfa: true,
      mfaToken,
      user: { id: user.id, email: user.email, first_name: user.first_name || '', last_name: user.last_name || '' },
      redirectTo,
    });
  }

  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const token = createToken({
    userId: user.id,
    email: user.email,
    name: displayName,
  }, user.token_version ?? 0);

  cookies.set('arc_session', token, sessionCookieOptions);

  return json({
    requiresMfa: false,
    mfaToken: null,
    user: { id: user.id, email: user.email, first_name: user.first_name || '', last_name: user.last_name || '' },
    redirectTo,
  });
};
