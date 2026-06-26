import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { sendPasswordResetEmail } from '$lib/server/email';
import { isRateLimited } from '$lib/server/ratelimit';

export const POST: RequestHandler = async ({ request }) => {
  const { email } = await request.json();

  if (!email) {
    return json({ error: 'Email is required' }, { status: 400 });
  }

  // Rate limit: 3 requests per email per 15 minutes
  if (isRateLimited(`forgot:${email.toLowerCase()}`, 3, 15 * 60 * 1000)) {
    // Still return ok to prevent enumeration
    return json({ ok: true });
  }

  const db = getDb();
  const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email) as any;

  // Only send if user exists and has a password (not GitHub-only)
  if (user && user.password_hash) {
    await sendPasswordResetEmail(email, user.id);
  }

  // Always return ok to prevent email enumeration
  return json({ ok: true });
};
