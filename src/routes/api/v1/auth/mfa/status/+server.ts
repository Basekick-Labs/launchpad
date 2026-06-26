import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const user = db.prepare('SELECT mfa_secret, mfa_enabled_at FROM users WHERE id = ?')
    .get(locals.user.id) as { mfa_secret: string | null; mfa_enabled_at: string | null } | undefined;

  const recoveryCodesRemaining = db.prepare(
    'SELECT COUNT(*) as count FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL'
  ).get(locals.user.id) as { count: number };

  return json({
    mfaEnabled: !!user?.mfa_secret,
    mfaEnabledAt: user?.mfa_enabled_at || null,
    recoveryCodesRemaining: recoveryCodesRemaining.count,
  });
};
