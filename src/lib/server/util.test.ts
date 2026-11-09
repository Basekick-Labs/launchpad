import { describe, expect, it } from 'vitest';
import { readBoundedBody, readBoundedJsonBody, readBoundedFormData, MAX_JSON_BODY_BYTES } from './util';

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
    // The reader stops at the first chunk that crosses the limit. The locked
    // adapter-node does not enforce BODY_SIZE_LIMIT for chunked requests.
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


describe('readBoundedBody', () => {
  function stream(chunks: number[][]) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        controller.close();
      },
    });
  }

  it('preserves binary bytes at the exact limit without JSON or UTF-8 requirements', async () => {
    await expect(readBoundedBody(request(stream([[0xff, 0], [0xc3, 0x28]]), {
      'content-type': 'application/octet-stream', 'content-length': '4',
    }), 4)).resolves.toEqual(new Uint8Array([0xff, 0, 0xc3, 0x28]));
  });

  it('allows absent and empty raw bodies, but JSON still rejects both', async () => {
    await expect(readBoundedBody(request(null), 0)).resolves.toEqual(new Uint8Array(0));
    await expect(readBoundedBody(request(stream([])), 0)).resolves.toEqual(new Uint8Array(0));
    await expectHttpError(readBoundedJsonBody(request(null, { 'content-type': 'application/json' })), 400);
    await expectHttpError(readBoundedJsonBody(request(stream([]), { 'content-type': 'application/json' })), 400);
  });

  it('rejects declared overflow and malformed lengths without reading', async () => {
    for (const [length, status] of [['5', 413], ['-1', 400], ['1.5', 400], ['abc', 400]] as const) {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({ pull() { pulls++; } }, { highWaterMark: 0 });
      await expectHttpError(readBoundedBody(request(body, { 'content-length': length }), 4), status);
      expect(pulls).toBe(0);
      expect(body.locked).toBe(false);
    }
  });

  it('stops at first overflow for chunked and understated bodies without cancelling', async () => {
    const cases: Record<string, string>[] = [{}, { 'content-length': '1' }];
    for (const headers of cases) {
      let pulls = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { pulls++; controller.enqueue(new Uint8Array(2)); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      await expectHttpError(readBoundedBody(request(body, headers), 4), 413);
      expect(pulls).toBe(3);
      expect(cancelled).toBe(false);
      expect(body.locked).toBe(false);
    }
  });

  it('propagates stream failures and releases the reader lock', async () => {
    const failure = new Error('stream failed');
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(failure); } });
    await expect(readBoundedBody(request(body), 4)).rejects.toBe(failure);
    expect(body.locked).toBe(false);
  });

  it('rejects invalid caller limits before reading', async () => {
    for (const limit of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({ pull() { pulls++; } }, { highWaterMark: 0 });
      await expect(readBoundedBody(request(body), limit)).rejects.toBeInstanceOf(RangeError);
      expect(pulls).toBe(0);
    }
  });

  it('keeps the JSON default at the existing 1 MiB application ceiling', () => {
    expect(MAX_JSON_BODY_BYTES).toBe(1024 * 1024);
  });
});


describe('body error responses and setup forms', () => {
  it('includes the API error field for 400, 413 and 415', async () => {
    for (const [req, limit, status] of [
      [new Request('http://test', { method: 'POST', body: 'null', headers: { 'content-type': 'application/json' } }), 10, 400],
      [new Request('http://test', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), 1, 413],
      [new Request('http://test', { method: 'POST', body: '{}' }), 10, 415],
    ] as const) {
      await expect(readBoundedJsonBody(req, limit)).rejects.toMatchObject({ status, body: {
        error: expect.any(String), message: expect.any(String),
      } });
    }
  });

  it('reads URL-encoded and multipart forms without changing fields', async () => {
    const encoded = new URLSearchParams({ email: 'a@example.test', password: 'p+&é' });
    const one = await readBoundedFormData(new Request('http://test', { method: 'POST', body: encoded }));
    expect(one.get('password')).toBe('p+&é');
    const multipart = new FormData();
    multipart.append('email', 'a@example.test');
    multipart.append('email', 'second@example.test');
    const two = await readBoundedFormData(new Request('http://test', { method: 'POST', body: multipart }));
    expect(two.getAll('email')).toEqual(['a@example.test', 'second@example.test']);
  });

  it('bounds form streams before parsing and returns 400 for malformed form data', async () => {
    const form = new Request('http://test', { method: 'POST', body: 'x'.repeat(MAX_JSON_BODY_BYTES + 1),
      headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    await expectHttpError(readBoundedFormData(form), 413);
    const malformed = new Request('http://test', { method: 'POST', body: 'not multipart',
      headers: { 'content-type': 'multipart/form-data; boundary=missing' } });
    await expectHttpError(readBoundedFormData(malformed), 400);
  });

  it('handles thousands of tiny chunks and zero-length chunks without retained-chunk overhead', async () => {
    let count = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (count === 10000) { controller.close(); return; }
        controller.enqueue(count++ % 2 ? new Uint8Array([255]) : new Uint8Array(0));
      },
    });
    const result = await readBoundedBody(request(body), 5000);
    expect(result).toEqual(new Uint8Array(5000).fill(255));
    expect(result.buffer.byteLength).toBe(5000);
  });
});
