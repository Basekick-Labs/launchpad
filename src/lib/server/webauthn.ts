import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { v4 as uuidv4 } from 'uuid';
import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import { getDb } from './db';

const BASE_URL = env.LAUNCHPAD_BASE_URL || (dev ? 'http://localhost:5173' : '');
const parsedUrl = BASE_URL ? new URL(BASE_URL) : null;

const rpName = 'Launchpad';
const hostname = parsedUrl?.hostname || 'localhost';
const rpID = hostname === 'localhost' ? 'localhost' : hostname;
const expectedOrigins = hostname === 'localhost'
  ? ['http://localhost:5173']
  : [`https://${hostname}`];

function cleanupExpiredChallenges() {
  const db = getDb();
  db.prepare("DELETE FROM auth_challenges WHERE expires_at < datetime('now')").run();
}

export async function generateRegistrationChallenge(
  user: { id: string; email: string; name: string },
  existingCredentialIds: string[]
) {
  cleanupExpiredChallenges();

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.email,
    userDisplayName: user.name || user.email,
    attestationType: 'none',
    excludeCredentials: existingCredentialIds.map(id => ({
      id,
      transports: ['internal', 'hybrid'] as ('internal' | 'hybrid')[],
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  const challengeId = uuidv4();
  const db = getDb();
  db.prepare(
    `INSERT INTO auth_challenges (id, user_id, challenge, type, expires_at)
     VALUES (?, ?, ?, 'webauthn_register', datetime('now', '+5 minutes'))`
  ).run(challengeId, user.id, options.challenge);

  return { options, challengeId };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function verifyRegistration(challengeId: string, userId: string, response: any) {
  const db = getDb();
  const challenge = db.prepare(
    "SELECT * FROM auth_challenges WHERE id = ? AND type = 'webauthn_register' AND user_id = ? AND expires_at > datetime('now')"
  ).get(challengeId, userId) as { challenge: string } | undefined;

  if (!challenge) {
    throw new Error('Invalid or expired challenge');
  }

  // Delete challenge BEFORE verification to prevent reuse on failure
  const expectedChallenge = challenge.challenge;
  db.prepare('DELETE FROM auth_challenges WHERE id = ?').run(challengeId);

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: expectedOrigins,
    expectedRPID: rpID,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Registration verification failed');
  }

  return verification.registrationInfo;
}

export async function generateAuthenticationChallenge() {
  cleanupExpiredChallenges();

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
  });

  const challengeId = uuidv4();
  const db = getDb();
  db.prepare(
    `INSERT INTO auth_challenges (id, user_id, challenge, type, expires_at)
     VALUES (?, NULL, ?, 'webauthn_auth', datetime('now', '+5 minutes'))`
  ).run(challengeId, options.challenge);

  return { options, challengeId };
}

export async function verifyAuthentication(
  challengeId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any,
  storedCredential: {
    id: string;
    public_key: Buffer;
    counter: number;
    transports: string | null;
  }
) {
  const db = getDb();
  const challenge = db.prepare(
    "SELECT * FROM auth_challenges WHERE id = ? AND type = 'webauthn_auth' AND expires_at > datetime('now')"
  ).get(challengeId) as { challenge: string } | undefined;

  if (!challenge) {
    throw new Error('Invalid or expired challenge');
  }

  // Delete challenge BEFORE verification to prevent reuse on failure
  const expectedChallenge = challenge.challenge;
  db.prepare('DELETE FROM auth_challenges WHERE id = ?').run(challengeId);

  const transports = storedCredential.transports
    ? JSON.parse(storedCredential.transports)
    : undefined;

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: expectedOrigins,
    expectedRPID: rpID,
    credential: {
      id: storedCredential.id,
      publicKey: new Uint8Array(storedCredential.public_key),
      counter: storedCredential.counter,
      transports,
    },
  });

  if (!verification.verified) {
    throw new Error('Authentication verification failed');
  }

  // Update counter
  db.prepare('UPDATE webauthn_credentials SET counter = ? WHERE id = ?')
    .run(verification.authenticationInfo.newCounter, storedCredential.id);

  return verification;
}
