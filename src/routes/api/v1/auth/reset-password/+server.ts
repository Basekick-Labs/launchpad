import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { hashPassword } from '$lib/server/auth';
import { isRateLimited } from '$lib/server/ratelimit';

function isStrongPassword(password: string): boolean {
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[0-9!@#$%^&*()_\-+=\[\]{};':"\\|,.<>\/?]/.test(password)
  );
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const ip = getClientAddress();

  // Rate limit: 5 attempts per IP per 15 minutes
  if (isRateLimited(`reset:${ip}`, 5, 15 * 60 * 1000)) {
    return json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
  }

  const { token, password } = await request.json();

  if (!token || !password) {
    return json({ error: 'Token and password are required' }, { status: 400 });
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
  const resetToken = db.prepare(
    "SELECT * FROM password_reset_tokens WHERE token = ? AND expires_at > datetime('now')"
  ).get(token) as any;

  if (!resetToken) {
    return json({ error: 'Invalid or expired reset link. Please request a new one.' }, { status: 400 });
  }

  const passwordHash = await hashPassword(password);
  db.prepare("UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?").run(passwordHash, resetToken.user_id);
  db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);

  return json({ ok: true });
};
