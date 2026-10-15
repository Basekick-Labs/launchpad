import { describe, expect, it } from 'vitest';
import { readBoundedJsonBody } from './util';

function request(body: ReadableStream<Uint8Array> | null, headers: Record<string, string> = {}) {
  return { body, headers: new Headers(headers) } as Request;
}

async function expectHttpError(promise: Promise<unknown>, status: number) {
  await expect(promise).rejects.toMatchObject({ status });
}

describe('readBoundedJsonBody', () => {
  it('parses a JSON request within the byte limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":true}'));
        controller.close();
      },
    });

    await expect(readBoundedJsonBody(request(body, { 'content-type': 'application/json' })))
      .resolves.toEqual({ ok: true });
  });

  it('rejects non-JSON content types before reading the body', async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() { pulled = true; },
    }, { highWaterMark: 0 });

    await expectHttpError(readBoundedJsonBody(request(body, { 'content-type': 'text/plain' })), 415);
    expect(pulled).toBe(false);
  });

  it('rejects a declared oversized body before reading it', async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() { pulled = true; },
    }, { highWaterMark: 0 });

    await expectHttpError(readBoundedJsonBody(request(body, {
      'content-type': 'application/json',
      'content-length': '11',
    }), 10), 413);
    expect(pulled).toBe(false);
  });

  it('stops reading an oversized chunked body as soon as the byte limit is crossed', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(pulled === 1 ? 4 : 2));
      },
    }, { highWaterMark: 0 });

    await expectHttpError(readBoundedJsonBody(request(body, {
      'content-type': 'application/json',
    }), 5), 413);
    // The reader stops at the first chunk that crosses the limit. The runtime
    // adapter owns the incoming socket and enforces BODY_SIZE_LIMIT as well.
    expect(pulled).toBe(2);
  });

  it('counts received bytes even when Content-Length understates the body', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"padding":"1234567890"}'));
        controller.close();
      },
    });

    await expectHttpError(readBoundedJsonBody(request(body, {
      'content-type': 'application/json',
      'content-length': '1',
    }), 10), 413);
  });

  it('rejects empty, malformed and invalid UTF-8 bodies with 400', async () => {
    const empty = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const malformed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        controller.close();
      },
    });
    const invalidUtf8 = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xc3, 0x28]));
        controller.close();
      },
    });
    const headers = { 'content-type': 'application/json' };

    await expectHttpError(readBoundedJsonBody(request(empty, headers), 10), 400);
    await expectHttpError(readBoundedJsonBody(request(malformed, headers), 10), 400);
    await expectHttpError(readBoundedJsonBody(request(invalidUtf8, headers), 10), 400);
  });
});
