import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { v4 as uuidv4 } from 'uuid';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { createToken, sessionCookieOptions } from '$lib/server/auth';
import { sendWelcomeEmail } from '$lib/server/email';
import { isRateLimited } from '$lib/server/ratelimit';

export const GET: RequestHandler = async ({ url, cookies, getClientAddress }) => {
  const ip = getClientAddress();

  if (isRateLimited(`google_oauth_callback:${ip}`, 10, 15 * 60 * 1000)) {
    return new Response('Too many requests. Please try again later.', { status: 429 });
  }

  const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID || '';
  const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET || '';
  const BASE_URL = env.LAUNCHPAD_BASE_URL || 'http://localhost:5173';
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const storedState = cookies.get('google_oauth_state');

  if (!code || !state || state !== storedState) {
    throw redirect(302, '/login?error=oauth_failed');
  }
  cookies.delete('google_oauth_state', { path: '/' });

  // Exchange code for access token (Google requires form-encoded body)
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: `${BASE_URL}/auth/callback/google`,
      grant_type: 'authorization_code',
    }),
  });
  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    throw redirect(302, '/login?error=oauth_failed');
  }

  // Fetch Google user profile
  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const googleUser = await userRes.json();

  if (!googleUser.email || !googleUser.verified_email) {
    throw redirect(302, '/login?error=no_email');
  }

  const googleId = String(googleUser.id);
  const firstName = googleUser.given_name || '';
  const lastName = googleUser.family_name || '';
  // Normalize to lowercase so lookups match the password/signup paths.
  const email = String(googleUser.email).trim().toLowerCase();

  const db = getDb();

  // Lookup by google_id first, then email
  let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId) as any;

  if (!user) {
    const existingByEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    if (existingByEmail) {
      // Account exists with this email but no Google link — require password login first
      throw redirect(302, '/login?error=email_exists&hint=google');
    }
  }

  // Create new user if not found.
  if (!user) {
    // First-run bootstrap: the first account on an empty database becomes admin;
    // after that, OAuth account creation is closed (invitation-only via signup).
    // Do the count re-check and inserts atomically so two concurrent first-run
    // OAuth callbacks can't both mint an operator.
    const userId = uuidv4();
    const displayName = [firstName, lastName].filter(Boolean).join(' ');
    const orgName = displayName ? `${displayName}'s Organization` : 'My Organization';

    const createFirstUser = db.transaction((): { created: boolean } => {
      const count = (db.prepare(
        'SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL'
      ).get() as { count: number }).count;
      if (count > 0) return { created: false };

      const orgId = uuidv4();
      db.prepare(
        'INSERT INTO users (id, email, password_hash, first_name, last_name, google_id, email_verified, is_operator) VALUES (?, ?, NULL, ?, ?, ?, 1, 1)'
      ).run(userId, email, firstName, lastName || null, googleId);
      db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(orgId, orgName, userId);
      db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')").run(orgId, userId);
      return { created: true };
    });

    let created = false;
    try {
      created = createFirstUser().created;
    } catch (err) {
      // Concurrent insert won the race (UNIQUE collision) → treat as closed.
      if (!(err instanceof Error && /UNIQUE/i.test(err.message))) throw err;
    }

    if (!created) {
      throw redirect(302, '/login?error=signups_closed');
    }

    user = { id: userId, email, first_name: firstName, last_name: lastName };
    sendWelcomeEmail(email).catch(() => {}); // fire-and-forget
  }

  // Block suspended/deleted users
  if (user.suspended_at) {
    throw redirect(302, '/login?error=account_suspended');
  }
  if (user.deleted_at) {
    throw redirect(302, '/login?error=oauth_failed');
  }

  // Set JWT session cookie
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const token = createToken({ userId: user.id, email: user.email, name: displayName }, user.token_version ?? 0);
  cookies.set('arc_session', token, sessionCookieOptions);

  // Check for pending invite
  const pendingInvite = cookies.get('arc_pending_invite');
  if (pendingInvite) {
    throw redirect(302, `/invite/${pendingInvite}`);
  }

  throw redirect(302, '/dashboard');
};
