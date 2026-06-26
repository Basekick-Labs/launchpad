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

  const { challengeId, code } = await request.json();

  if (!challengeId || !code) {
    return json({ error: 'Challenge ID and code are required' }, { status: 400 });
  }

  const db = getDb();

  // Retrieve pending secret
  const challenge = db.prepare(
    "SELECT * FROM auth_challenges WHERE id = ? AND type = 'mfa_setup' AND user_id = ? AND expires_at > datetime('now')"
  ).get(challengeId, locals.user.id) as { challenge: string } | undefined;

  if (!challenge) {
    return json({ error: 'Invalid or expired setup session. Please start again.' }, { status: 400 });
  }

  const secret = challenge.challenge; // We stored the TOTP secret in the challenge field

  if (!verifyTotpCode(secret, code)) {
    return json({ error: 'Invalid code. Please try again.' }, { status: 400 });
  }

  // Generate recovery codes
  const { plain, hashed } = await generateRecoveryCodes();

  // Enable MFA in a transaction
  const enableMfa = db.transaction(() => {
    db.prepare(
      "UPDATE users SET mfa_secret = ?, mfa_enabled_at = datetime('now'), token_version = token_version + 1 WHERE id = ?"
    ).run(secret, locals.user!.id);

    // Store hashed recovery codes
    const insert = db.prepare(
      'INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)'
    );
    for (const hash of hashed) {
      insert.run(locals.user!.id, hash);
    }

    // Clean up challenge
    db.prepare('DELETE FROM auth_challenges WHERE id = ?').run(challengeId);
  });

  enableMfa();

  return json({ recoveryCodes: plain });
};
