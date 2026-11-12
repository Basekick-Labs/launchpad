import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { safePostJson } from './ssrf';

/**
 * A webhook receiver that misbehaves on purpose. Each path is one way a
 * configured endpoint can answer a POST:
 *   /big      202 and 4 MiB of body
 *   /drip     200, then one body byte every 50 ms, forever
 *   /silent   200 headers, then no body and no end
 *   /noheader reads the POST and never answers
 * Listens on '::' (dual stack) so `localhost` can resolve to two addresses.
 */
let server: http.Server;
let port = 0;
let posts = 0;
const open = new Set<http.ServerResponse>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      posts++;
      open.add(res);
      res.on('close', () => open.delete(res));
      if (req.url === '/big') {
        res.writeHead(202, { 'content-type': 'text/plain' });
        const chunk = 'x'.repeat(64 * 1024);
        for (let i = 0; i < 64; i++) res.write(chunk);
        res.end();
      } else if (req.url === '/drip') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        const timer = setInterval(() => res.write('.'), 50);
        res.on('close', () => clearInterval(timer));
      } else if (req.url === '/silent') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.flushHeaders();
      }
      // /noheader: never answer.
    });
  });
  await new Promise<void>((resolve) => server.listen({ port: 0, host: '::', ipv6Only: false }, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  for (const res of open) res.destroy();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  posts = 0;
});

const opts = { allowHttp: true, allowPrivate: true };
const url = (path: string, host = '127.0.0.1') => `http://${host}:${port}${path}`;
const payload = JSON.stringify({ alert: 'cl_test', value: 1 });
/** Wait for the server side to see every connection closed. */
const drained = async () => {
  for (let i = 0; i < 50 && open.size > 0; i++) await new Promise((r) => setTimeout(r, 20));
  return open.size;
};

describe('safePostJson response handling', () => {
  it('reports a delivered webhook as delivered however large its response body', async () => {
    const res = await safePostJson(url('/big'), payload, { ...opts, timeoutMs: 2000 });
    expect(res.status).toBe(202);
    expect(posts).toBe(1);
  });

  it('sends the POST once to a host with two addresses, even with a large response', async () => {
    const res = await safePostJson(url('/big', 'localhost'), payload, { ...opts, timeoutMs: 2000 });
    expect(res.status).toBe(202);
    expect(posts).toBe(1);
  });

  it('returns on the status line without waiting for a body that drips', async () => {
    const started = Date.now();
    const res = await safePostJson(url('/drip'), payload, { ...opts, timeoutMs: 2000 });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await drained()).toBe(0); // the connection is closed, not left open
  });

  it('returns on the status line when no body ever follows', async () => {
    const started = Date.now();
    const res = await safePostJson(url('/silent'), payload, { ...opts, timeoutMs: 2000 });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await drained()).toBe(0);
  });

  it('gives up on headers that drip, which the idle timeout never catches', async () => {
    // A byte of header every 50 ms keeps the socket busy, so only an overall
    // deadline ends it.
    const sockets = new Set<net.Socket>();
    const dripper = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 OK\r\nX-Drip: ');
        const timer = setInterval(() => socket.write('a'), 50);
        socket.on('close', () => { clearInterval(timer); sockets.delete(socket); });
        socket.on('error', () => {});
      });
    });
    await new Promise<void>((resolve) => dripper.listen(0, '127.0.0.1', resolve));
    const dripPort = (dripper.address() as AddressInfo).port;
    try {
      const started = Date.now();
      await expect(
        safePostJson(`http://127.0.0.1:${dripPort}/hook`, payload, { ...opts, timeoutMs: 300 }),
      ).rejects.toBeTruthy();
      expect(Date.now() - started).toBeLessThan(1500);
      for (let i = 0; i < 50 && sockets.size > 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(sockets.size).toBe(0);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => dripper.close(() => resolve()));
    }
  }, 10_000);

  it('gives up on an endpoint that never answers, within timeoutMs overall', async () => {
    const started = Date.now();
    await expect(safePostJson(url('/noheader'), payload, { ...opts, timeoutMs: 300 })).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(await drained()).toBe(0);
  });
});
