import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { createToken, sessionCookieOptions } from '$lib/server/auth';
import { verifyAuthentication } from '$lib/server/webauthn';
import { isRateLimited } from '$lib/server/ratelimit';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
  const ip = getClientAddress();

  if (isRateLimited(`webauthn_auth:${ip}`, 10, 15 * 60 * 1000)) {
    return json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
  }

  const { challengeId, credential } = await request.json();

  if (!challengeId || !credential) {
    return json({ error: 'Challenge ID and credential are required' }, { status: 400 });
  }

  const db = getDb();

  // Look up the credential
  const storedCred = db.prepare(
    'SELECT id, user_id, public_key, counter, transports FROM webauthn_credentials WHERE id = ?'
  ).get(credential.id) as {
    id: string;
    user_id: string;
    public_key: Buffer;
    counter: number;
    transports: string | null;
  } | undefined;

  if (!storedCred) {
    return json({ error: 'Passkey not recognized' }, { status: 401 });
  }

  // Load user
  const user = db.prepare(
    'SELECT id, email, first_name, last_name, token_version, suspended_at, deleted_at FROM users WHERE id = ?'
  ).get(storedCred.user_id) as any;

  if (!user || user.suspended_at || user.deleted_at) {
    return json({ error: 'Account not available' }, { status: 401 });
  }

  try {
    await verifyAuthentication(challengeId, credential, storedCred);
  } catch (err: any) {
    return json({ error: err.message || 'Authentication failed' }, { status: 401 });
  }

  // Passkey login bypasses MFA — issue session directly
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
