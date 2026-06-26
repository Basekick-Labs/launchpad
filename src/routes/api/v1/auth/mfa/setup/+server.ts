import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '$lib/server/db';
import { generateTotpSecret } from '$lib/server/mfa';

export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const user = db.prepare('SELECT mfa_secret FROM users WHERE id = ?').get(locals.user.id) as { mfa_secret: string | null } | undefined;

  if (user?.mfa_secret) {
    return json({ error: 'MFA is already enabled' }, { status: 400 });
  }

  const { secret, qrDataUri } = await generateTotpSecret(locals.user.email);

  // Store pending secret in auth_challenges (not in users table yet)
  const challengeId = uuidv4();
  db.prepare(
    `INSERT INTO auth_challenges (id, user_id, challenge, type, expires_at)
     VALUES (?, ?, ?, 'mfa_setup', datetime('now', '+10 minutes'))`
  ).run(challengeId, locals.user.id, secret);

  return json({ qrDataUri, secret, challengeId });
};
