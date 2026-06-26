import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { createToken, sessionCookieOptions } from '$lib/server/auth';
import { sendWelcomeEmail } from '$lib/server/email';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const token = url.searchParams.get('token');

  if (!token) {
    throw redirect(302, '/login?error=invalid_token');
  }

  const db = getDb();
  const row = db.prepare('SELECT * FROM email_verification_tokens WHERE token = ?').get(token) as any;

  if (!row) {
    throw redirect(302, '/login?error=invalid_token');
  }

  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM email_verification_tokens WHERE token = ?').run(token);
    throw redirect(302, '/login?error=token_expired');
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as any;

  if (!user) {
    throw redirect(302, '/login?error=invalid_token');
  }

  // Mark email as verified and clean up token
  db.prepare("UPDATE users SET email_verified = 1, updated_at = datetime('now') WHERE id = ?").run(user.id);
  db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(user.id);

  // Send personal welcome email now that they've confirmed their address
  sendWelcomeEmail(user.email).catch(() => {});

  // Set session cookie
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const sessionToken = createToken({ userId: user.id, email: user.email, name: displayName });
  cookies.set('arc_session', sessionToken, sessionCookieOptions);

  // Check for pending invite — redirect to accept it instead of dashboard
  const pendingInvite = cookies.get('arc_pending_invite');
  if (pendingInvite) {
    throw redirect(302, `/invite/${pendingInvite}`);
  }

  throw redirect(302, '/dashboard');
};
