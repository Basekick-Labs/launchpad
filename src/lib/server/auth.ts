import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';

export const JWT_SECRET = env.LAUNCHPAD_JWT_SECRET || (dev ? 'dev-secret-change-in-production' : '');
if (!JWT_SECRET) {
  throw new Error('LAUNCHPAD_JWT_SECRET must be set in production');
}
const JWT_EXPIRY = '7d';
const SALT_ROUNDS = 12;
const JWT_ALGORITHM = 'HS256' as const;
const JWT_ISSUER = 'arc-launchpad';
// Session tokens carry this audience; short-lived MFA half-tokens use a
// different one (see mfa.ts) so the two can never be interchanged even though
// they share a signing secret.
export const JWT_AUDIENCE_SESSION = 'arc-launchpad:session';

export interface JwtPayload {
  userId: string;
  email: string;
  name: string; // display name (first + last) for backwards compat with existing tokens
  tv?: number; // token_version for revocation
}

// A valid bcrypt hash (cost 12) of a random string. Compared against on the
// user-not-found / OAuth-only login paths so bcrypt runs regardless, keeping
// login response timing uniform (anti-enumeration). It matches no real password.
export const DUMMY_BCRYPT_HASH = '$2a$12$qEyLTxY1OMKvvjkKAstXduCO0tMRY9b8bG7FSclv4a49CpsPbJIO6';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function createToken(payload: JwtPayload, tokenVersion: number = 0): string {
  return jwt.sign({ ...payload, tv: tokenVersion }, JWT_SECRET, {
    expiresIn: JWT_EXPIRY,
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE_SESSION,
  });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    // Pin the algorithm (no alg-confusion), issuer, and audience so an MFA
    // half-token can never be accepted as a full session.
    return jwt.verify(token, JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE_SESSION,
    }) as JwtPayload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = 'arc_session';

/**
 * Whether this deployment is served over HTTPS. Drives the `secure` cookie flag:
 * a `secure` cookie is silently dropped by the browser over plain HTTP, so a
 * production deployment on http:// (localhost, an internal network, or with TLS
 * terminated at a proxy that forwards http to the app) must NOT set it — otherwise
 * the session cookie never persists and login appears to "succeed" but bounces
 * straight back to /login. Derive it from the configured public URL's scheme;
 * default to true in production when unset (safe for the common HTTPS case) and
 * false in dev.
 */
export const deploymentIsHttps = (() => {
  const raw = env.LAUNCHPAD_BASE_URL?.trim();
  if (raw) {
    try {
      return new URL(raw).protocol === 'https:';
    } catch {
      // fall through to the env-based default
    }
  }
  return !dev;
})();

/**
 * Cookie options for the session cookie. `secure` tracks whether the deployment
 * is actually HTTPS (see `deploymentIsHttps`), not merely dev-vs-prod, so a
 * plain-HTTP production deploy can still hold its session cookie.
 */
export const sessionCookieOptions = {
  path: '/' as const,
  httpOnly: true,
  secure: deploymentIsHttps,
  sameSite: 'lax' as const,
  maxAge: 60 * 60 * 24 * 7,
};

export function generateResourceId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(12);
  let result = '';
  // First char must be a letter (for valid subdomain)
  result += chars.charAt(bytes[0] % 26);
  for (let i = 1; i < 12; i++) {
    result += chars.charAt(bytes[i] % chars.length);
  }
  return result;
}
