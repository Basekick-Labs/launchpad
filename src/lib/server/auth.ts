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

export interface JwtPayload {
  userId: string;
  email: string;
  name: string; // display name (first + last) for backwards compat with existing tokens
  tv?: number; // token_version for revocation
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function createToken(payload: JwtPayload, tokenVersion: number = 0): string {
  return jwt.sign({ ...payload, tv: tokenVersion }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = 'arc_session';

/**
 * Cookie options for the session cookie. `secure` is disabled in dev so the
 * cookie is stored over plain HTTP (http://localhost); enabled in production.
 */
export const sessionCookieOptions = {
  path: '/' as const,
  httpOnly: true,
  secure: !dev,
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
