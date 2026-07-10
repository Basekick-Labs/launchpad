import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { JWT_SECRET } from './auth';

const ISSUER = 'Arc Launchpad';
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const RECOVERY_CODE_COUNT = 8;
const MFA_TOKEN_EXPIRY = '5m';
const SALT_ROUNDS = 12;

export async function generateTotpSecret(email: string): Promise<{ secret: string; uri: string; qrDataUri: string }> {
  const secret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    secret,
  });

  const uri = totp.toString();
  const qrDataUri = await QRCode.toDataURL(uri);

  return { secret: secret.base32, uri, qrDataUri };
}

/**
 * Validate a TOTP code. Returns the absolute timestep (counter) the code
 * matched, or null if invalid. Callers persist the last accepted timestep and
 * reject any code whose timestep is <= it, so a code can't be replayed within
 * its ±window validity period.
 */
export function verifyTotpCode(secret: string, code: string): { timestep: number } | null {
  const totp = new TOTP({
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    secret: Secret.fromBase32(secret),
  });

  const delta = totp.validate({ token: code, window: TOTP_WINDOW });
  if (delta === null) return null;
  // otpauth returns delta relative to "now"; convert to an absolute counter.
  const now = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
  return { timestep: now + delta };
}

export async function generateRecoveryCodes(): Promise<{ plain: string[]; hashed: string[] }> {
  const plain: string[] = [];
  const hashed: string[] = [];

  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const bytes = crypto.randomBytes(10);
    let code = '';
    for (let j = 0; j < 10; j++) {
      code += chars[bytes[j] % chars.length];
    }
    const formatted = `${code.slice(0, 5)}-${code.slice(5)}`;
    plain.push(formatted);
    hashed.push(await bcrypt.hash(formatted, SALT_ROUNDS));
  }

  return { plain, hashed };
}

export async function verifyRecoveryCode(
  code: string,
  codeHashes: Array<{ id: number; code_hash: string }>
): Promise<{ valid: boolean; matchedId: number | null }> {
  for (const { id, code_hash } of codeHashes) {
    if (await bcrypt.compare(code, code_hash)) {
      return { valid: true, matchedId: id };
    }
  }
  return { valid: false, matchedId: null };
}

const JWT_ALGORITHM = 'HS256' as const;
const JWT_ISSUER = 'arc-launchpad';
// Distinct audience from full session tokens so a "passed password, not yet
// MFA" half-token can never be replayed as a session, despite the shared secret.
const MFA_AUDIENCE = 'arc-launchpad:mfa';

export function createMfaToken(userId: string): string {
  return jwt.sign({ userId, purpose: 'mfa' }, JWT_SECRET, {
    expiresIn: MFA_TOKEN_EXPIRY,
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: MFA_AUDIENCE,
  });
}

export function verifyMfaToken(token: string): { userId: string } | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: MFA_AUDIENCE,
    }) as { userId: string; purpose: string };
    if (payload.purpose !== 'mfa') return null;
    return { userId: payload.userId };
  } catch {
    return null;
  }
}
