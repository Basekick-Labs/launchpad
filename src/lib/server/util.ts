import { error } from '@sveltejs/kit';

/** Basic email-shape + length validation for system boundaries. */
export function isValidEmail(email: string): boolean {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const configuredBodySizeLimit = Number.parseInt(process.env.BODY_SIZE_LIMIT ?? '', 10);
export const MAX_JSON_BODY_BYTES = Number.isSafeInteger(configuredBodySizeLimit) && configuredBodySizeLimit > 0
  ? Math.min(configuredBodySizeLimit, 1024 * 1024)
  : 1024 * 1024;

/** Read and parse JSON after enforcing a byte limit on the incoming stream. */
export async function readBoundedJsonBody(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<any> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    error(415, 'Content-Type must be application/json');
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) error(400, 'Invalid Content-Length');
    if (Number(contentLength) > maxBytes) error(413, 'Payload Too Large');
  }

  if (!request.body) error(400, 'Request body is required');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      size += value.byteLength;
      if (size > maxBytes) {
        // Do not cancel the Request stream here: adapter-node implements
        // cancellation by destroying the socket, which prevents the 413 reply.
        error(413, 'Payload Too Large');
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (size === 0) error(400, 'Request body is required');

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    error(400, 'Request body must be valid UTF-8');
  }

  try {
    return JSON.parse(text!);
  } catch {
    error(400, 'Request body must contain valid JSON');
  }
}
