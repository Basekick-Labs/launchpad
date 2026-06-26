import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import crypto from 'crypto';
import { getDb } from '$lib/server/db';
import { sendInviteEmail } from '$lib/server/email';
import { logOperatorAction } from '$lib/server/audit';

const INVITE_EXPIRY_DAYS = 7;

/**
 * Invite a brand-new platform user. The invite is attached to the super-admin's
 * own org so the new account has somewhere to land; set super_admin to also grant
 * is_operator on acceptance.
 */
export const POST: RequestHandler = async ({ locals, request, url }) => {
  if (!locals.user?.is_operator) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const { email, super_admin } = await request.json();
  if (!email || typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Valid email is required' }, { status: 400 });
  }
  const normalizedEmail = email.toLowerCase().trim();
  const grantOperator = super_admin === true;

  const db = getDb();

  // Reject if an account already exists.
  const existingUser = db.prepare(
    'SELECT id FROM users WHERE LOWER(email) = ? AND deleted_at IS NULL'
  ).get(normalizedEmail);
  if (existingUser) {
    return json({ error: 'An account with this email already exists.' }, { status: 409 });
  }

  // Attach to the inviter's own org.
  const org = db.prepare(`
    SELECT o.id, o.name FROM organizations o
    JOIN org_members m ON m.org_id = o.id
    WHERE m.user_id = ? AND m.role = 'owner'
    ORDER BY o.created_at ASC LIMIT 1
  `).get(locals.user.id) as { id: string; name: string } | undefined;
  if (!org) {
    return json({ error: 'You must own an organization to invite platform users.' }, { status: 400 });
  }

  const existingInvite = db.prepare(
    "SELECT id FROM org_invitations WHERE LOWER(email) = ? AND expires_at > datetime('now')"
  ).get(normalizedEmail);
  if (existingInvite) {
    return json({ error: 'An invitation is already pending for this email.' }, { status: 409 });
  }
  db.prepare(
    "DELETE FROM org_invitations WHERE LOWER(email) = ? AND expires_at <= datetime('now')"
  ).run(normalizedEmail);

  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    'INSERT INTO org_invitations (id, org_id, email, role, token, invited_by, expires_at, grant_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, org.id, normalizedEmail, grantOperator ? 'admin' : 'member', token, locals.user.id, expiresAt, grantOperator ? 1 : 0);

  logOperatorAction(locals.user.id, 'invite_platform_user', 'user', id, { email: normalizedEmail, super_admin: grantOperator });

  const inviteUrl = `${url.origin}/invite/${token}`;
  const inviterName = [locals.user.first_name, locals.user.last_name].filter(Boolean).join(' ') || locals.user.email;
  sendInviteEmail(normalizedEmail, inviterName, org.name, grantOperator ? 'admin' : 'member', token).catch(() => {});

  return json({ invitation: { id, email: normalizedEmail, super_admin: grantOperator, inviteUrl } }, { status: 201 });
};
