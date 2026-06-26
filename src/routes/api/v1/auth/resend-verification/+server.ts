import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { sendVerificationEmail } from '$lib/server/email';
import { isRateLimited } from '$lib/server/ratelimit';

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const { email } = await request.json();

  if (!email) {
    return json({ error: 'Email is required' }, { status: 400 });
  }

  // Rate limit: 3 per email per 15 minutes
  if (isRateLimited(`resend:${email}`, 3, 15 * 60 * 1000) ||
      isRateLimited(`resend-ip:${getClientAddress()}`, 5, 15 * 60 * 1000)) {
    return json({ ok: true }); // silent — don't reveal rate limiting to avoid enumeration
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;

  // Always return success to avoid email enumeration
  if (!user || user.email_verified) {
    return json({ ok: true });
  }

  await sendVerificationEmail(email, user.id);

  return json({ ok: true });
};
