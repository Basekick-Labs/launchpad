import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeRequest } from './ssrf';

/** /big: 64 KiB in 1 KiB chunks. /drip: one byte every 50 ms, forever. */
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    if (req.url === '/big') {
      for (let i = 0; i < 64; i++) res.write('x'.repeat(1024));
      res.end();
    } else if (req.url === '/small') {
      res.end('tiny');
    } else {
      const timer = setInterval(() => res.write('.'), 50);
      res.on('close', () => clearInterval(timer));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const opts = { allowHttp: true, allowPrivate: true };

describe('safeRequest truncateResponseAt', () => {
  it('resolves with exactly the limit when the body is larger', async () => {
    const res = await safeRequest(`${base}/big`, { ...opts, truncateResponseAt: 512 });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(512);
  });

  it('resolves with the whole body when it is smaller', async () => {
    const res = await safeRequest(`${base}/small`, { ...opts, truncateResponseAt: 512 });
    expect(res.body.toString()).toBe('tiny');
  });

  it('handles a limit that lands on a chunk boundary', async () => {
    const res = await safeRequest(`${base}/big`, { ...opts, truncateResponseAt: 1024 });
    expect(res.body.length).toBe(1024);
  });

  it('wins over maxResponseBytes, so a large healthy body is not a failure', async () => {
    const res = await safeRequest(`${base}/big`, { ...opts, truncateResponseAt: 512, maxResponseBytes: 2048 });
    expect(res.body.length).toBe(512);
  });

  it('rejects a negative or fractional limit', async () => {
    await expect(safeRequest(`${base}/small`, { ...opts, truncateResponseAt: -1 })).rejects.toThrow(/non-negative integer/);
    await expect(safeRequest(`${base}/small`, { ...opts, truncateResponseAt: 1.5 })).rejects.toThrow(/non-negative integer/);
  });
});

describe('safeRequest signal', () => {
  it('ends a request the idle timeout never would', async () => {
    const started = Date.now();
    await expect(
      safeRequest(`${base}/drip`, { ...opts, timeoutMs: 5000, signal: AbortSignal.timeout(300) }),
    ).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects at once when already aborted', async () => {
    await expect(safeRequest(`${base}/small`, { ...opts, signal: AbortSignal.abort() })).rejects.toBeTruthy();
  });
});

describe('safeRequest https to an IP literal', () => {
  it('fails on the TLS handshake, not on an invalid SNI option', async () => {
    // The server speaks plain HTTP, so the handshake fails; before the fix the
    // request never got that far (Node rejects an IP as servername).
    // The exact TLS error code depends on the OpenSSL build; what matters is
    // that it is not Node's invalid-option error.
    const err = await safeRequest(base.replace('http:', 'https:') + '/small', opts).catch((e) => e);
    expect(err?.code).toBeDefined();
    expect(err.code).not.toBe('ERR_INVALID_ARG_VALUE');
  });
});

describe('safeRequest pinTo', () => {
  it('connects to the pinned IP without resolving the host', async () => {
    const url = base.replace('127.0.0.1', 'pinned.invalid') + '/small';
    const res = await safeRequest(url, { ...opts, pinTo: '127.0.0.1' });
    expect(res.body.toString()).toBe('tiny');
  });

  it('applies the policy to the pinned IP', async () => {
    await expect(safeRequest(`${base}/small`, { ...opts, pinTo: '169.254.169.254' })).rejects.toThrow(/forbidden/);
    await expect(safeRequest(`${base}/small`, { allowHttp: true, allowPrivate: false, pinTo: '127.0.0.1' })).rejects.toThrow(/private/);
    await expect(safeRequest(`${base}/small`, { ...opts, pinTo: 'localhost' })).rejects.toThrow(/IP address/);
  });
});
