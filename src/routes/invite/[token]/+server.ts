import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
import { getDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ params, locals, cookies }) => {
  const db = getDb();

  const invitation = db.prepare(`
    SELECT i.*, o.name as org_name
    FROM org_invitations i
    JOIN organizations o ON o.id = i.org_id
    WHERE i.token = ?
  `).get(params.token) as any;

  if (!invitation) {
    throw redirect(302, '/login?error=invite_invalid');
  }

  if (new Date(invitation.expires_at) < new Date()) {
    db.prepare('DELETE FROM org_invitations WHERE id = ?').run(invitation.id);
    throw redirect(302, '/login?error=invite_expired');
  }

  // User is logged in — accept the invite directly
  if (locals.user) {
    // Verify the logged-in user's email matches the invitation
    if (locals.user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw redirect(302, `/login?error=invite_wrong_account`);
    }

    // Atomically add member + delete invitation (prevents double-click race)
    const acceptInvite = db.transaction(() => {
      db.prepare(
        "INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)"
      ).run(invitation.org_id, locals.user!.id, invitation.role);
      if (invitation.grant_operator) {
        db.prepare(
          "UPDATE users SET is_operator = 1, token_version = token_version + 1 WHERE id = ?"
        ).run(locals.user!.id);
      }
      db.prepare('DELETE FROM org_invitations WHERE id = ?').run(invitation.id);
    });
    acceptInvite();

    // Clear pending invite cookie if it exists
    cookies.delete('arc_pending_invite', { path: '/' });

    throw redirect(302, `/dashboard?joined=${encodeURIComponent(invitation.org_name)}`);
  }

  // User is NOT logged in — store invite token in cookie and redirect to auth
  cookies.set('arc_pending_invite', params.token, {
    path: '/',
    httpOnly: true,
    secure: !dev,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24, // 1 day
  });

  // Check if user with this email already exists
  const existingUser = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?')
    .get(invitation.email.toLowerCase());

  if (existingUser) {
    const loginParams = new URLSearchParams({
      email: invitation.email,
      org: invitation.org_name,
    });
    throw redirect(302, `/login?${loginParams.toString()}`);
  } else {
    const signupParams = new URLSearchParams({
      email: invitation.email,
      org: invitation.org_name,
    });
    throw redirect(302, `/signup?${signupParams.toString()}`);
  }
};
