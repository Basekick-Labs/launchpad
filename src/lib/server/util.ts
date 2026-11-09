import { createHash } from 'node:crypto';

/** Basic email-shape + length validation for system boundaries. */
export function isValidEmail(email: string): boolean {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Identity of a stored Arc connection for cache keys: a changed endpoint,
 * token or option is a different key, so a load started for the old
 * connection never fills the new one. The token is hashed, never kept.
 */
export function connectionFingerprint(id: string, endpoint: string | null, token: string | null, ...extra: string[]): string {
  const tokenHash = createHash('sha256').update(token ?? '').digest('hex').slice(0, 16);
  return [id, endpoint ?? '', tokenHash, ...extra].join('|');
}

/** JSON.parse that returns null instead of throwing. */
export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** A strict integer query parameter in [min, max]; fallback when absent, null when invalid. */
export function intParam(url: URL, name: string, fallback: number, min: number, max: number): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}
