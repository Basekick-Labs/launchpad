import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { createToken, sessionCookieOptions } from '$lib/server/auth';
import { verifyMfaToken, verifyTotpCode, verifyRecoveryCode } from '$lib/server/mfa';
import { isRateLimited } from '$lib/server/ratelimit';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
  const ip = getClientAddress();

  if (isRateLimited(`mfa_verify:${ip}`, 5, 5 * 60 * 1000)) {
    return json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
  }

  const { mfaToken, code, isRecoveryCode } = await request.json();

  if (!mfaToken || !code) {
    return json({ error: 'MFA token and code are required' }, { status: 400 });
  }

  const payload = verifyMfaToken(mfaToken);
  if (!payload) {
    return json({ error: 'Invalid or expired MFA session. Please log in again.' }, { status: 401 });
  }

  const db = getDb();
  const user = db.prepare(
    'SELECT id, email, first_name, last_name, mfa_secret, token_version, suspended_at, deleted_at FROM users WHERE id = ?'
  ).get(payload.userId) as any;

  if (!user || !user.mfa_secret || user.suspended_at || user.deleted_at) {
    return json({ error: 'Invalid MFA session' }, { status: 401 });
  }

  if (isRecoveryCode) {
    const unusedCodes = db.prepare(
      'SELECT id, code_hash FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL'
    ).all(user.id) as Array<{ id: number; code_hash: string }>;

    const result = await verifyRecoveryCode(code, unusedCodes);
    if (!result.valid) {
      return json({ error: 'Invalid recovery code' }, { status: 401 });
    }

    // Mark recovery code as used
    db.prepare("UPDATE mfa_recovery_codes SET used_at = datetime('now') WHERE id = ?").run(result.matchedId);
  } else {
    if (!verifyTotpCode(user.mfa_secret, code)) {
      return json({ error: 'Invalid code' }, { status: 401 });
    }
  }

  // Issue real session
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const token = createToken({
    userId: user.id,
    email: user.email,
    name: displayName,
  }, user.token_version ?? 0);

  cookies.set('arc_session', token, sessionCookieOptions);

  const pendingInvite = cookies.get('arc_pending_invite');
  const redirectTo = pendingInvite ? `/invite/${pendingInvite}` : '/dashboard';

  return json({
    user: { id: user.id, email: user.email, first_name: user.first_name || '', last_name: user.last_name || '' },
    redirectTo,
  });
};
