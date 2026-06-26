import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { verifyTotpCode, generateRecoveryCodes } from '$lib/server/mfa';
import { isRateLimited } from '$lib/server/ratelimit';

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (isRateLimited(`mfa_action:${locals.user.id}`, 5, 5 * 60 * 1000)) {
    return json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
  }

  const { code } = await request.json();

  if (!code) {
    return json({ error: 'TOTP code is required' }, { status: 400 });
  }

  const db = getDb();
  const user = db.prepare('SELECT mfa_secret FROM users WHERE id = ?').get(locals.user.id) as { mfa_secret: string | null } | undefined;

  if (!user?.mfa_secret) {
    return json({ error: 'MFA is not enabled' }, { status: 400 });
  }

  if (!verifyTotpCode(user.mfa_secret, code)) {
    return json({ error: 'Invalid code' }, { status: 400 });
  }

  const { plain, hashed } = await generateRecoveryCodes();

  const regenerate = db.transaction(() => {
    db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(locals.user!.id);

    const insert = db.prepare(
      'INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)'
    );
    for (const hash of hashed) {
      insert.run(locals.user!.id, hash);
    }
  });

  regenerate();

  return json({ recoveryCodes: plain });
};
