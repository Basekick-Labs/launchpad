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

  if (isRateLimited(`github_oauth_callback:${ip}`, 10, 15 * 60 * 1000)) {
    return new Response('Too many requests. Please try again later.', { status: 429 });
  }

  const GITHUB_CLIENT_ID = env.GITHUB_CLIENT_ID || '';
  const GITHUB_CLIENT_SECRET = env.GITHUB_CLIENT_SECRET || '';
  const BASE_URL = env.LAUNCHPAD_BASE_URL || 'http://localhost:5173';
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const storedState = cookies.get('github_oauth_state');

  if (!code || !state || state !== storedState) {
    throw redirect(302, '/login?error=oauth_failed');
  }
  cookies.delete('github_oauth_state', { path: '/' });

  // Exchange code for access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${BASE_URL}/auth/callback/github`,
    }),
  });
  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    throw redirect(302, '/login?error=oauth_failed');
  }

  const ghHeaders = { Authorization: `Bearer ${tokenData.access_token}` };

  // Fetch GitHub user profile
  const userRes = await fetch('https://api.github.com/user', { headers: ghHeaders });
  const githubUser = await userRes.json();

  // Fetch verified email if profile email is private
  let email = githubUser.email;
  if (!email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', { headers: ghHeaders });
    const emails = await emailsRes.json();
    const primary = emails.find((e: any) => e.primary && e.verified);
    email = primary?.email;
  }

  if (!email) {
    throw redirect(302, '/login?error=no_email');
  }

  const githubId = String(githubUser.id);
  const ghName = githubUser.name || githubUser.login || '';
  // Split GitHub display name into first/last (best-effort)
  const nameParts = ghName.trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

  const db = getDb();

  // Lookup by github_id first, then email
  let user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) as any;

  if (!user) {
    const existingByEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    if (existingByEmail) {
      // Account exists with this email but no GitHub link — require password login first
      // to prevent account takeover via email matching
      throw redirect(302, '/login?error=email_exists&hint=github');
    }
  }

  // Create new user if not found
  if (!user) {
    // First-run bootstrap: the first account on an empty database becomes admin.
    // After that, account creation is invitation-only.
    const userCount = (db.prepare(
      'SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL'
    ).get() as { count: number }).count;
    if (userCount > 0) {
      throw redirect(302, '/login?error=signups_closed');
    }

    const userId = uuidv4();
    db.prepare(
      'INSERT INTO users (id, email, password_hash, first_name, last_name, github_id, email_verified, is_operator) VALUES (?, ?, NULL, ?, ?, ?, 1, 1)'
    ).run(userId, email, firstName, lastName || null, githubId);


    const orgId = uuidv4();
    const orgName = ghName ? `${ghName}'s Organization` : 'My Organization';
    db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(orgId, orgName, userId);
    db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')").run(orgId, userId);

    user = { id: userId, email, first_name: firstName, last_name: lastName };

    sendWelcomeEmail(email).catch(() => {}); // fire-and-forget
  }

  // Block suspended/deleted users from logging in via OAuth
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

  // Check for pending invite — redirect to accept it instead of dashboard
  const pendingInvite = cookies.get('arc_pending_invite');
  if (pendingInvite) {
    throw redirect(302, `/invite/${pendingInvite}`);
  }

  throw redirect(302, '/dashboard');
};
