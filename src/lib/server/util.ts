import { createHash } from 'node:crypto';
import { error } from '@sveltejs/kit';

function bodyError(status: 400 | 413 | 415, message: string): never {
  // Preserve SvelteKit's message and the error field used by API consumers.
  error(status, { message, error: message });
}

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

export const MAX_JSON_BODY_BYTES = 1024 * 1024;

/** Read raw bytes with a caller-selected limit, without interpreting the payload. */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) bodyError(400, 'Invalid Content-Length');
    if (Number(contentLength) > maxBytes) bodyError(413, 'Payload Too Large');
  }

  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  // Grow one contiguous buffer instead of retaining one object per chunk.
  // This also avoids a final payload-sized copy (and tiny-chunk overhead).
  let bytes = new Uint8Array(0);
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value.byteLength > maxBytes - size) {
        // Do not cancel the Request stream here: adapter-node implements
        // cancellation by destroying the socket, which prevents the 413 reply.
        bodyError(413, 'Payload Too Large');
      }

      const required = size + value.byteLength;
      if (required > bytes.byteLength) {
        const capacity = Math.min(maxBytes, Math.max(required, bytes.byteLength * 2, 4096));
        const grown = new Uint8Array(capacity);
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(value, size);
      size = required;
    }
  } finally {
    reader.releaseLock();
  }

  return bytes.subarray(0, size);
}

/** Read and parse JSON after enforcing a byte limit on the incoming stream. */
export async function readBoundedJsonBody(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<any> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    bodyError(415, 'Content-Type must be application/json');
  }

  const bytes = await readBoundedBody(request, maxBytes);
  if (bytes.byteLength === 0) bodyError(400, 'Request body is required');

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    bodyError(400, 'Request body must be valid UTF-8');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text!);
  } catch {
    bodyError(400, 'Request body must contain valid JSON');
  }
  if (parsed === null) bodyError(400, 'Request body must not be null');
  return parsed;
}


/** Bound setup form bytes before the platform's form parser allocates fields. */
export async function readBoundedFormData(request: Request): Promise<FormData> {
  const bytes = await readBoundedBody(request, MAX_JSON_BODY_BYTES);
  try {
    return await new Response(bytes as Uint8Array<ArrayBuffer>, {
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
    }).formData();
  } catch {
    bodyError(400, 'Request body must contain valid form data');
  }
}
