import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { hashPassword, createToken, sessionCookieOptions } from '$lib/server/auth';
import { isRateLimited } from '$lib/server/ratelimit';
import { isValidEmail } from '$lib/server/util';

async function verifyCaptcha(token: string, ip: string): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // Skip if not configured

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: token, remoteip: ip }),
  });

  const data = await res.json() as { success: boolean };
  return data.success;
}

// Load disposable domain blocklist once at module load
const disposableDomains = new Set(
  readFileSync(resolve('src/lib/server/disposable-domains.txt'), 'utf-8')
    .split('\n')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
);

function isDisposableEmail(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? disposableDomains.has(domain) : false;
}

function isStrongPassword(password: string): boolean {
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[0-9!@#$%^&*()_\-+=\[\]{};':"\\|,.<>\/?]/.test(password)
  );
}

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
  const ip = getClientAddress();

  // Rate limit: 5 signups per IP per 15 minutes
  if (isRateLimited(`signup:${ip}`, 5, 15 * 60 * 1000)) {
    return json({ error: 'Too many signup attempts. Please try again later.' }, { status: 429 });
  }

  const { email: rawEmail, password, name, first_name, last_name, captchaToken } = await request.json();

  if (!rawEmail || !password) {
    return json({ error: 'Email and password are required' }, { status: 400 });
  }

  // Normalize email so signup/login lookups are case-insensitive and consistent.
  const email = String(rawEmail).trim().toLowerCase();

  if (!isValidEmail(email)) {
    return json({ error: 'Please enter a valid email address.' }, { status: 400 });
  }

  // Verify captcha if configured
  if (env.TURNSTILE_SECRET_KEY) {
    if (!captchaToken) {
      return json({ error: 'Captcha verification is required.' }, { status: 400 });
    }
    const valid = await verifyCaptcha(captchaToken, ip);
    if (!valid) {
      return json({ error: 'Captcha verification failed. Please try again.' }, { status: 400 });
    }
  }

  if (isDisposableEmail(email)) {
    return json({ error: 'Please use a permanent email address.' }, { status: 400 });
  }

  if (password.length > 128) {
    return json({ error: 'Password must not exceed 128 characters.' }, { status: 400 });
  }

  if (!isStrongPassword(password)) {
    return json(
      { error: 'Password must be at least 8 characters and include an uppercase letter and a number or symbol.' },
      { status: 400 },
    );
  }

  const db = getDb();

  // Pre-check for a friendly error before doing the expensive hash. The
  // authoritative check runs inside the transaction below.
  const pendingInviteToken = cookies.get('arc_pending_invite');
  const preCount = (db.prepare(
    'SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL'
  ).get() as { count: number }).count;
  if (preCount > 0 && !pendingInviteToken) {
    return json({ error: 'Signups are by invitation only. Ask an administrator for an invite.' }, { status: 403 });
  }

  // Hash outside the transaction (bcrypt is async; better-sqlite3 txns are sync).
  const userId = uuidv4();
  const passwordHash = await hashPassword(password);
  const fname = first_name || name || null;
  const lname = last_name || null;
  const displayName = [fname, lname].filter(Boolean).join(' ');
  const orgId = uuidv4();
  const orgName = displayName ? `${displayName}'s Organization` : 'My Organization';

  // All bootstrap/invite/uniqueness decisions happen atomically so two
  // concurrent first-user signups can't both mint an operator, and an invite
  // can't be redeemed twice.
  type Outcome =
    | { ok: true; isInviteSignup: boolean }
    | { ok: false; status: number; error: string };

  const runSignup = db.transaction((): Outcome => {
    // Re-read the count INSIDE the transaction — this is the authoritative
    // first-user determination.
    const count = (db.prepare(
      'SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL'
    ).get() as { count: number }).count;
    const isFirstUser = count === 0;

    let isInviteSignup = false;
    let inviteGrantsOperator = false;
    if (pendingInviteToken) {
      const invitation = db.prepare(
        "SELECT * FROM org_invitations WHERE token = ? AND expires_at > datetime('now')"
      ).get(pendingInviteToken) as any;
      if (invitation && invitation.email.toLowerCase() === email) {
        isInviteSignup = true;
        inviteGrantsOperator = invitation.grant_operator === 1;
        db.prepare('DELETE FROM org_invitations WHERE token = ?').run(pendingInviteToken);
      }
    }

    if (!isFirstUser && !isInviteSignup) {
      return { ok: false, status: 403, error: 'Signups are by invitation only. Ask an administrator for an invite.' };
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').get(email);
    if (existing) {
      return { ok: false, status: 409, error: 'An account with this email already exists.' };
    }

    const isOperator = isFirstUser || inviteGrantsOperator ? 1 : 0;
    db.prepare('INSERT INTO users (id, email, password_hash, first_name, last_name, email_verified, is_operator) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(userId, email, passwordHash, fname, lname, isOperator);
    db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(orgId, orgName, userId);
    db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')").run(orgId, userId);

    return { ok: true, isInviteSignup };
  });

  let outcome: Outcome;
  try {
    outcome = runSignup();
  } catch (err) {
    // UNIQUE(email) collision from a concurrent insert lands here.
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      return json({ error: 'An account with this email already exists.' }, { status: 409 });
    }
    throw err;
  }

  if (!outcome.ok) {
    return json({ error: outcome.error }, { status: outcome.status });
  }

  // Auto-login the new account.
  const token = createToken({ userId, email, name: displayName });
  cookies.set('arc_session', token, sessionCookieOptions);

  return json({
    redirectTo: outcome.isInviteSignup ? `/invite/${pendingInviteToken}` : '/dashboard',
  }, { status: 201 });
};
