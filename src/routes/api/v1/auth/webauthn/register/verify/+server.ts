import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { verifyRegistration } from '$lib/server/webauthn';
import { isRateLimited } from '$lib/server/ratelimit';

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (isRateLimited(`webauthn_register:${locals.user.id}`, 10, 15 * 60 * 1000)) {
    return json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
  }

  const { challengeId, credential, name } = await request.json();

  if (!challengeId || !credential) {
    return json({ error: 'Challenge ID and credential are required' }, { status: 400 });
  }

  // Sanitize passkey name
  const sanitizedName = typeof name === 'string' ? name.trim().slice(0, 50) : '';
  const passkeyName = sanitizedName || 'My Passkey';

  try {
    const registrationInfo = await verifyRegistration(challengeId, locals.user.id, credential);

    const credentialId = registrationInfo.credential.id;
    const publicKey = Buffer.from(registrationInfo.credential.publicKey);
    const counter = registrationInfo.credential.counter;
    const transports = credential.response?.transports
      ? JSON.stringify(credential.response.transports)
      : null;

    const db = getDb();
    db.prepare(
      'INSERT INTO webauthn_credentials (id, user_id, name, public_key, counter, transports) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(credentialId, locals.user.id, passkeyName, publicKey, counter, transports);

    return json({
      credential: {
        id: credentialId,
        name: passkeyName,
        created_at: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    return json({ error: err.message || 'Registration failed' }, { status: 400 });
  }
};
