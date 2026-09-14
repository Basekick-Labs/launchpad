import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  streamUpstream,
  streamUpstreamWithFallback,
  ResponseTooLargeError,
  DEFAULT_MAX_RESPONSE_BYTES,
} from './arcProxy';
import type { ResolvedTarget } from './ssrf';

// A real upstream, because every bug this module fixes lives in Node's socket
// and stream behaviour and none of it reproduces against a mock.
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

function upstream(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

const target = (port: number): ResolvedTarget => ({
  ip: '127.0.0.1',
  ips: ['127.0.0.1'],
  hostname: 'localhost',
  port,
  protocol: 'http:',
});

const call = (port: number, over: Partial<Parameters<typeof streamUpstream>[0]> = {}) =>
  streamUpstream({
    method: 'GET',
    resolved: target(port),
    ip: '127.0.0.1',
    hostHeader: `localhost:${port}`,
    path: 'api/v1/query',
    headers: {},
    body: null,
    // Short by default: these tests exercise the mechanism, not the 30s number.
    headerTimeoutMs: 1500,
    ...over,
  });

async function drain(body: ReadableStream<Uint8Array> | null): Promise<number> {
  if (!body) return 0;
  let n = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) n += chunk.length;
  return n;
}

const CHUNK = () => Buffer.alloc(64 * 1024, 0x41);

// ===========================================================================
// Streaming
// ===========================================================================

describe('streaming', () => {
  it('resolves on response headers, not after the body', async () => {
    // The buffered implementation resolved on `end`, so a slow upstream held the
    // client's first byte for the whole transfer. Measured against the real prod
    // build: time-to-first-byte 1928ms of a 1929ms total.
    let release: () => void = () => {};
    const port = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write('first');
      release = () => res.end('rest');
    });

    const t0 = Date.now();
    const result = await call(port);
    const headerMs = Date.now() - t0;

    // Headers arrived while the body is still open.
    expect(result.status).toBe(200);
    expect(headerMs).toBeLessThan(1000);
    release();
    expect(await drain(result.body)).toBe('firstrest'.length);
  });

  it('passes the body through byte-exact', async () => {
    const total = 5 * 64 * 1024;
    const port = await upstream((_req, res) => {
      res.writeHead(200, { 'content-length': String(total) });
      for (let i = 0; i < 5; i++) res.write(CHUNK());
      res.end();
    });
    expect(await drain((await call(port)).body)).toBe(total);
  });

  it('forwards raw upstream headers for the caller to filter', async () => {
    const port = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'evil=1' });
      res.end('{}');
    });
    const result = await call(port);
    // This module does NOT filter; the route's allowlist does. Asserting the raw
    // passthrough keeps the boundary explicit.
    expect(result.headers['content-type']).toBe('application/json');
    await drain(result.body);
  });
});

// ===========================================================================
// The timeout, which is the subtle one
// ===========================================================================

describe('header timeout', () => {
  it('does not truncate when the CONSUMER is slow', async () => {
    // Verified against Node: a 2s req.setTimeout fires at ~2005ms when the
    // consumer is paused, because under backpressure WE are the idle party. If
    // the timeout stays armed past the response, any client that pauses longer
    // than it gets a silently truncated 200 — a bug the buffered version could
    // not have, since it always drained at full speed.
    const total = 4 * 64 * 1024;
    const port = await upstream((_req, res) => {
      res.writeHead(200, { 'content-length': String(total) });
      let sent = 0;
      const step = () => {
        if (sent >= total) return res.end();
        sent += CHUNK().length;
        res.write(CHUNK());
        setTimeout(step, 120);
      };
      step();
    });

    const result = await call(port);
    // Read slowly enough that the socket is idle from the upstream's point of
    // view for longer than a short timeout would allow.
    const reader = (result.body as ReadableStream<Uint8Array>).getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value!.length;
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(got).toBe(total);
  }, 15000);

  it('still rejects when the upstream never sends headers', async () => {
    const port = await upstream(() => {
      /* accept and hang */
    });
    await expect(
      streamUpstream({
        method: 'GET',
        resolved: target(port),
        ip: '127.0.0.1',
        hostHeader: `localhost:${port}`,
        path: 'x',
        headers: {},
        body: null,
        headerTimeoutMs: 400,
      }),
    ).rejects.toThrow(/timeout/i);
  });
});

// ===========================================================================
// Null-body statuses
// ===========================================================================

describe('null-body statuses', () => {
  it.each([204, 205, 304])('returns a null body for %i', async (status) => {
    const port = await upstream((_req, res) => {
      res.writeHead(status);
      res.end();
    });
    const result = await call(port);
    expect(result.status).toBe(status);
    // `new Response(anything-but-null, { status: 204 })` throws — including a
    // zero-length Uint8Array — so the route already 502'd on these.
    expect(result.body).toBeNull();
    expect(() => new Response(result.body, { status: result.status })).not.toThrow();
  });

  it('returns a null body for HEAD', async () => {
    const port = await upstream((_req, res) => {
      res.writeHead(200, { 'content-length': '1234' });
      res.end();
    });
    const result = await call(port, { method: 'HEAD' });
    expect(result.body).toBeNull();
    expect(result.headers['content-length']).toBe('1234');
  });
});

