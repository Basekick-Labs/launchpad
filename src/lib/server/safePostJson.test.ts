import http from 'node:http';
import dns from 'node:dns/promises';
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

  it('gives up on an endpoint that never answers', async () => {
    const started = Date.now();
    await expect(safePostJson(url('/noheader'), payload, { ...opts, timeoutMs: 300 })).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(await drained()).toBe(0);
  });

  it('rejects a timeoutMs that is not a positive number', async () => {
    await expect(safePostJson(url('/big'), payload, { ...opts, timeoutMs: 0 })).rejects.toThrow(/positive/);
  });
});

/**
 * `localhost` with one listener per address family on the same port, so the
 * first address safeRequest tries can misbehave while the second is healthy.
 */
describe('safePostJson on a host with two addresses', () => {
  const families = async () => (await dns.lookup('localhost', { all: true })).map((a) => a.address);

  async function pair(first: 'refuse' | 'silent') {
    const addrs = await families();
    const hits: Record<string, number> = {};
    const servers: http.Server[] = [];
    const sockets = new Set<net.Socket>();
    let p = 0;
    for (const [i, addr] of addrs.slice(0, 2).entries()) {
      if (i === 0 && first === 'refuse') continue; // nothing listens: connection refused
      const srv = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          hits[addr] = (hits[addr] ?? 0) + 1;
          if (i === 0) return; // silent: the POST is received, never answered
          res.writeHead(204);
          res.end();
        });
      });
      srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
      await new Promise<void>((resolve) => srv.listen({ port: p, host: addr, ipv6Only: true }, resolve));
      p = (srv.address() as AddressInfo).port;
      servers.push(srv);
    }
    if (first === 'refuse' && p === 0) throw new Error('no listener');
    return {
      addrs, hits, port: p,
      close: async () => {
        for (const s of sockets) s.destroy();
        await Promise.all(servers.map((srv) => new Promise<void>((r) => srv.close(() => r()))));
      },
    };
  }

  it('falls back to the next address when the first refuses the connection', async (ctx) => {
    if ((await families()).length < 2) return ctx.skip();
    const t = await pair('refuse');
    try {
      const res = await safePostJson(`http://localhost:${t.port}/hook`, payload, { ...opts, timeoutMs: 1000 });
      expect(res.status).toBe(204);
      expect(t.hits[t.addrs[1]]).toBe(1);
    } finally {
      await t.close();
    }
  });

  it('does not send the POST again to the next address once the first received it', async (ctx) => {
    if ((await families()).length < 2) return ctx.skip();
    // The first port must be free on the second family too; pair() reuses it.
    const t = await pair('silent');
    try {
      await expect(
        safePostJson(`http://localhost:${t.port}/hook`, payload, { ...opts, timeoutMs: 300 }),
      ).rejects.toBeTruthy();
      expect(t.hits[t.addrs[0]]).toBe(1);
      expect(t.hits[t.addrs[1]] ?? 0).toBe(0);
    } finally {
      await t.close();
    }
  });
});
