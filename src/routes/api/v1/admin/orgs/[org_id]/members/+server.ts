import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import crypto from 'crypto';
import { getDb } from '$lib/server/db';
import { sendInviteEmail } from '$lib/server/email';
import { logOperatorAction } from '$lib/server/audit';

const INVITE_EXPIRY_DAYS = 7;

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user?.is_operator) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = getDb();
  const members = db.prepare(`
    SELECT u.id, u.email,
      TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS name,
      m.role, m.created_at
    FROM org_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? AND u.deleted_at IS NULL
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.email
  `).all(params.org_id);

  const invitations = db.prepare(`
    SELECT id, email, role, created_at, expires_at
    FROM org_invitations
    WHERE org_id = ? AND expires_at > datetime('now')
    ORDER BY created_at DESC
  `).all(params.org_id);

  return json({ members, invitations });
};

// Invite a user into THIS org (super-admin can invite any role, including owner).
export const POST: RequestHandler = async ({ locals, params, request, url }) => {
  if (!locals.user?.is_operator) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = getDb();
  const org = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(params.org_id) as
    | { id: string; name: string }
    | undefined;
  if (!org) {
    return json({ error: 'Organization not found' }, { status: 404 });
  }

  const { email, role } = await request.json();
  if (!email || typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Valid email is required' }, { status: 400 });
  }
  if (!role || !['owner', 'admin', 'member', 'viewer'].includes(role)) {
    return json({ error: 'Role must be owner, admin, member, or viewer' }, { status: 400 });
  }
  const normalizedEmail = email.toLowerCase().trim();

  // Already a member of this org?
  const existingMember = db.prepare(`
    SELECT 1 FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? AND LOWER(u.email) = ?
  `).get(params.org_id, normalizedEmail);
  if (existingMember) {
    return json({ error: 'This user is already a member of the organization' }, { status: 409 });
  }

  const existingInvite = db.prepare(
    "SELECT id FROM org_invitations WHERE org_id = ? AND LOWER(email) = ? AND expires_at > datetime('now')"
  ).get(params.org_id, normalizedEmail);
  if (existingInvite) {
    return json({ error: 'An invitation is already pending for this email' }, { status: 409 });
  }

  db.prepare(
    "DELETE FROM org_invitations WHERE org_id = ? AND LOWER(email) = ? AND expires_at <= datetime('now')"
  ).run(params.org_id, normalizedEmail);

  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    'INSERT INTO org_invitations (id, org_id, email, role, token, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, params.org_id, normalizedEmail, role, token, locals.user.id, expiresAt);

  logOperatorAction(locals.user.id, 'invite_member', 'org', params.org_id, { email: normalizedEmail, role });

  const inviteUrl = `${url.origin}/invite/${token}`;
  const inviterName = [locals.user.first_name, locals.user.last_name].filter(Boolean).join(' ') || locals.user.email;
  sendInviteEmail(normalizedEmail, inviterName, org.name, role, token).catch(() => {});

  return json({ invitation: { id, email: normalizedEmail, role, inviteUrl } }, { status: 201 });
};
