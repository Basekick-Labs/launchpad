/** Basic email-shape + length validation for system boundaries. */
export function isValidEmail(email: string): boolean {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Read a JSON request body with a byte ceiling, without buffering past it.
 *
 * `await request.text()` is not a bounded read: by the time it resolves the
 * whole body is already a string in the heap, so checking its length afterwards
 * only changes the status code. And adapter-node's own limit does not bind for
 * a chunked body — `Number(h['content-length'])` is `NaN`, so both of its
 * guards compare against `NaN` and pass. See #59, which fixes this repo-wide;
 * this is the dashboard routes' use of it.
 *
 * Returns the raw string so the caller can hand it to a parser that enforces
 * its own limits, or `null` when the body is empty.
 *
 * @throws {BodyTooLargeError} once the running byte total exceeds `maxBytes`
 * @throws {BadBodyError} on a non-JSON content type or invalid UTF-8
 */
export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

export class BadBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadBodyError';
  }
}

export async function readBoundedBody(request: Request, maxBytes: number): Promise<string> {
  const contentType = request.headers.get('content-type') ?? '';
  // Also CSRF hardening: SvelteKit's origin check only blocks cross-origin
  // *form* content types, so requiring JSON keeps an HTML form off this route
  // regardless of how csrf.checkOrigin is configured later.
  if (!/^application\/json\b/i.test(contentType)) {
    throw new BadBodyError('Content-Type must be application/json');
  }

  // Cheap pre-reject: the only check that runs before any allocation.
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError(maxBytes);

  const body = request.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Abort rather than drain: the point is to stop allocating.
        await reader.cancel();
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    // fatal so truncated or invalid UTF-8 is an error rather than U+FFFD
    // silently reaching the validator.
    return new TextDecoder('utf-8', { fatal: true }).decode(joined);
  } catch {
    throw new BadBodyError('Body is not valid UTF-8');
  }
}
