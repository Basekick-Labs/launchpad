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

/**
 * Read a JSON request body of at most `maxBytes`, counting bytes as they
 * arrive so an oversized or chunked body is refused without buffering it.
 * Null for a missing, oversized or malformed body. (A fuller shared reader
 * for every route is proposed in PR #95.)
 */
export async function readSmallJson(request: Request, maxBytes: number): Promise<unknown | null> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    return null;
  }
}
