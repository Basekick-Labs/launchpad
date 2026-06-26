import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { sendInviteEmail } from '$lib/server/email';
import { isRateLimited } from '$lib/server/ratelimit';
import crypto from 'crypto';

const INVITE_EXPIRY_DAYS = 7;

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const membership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, locals.user.id) as { role: string } | undefined;

  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const invitations = db.prepare(`
    SELECT i.id, i.email, i.role, i.created_at, i.expires_at,
      TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) as invited_by_name
    FROM org_invitations i
    JOIN users u ON u.id = i.invited_by
    WHERE i.org_id = ? AND i.expires_at > datetime('now')
    ORDER BY i.created_at DESC
  `).all(params.org_id);

  return json({ invitations });
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const membership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, locals.user.id) as { role: string } | undefined;

  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const { email, role } = await request.json();

  if (!email || typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Valid email is required' }, { status: 400 });
  }

  const normalizedEmail = email.toLowerCase().trim();

  if (!role || !['admin', 'member', 'viewer'].includes(role)) {
    return json({ error: 'Role must be admin, member, or viewer' }, { status: 400 });
  }

  // Admins can only invite as member or viewer
  if (membership.role === 'admin' && role === 'admin') {
    return json({ error: 'Admins can only invite members or viewers' }, { status: 403 });
  }

  // Prevent self-invite
  if (normalizedEmail === locals.user.email.toLowerCase()) {
    return json({ error: 'Cannot invite yourself' }, { status: 400 });
  }

  // Check if already a member
  const existingMember = db.prepare(`
    SELECT u.id FROM users u
    JOIN org_members m ON m.user_id = u.id
    WHERE LOWER(u.email) = ? AND m.org_id = ?
  `).get(normalizedEmail, params.org_id);

  if (existingMember) {
    return json({ error: 'This user is already a member of the organization' }, { status: 409 });
  }

  // Check for existing active invitation
  const existingInvite = db.prepare(
    "SELECT id FROM org_invitations WHERE org_id = ? AND LOWER(email) = ? AND expires_at > datetime('now')"
  ).get(params.org_id, normalizedEmail);

  if (existingInvite) {
    return json({ error: 'An invitation is already pending for this email' }, { status: 409 });
  }

  // Rate limit: 20 invites per org per hour
  if (isRateLimited(`invite:${params.org_id}`, 20, 60 * 60 * 1000)) {
    return json({ error: 'Too many invitations. Please try again later.' }, { status: 429 });
  }

  // Clean up any expired invites for this email+org
  db.prepare(
    "DELETE FROM org_invitations WHERE org_id = ? AND LOWER(email) = ? AND expires_at <= datetime('now')"
  ).run(params.org_id, normalizedEmail);

  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    'INSERT INTO org_invitations (id, org_id, email, role, token, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, params.org_id, normalizedEmail, role, token, locals.user.id, expiresAt);

  // Get org name for the email
  const org = db.prepare('SELECT name FROM organizations WHERE id = ?')
    .get(params.org_id) as { name: string } | undefined;

  const inviterName = [locals.user.first_name, locals.user.last_name].filter(Boolean).join(' ') || locals.user.email;
  sendInviteEmail(normalizedEmail, inviterName, org?.name || 'Arc Launchpad', role, token).catch(() => {});

  return json({ invitation: { id, email: normalizedEmail, role } }, { status: 201 });
};