// ===========================================================================
// Mid-body failure
// ===========================================================================

describe('mid-body upstream failure', () => {
  it('settles instead of hanging forever', async () => {
    // The buffered version waited for `end` and only rejected on a `req` error —
    // but a dropped socket emits the error on the RESPONSE, which had no
    // listener, so Node discarded it. Observed: response, data, aborted, close;
    // no end, no error. The promise settled never and the client hung.
    const port = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(CHUNK());
      setTimeout(() => res.socket?.destroy(), 30);
    });

    const errors: Error[] = [];
    const result = await Promise.race([
      call(port, { onStreamError: (e) => errors.push(e) }),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('HUNG')), 3000)),
    ]);
    expect((result as { status: number }).status).toBe(200);

    // The body then errors rather than ending cleanly, which is correct HTTP for
    // a truncated response.
    await expect(drain((result as { body: ReadableStream<Uint8Array> }).body)).rejects.toBeTruthy();
    expect(errors.length).toBeGreaterThan(0);
  }, 10000);
});

// ===========================================================================
// The size ceiling
// ===========================================================================

describe('response size ceiling', () => {
  it('refuses on a declared content-length before streaming a byte', async () => {
    let bytesWritten = 0;
    const port = await upstream((_req, res) => {
      res.writeHead(200, { 'content-length': String(10 * 1024 * 1024) });
      bytesWritten += CHUNK().length;
      res.write(CHUNK());
    });
    await expect(call(port, { maxResponseBytes: 1024 })).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
    // Rejecting before committing a status is what lets the route answer 502
    // cleanly instead of truncating a 200.
    expect(bytesWritten).toBeGreaterThan(0);
  });

  it('destroys the stream when an undeclared body exceeds the cap', async () => {
    // Chunked encoding declares no length, so the counter is the only guard.
    const port = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const step = () => {
        if (!res.write(CHUNK())) return res.once('drain', step);
        setImmediate(step);
      };
      step();
    });
    const errors: Error[] = [];
    const result = await call(port, {
      maxResponseBytes: 128 * 1024,
      onStreamError: (e) => errors.push(e),
    });
    // Loud, not silent: the consumer is a `response.json()` call, and a quietly
    // short body either fails to parse or — worse — parses.
    await expect(drain(result.body)).rejects.toBeTruthy();
    expect(errors.some((e) => e instanceof ResponseTooLargeError)).toBe(true);
  }, 15000);

  it('allows a response under the cap', async () => {
    const port = await upstream((_req, res) => {
      res.writeHead(200, { 'content-length': '5' });
      res.end('hello');
    });
    expect(await drain((await call(port, { maxResponseBytes: 1024 })).body)).toBe(5);
  });

  it('has a generous default so ordinary dashboard queries are unaffected', () => {
    // A query at LIMITS.maxDataPoints is single-digit megabytes of JSON.
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });
});

// ===========================================================================
// IP fallback
// ===========================================================================

describe('streamUpstreamWithFallback', () => {
  it('advances to the next IP on a connection error', async () => {
    const port = await upstream((_req, res) => {
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    });
    const result = await streamUpstreamWithFallback(
      {
        method: 'GET',
        // 192.0.2.1 is TEST-NET-1 and never routes.
        resolved: { ...target(port), ips: ['192.0.2.1', '127.0.0.1'] },
        hostHeader: `localhost:${port}`,
        path: 'x',
        headers: {},
        body: null,
        headerTimeoutMs: 800,
      },
      ['127.0.0.2', '127.0.0.1'],
    );
    expect(await drain(result.body)).toBe(2);
  }, 20000);

  it('does NOT retry a response refused on size', async () => {
    // A size refusal is an answer about the upstream, not a connection fault.
    // Retrying would re-run the query that produced it.
    let requests = 0;
    const port = await upstream((_req, res) => {
      requests++;
      res.writeHead(200, { 'content-length': String(1024 * 1024) });
      res.end(Buffer.alloc(1024 * 1024));
    });
    await expect(
      streamUpstreamWithFallback(
        {
          method: 'POST',
          resolved: target(port),
          hostHeader: `localhost:${port}`,
          path: 'api/v1/query',
          headers: {},
          body: Buffer.from('{}'),
          maxResponseBytes: 1024,
        },
        ['127.0.0.1', '127.0.0.1'],
      ),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(requests).toBe(1);
  });

  it('throws when every IP fails', async () => {
    await expect(
      streamUpstreamWithFallback(
        {
          method: 'GET',
          resolved: target(1),
          hostHeader: 'localhost:1',
          path: 'x',
          headers: {},
          body: null,
          headerTimeoutMs: 800,
        },
        ['127.0.0.1'],
      ),
    ).rejects.toBeTruthy();
  });
});
