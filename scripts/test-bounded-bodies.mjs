#!/usr/bin/env node
/**
 * Production-adapter regression test. Run after `npm run build`:
 *   node scripts/test-bounded-bodies.mjs
 *
 * Uses only a temporary SQLite database, a disposable JWT secret and loopback
 * servers. Never connects to a real Arc instance. Linux is required for the
 * peak-memory assertion; other platforms fail rather than silently skip it.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

const MiB = 1024 * 1024;
// Must match the production configuration; the test can also exercise an
// operator-selected limit. The parent process's real data/secrets are unused.
const proxyLimit = Number(process.env.TEST_PROXY_BODY_BYTES || process.env.LAUNCHPAD_PROXY_BODY_SIZE_LIMIT || 8 * MiB);
assert(Number.isSafeInteger(proxyLimit) && proxyLimit >= MiB, 'test proxy cap must be an integer >= 1 MiB');
assert.equal(process.platform, 'linux', 'Linux /proc is required for the peak-RSS assertion');
const secret = 'bounded-body-regression-disposable-test-secret';
const cookie = `arc_session=${jwt.sign({ userId: 'body-user', email: 'body@example.test', name: 'Body Test', tv: 0 }, secret, {
  algorithm: 'HS256', issuer: 'arc-launchpad', audience: 'arc-launchpad:session', expiresIn: '5m',
})}`;
const proxyPath = '/api/v1/orgs/body-org/instances/body-instance/proxy/api/v1/write';
const profilePath = '/api/v1/users/profile';
const directory = await mkdtemp(join(tmpdir(), 'launchpad-body-test-'));
const servers = new Set();
const children = new Set();
let upstreamRequests = 0;

async function listen(server) {
  servers.add(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  servers.delete(server);
  return port;
}

// The caller supplies either bytes or a repeated chunk. Backpressure is obeyed
// and only one 64 KiB chunk is outstanding per writer, so client memory does
// not grow with the advertised attack stream size (and is a separate process).
function request(port, path, { method = 'POST', headers = {}, bytes, total, chunk, declared = false, authenticated = true } = {}) {
  const length = bytes?.length ?? total ?? 0;
  const label = `${method} ${path} (${length} bytes, declared=${declared})`;
  return new Promise((resolve, reject) => {
    let stopped = false;
    let sent = 0;
    let responseSeen = false;
    const fail = (err) => reject(new Error(`${label}, sent=${sent}, responseSeen=${responseSeen}, reusedSocket=${req.reusedSocket}: ${err.message}`, { cause: err }));
    // Each case owns its connection. An early 413 intentionally leaves an
    // unfinished upload; never return that socket to Node's global keep-alive
    // pool while the client is destroying it after receiving the response.
    const req = http.request({ agent: false, hostname: '127.0.0.1', port, path, method, headers: {
      accept: '*/*',
      ...(authenticated ? { cookie } : {}),
      ...(declared ? { 'content-length': String(length) } : {}),
      ...headers,
    } }, (res) => {
      responseSeen = true;
      const parts = [];
      res.on('data', (part) => parts.push(part));
      res.on('error', fail);
      res.on('end', () => {
        stopped = true;
        const result = { status: res.statusCode, body: Buffer.concat(parts).toString(), sent };
        req.destroy();
        resolve(result);
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`request timed out: ${path}`)));
    req.on('error', (err) => {
      if (!stopped && !responseSeen) { stopped = true; fail(err); }
    });
    (async () => {
      while (!stopped && sent < length) {
        const amount = Math.min(64 * 1024, length - sent);
        const part = bytes ? bytes.subarray(sent, sent + amount) : chunk.subarray(0, amount);
        sent += part.length;
        if (!req.write(part)) {
          // A response can close the request while backpressure is active.
          await new Promise((resolve) => {
            const finish = () => {
              req.off('drain', finish);
              req.off('close', finish);
              resolve();
            };
            req.once('drain', finish);
            req.once('close', finish);
          });
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (!stopped) req.end();
    })().catch((err) => { if (!stopped && !responseSeen) fail(err); });
  });
}

function expectStatus(result, status, label, appError = false) {
  assert.equal(result.status, status, `${label}: ${result.body.slice(0, 200)}`);
  if (appError) assert.equal(typeof JSON.parse(result.body).error, 'string', `${label}: missing API error text`);
}

async function rss(pid) {
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  const current = Number(status.match(/^VmRSS:\s+(\d+) kB/m)?.[1]);
  const peak = Number(status.match(/^VmHWM:\s+(\d+) kB/m)?.[1]);
  assert(Number.isFinite(current) && Number.isFinite(peak), 'missing Linux RSS measurements');
  return { current: current * 1024, peak: peak * 1024 };
}

async function startApp(name, upstreamPort) {
  const port = await unusedPort();
  const dbPath = join(directory, `${name}.sqlite`);
  const child = spawn(process.execPath, ['build/index.js'], {
    cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
      LAUNCHPAD_DB_PATH: dbPath, LAUNCHPAD_JWT_SECRET: secret,
      LAUNCHPAD_BASE_URL: `http://127.0.0.1:${port}`, ORIGIN: `http://127.0.0.1:${port}`,
      LAUNCHPAD_ALLOW_PRIVATE_ENDPOINTS: 'true',
      LAUNCHPAD_PROXY_BODY_SIZE_LIMIT: String(proxyLimit), BODY_SIZE_LIMIT: String(proxyLimit),
    },
  });
  children.add(child);
  let logs = '';
  child.stdout.on('data', (b) => { logs += b; });
  child.stderr.on('data', (b) => { logs += b; });
  const deadline = Date.now() + 20_000;
  while (true) {
    try { await request(port, '/', { method: 'GET', authenticated: false }); break; }
    catch (error) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`app did not start: ${logs}\n${error}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (name === 'functional') {
    const formOverflow = await request(port, '/setup?/complete', {
      total: MiB + 1, chunk: Buffer.alloc(64 * 1024, 0x61), authenticated: false,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://127.0.0.1:${port}` },
    });
    expectStatus(formOverflow, 413, 'first-run setup form overflow');
    const malformedForm = await request(port, '/setup?/complete', {
      bytes: Buffer.from('not a multipart document'), authenticated: false,
      headers: { 'content-type': 'multipart/form-data; boundary=test-boundary', origin: `http://127.0.0.1:${port}` },
    });
    expectStatus(malformedForm, 400, 'malformed setup multipart');
  }
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.prepare('INSERT INTO users (id, email, first_name, email_verified) VALUES (?, ?, ?, 1)').run('body-user', 'body@example.test', 'Body');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('body-org', 'Body test', 'body-user');
  db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)').run('body-org', 'body-user', 'owner');
  db.prepare('INSERT INTO instances (id, org_id, resource_id, endpoint_url, admin_token) VALUES (?, ?, ?, ?, ?)')
    .run('body-instance', 'body-org', 'body-resource', `http://127.0.0.1:${upstreamPort}`, 'test-upstream-token');
  db.close();
  return { port, child, logs: () => logs };
}

async function stopApp(app) {
  app.child.kill('SIGTERM');
  if (app.child.exitCode === null) await once(app.child, 'exit');
  children.delete(app.child);
}

try {
  const upstream = http.createServer((req, res) => {
    upstreamRequests++;
    assert.equal(req.headers.authorization, 'Bearer test-upstream-token');
    let length = 0;
    const hash = createHash('sha256');
    req.on('data', (b) => { length += b.length; hash.update(b); });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ length, sha256: hash.digest('hex') }));
    });
  });
  const upstreamPort = await listen(upstream);
  const app = await startApp('functional', upstreamPort);
  const jsonHeaders = { 'content-type': 'application/json' };
  expectStatus(await request(app.port, profilePath, { method: 'PATCH', bytes: Buffer.from('{'), headers: jsonHeaders }), 400, 'malformed JSON', true);
  expectStatus(await request(app.port, profilePath, { method: 'PATCH', bytes: Buffer.from('null'), headers: jsonHeaders }), 400, 'null JSON', true);
  expectStatus(await request(app.port, profilePath, { method: 'PATCH', bytes: Buffer.from('{}'), headers: { 'content-type': 'application/octet-stream' } }), 415, 'wrong content type', true);
  expectStatus(await request(app.port, profilePath, { method: 'PATCH', bytes: Buffer.from([0xc3, 0x28]), headers: jsonHeaders }), 400, 'invalid UTF-8', true);
  expectStatus(await request(app.port, profilePath, { method: 'PATCH', bytes: Buffer.alloc(0), headers: jsonHeaders }), 400, 'empty JSON', true);
  const prefix = '{"first_name":"Body","padding":"';
  const exactJson = Buffer.from(prefix + 'x'.repeat(MiB - Buffer.byteLength(prefix) - 2) + '"}');
  assert.equal(exactJson.length, MiB);
  expectStatus(await request(app.port, profilePath, { method: 'PATCH', bytes: exactJson, headers: jsonHeaders, declared: true }), 200, 'exact 1 MiB declared JSON');
  expectStatus(await request(app.port, profilePath, { method: 'PATCH', bytes: exactJson, headers: jsonHeaders }), 200, 'exact 1 MiB chunked JSON');
  expectStatus(await request(app.port, profilePath, { method: 'PATCH', total: MiB + 1, chunk: Buffer.alloc(64 * 1024), headers: jsonHeaders }), 413, 'JSON actual overflow', true);
  expectStatus(await request(app.port, profilePath, { method: 'PATCH', total: MiB + 1, chunk: Buffer.alloc(64 * 1024), declared: true, headers: jsonHeaders }), 413, 'JSON declared overflow', true);

  const binary = Buffer.alloc(proxyLimit);
  for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
  for (const declared of [false, true]) {
    const response = await request(app.port, proxyPath, { bytes: binary, declared, headers: { 'content-type': 'application/msgpack' } });
    expectStatus(response, 200, `exact cap binary, declared=${declared}`);
    assert.deepEqual(JSON.parse(response.body), { length: binary.length, sha256: createHash('sha256').update(binary).digest('hex') });
  }
  const empty = await request(app.port, proxyPath, { method: 'DELETE', declared: true });
  expectStatus(empty, 200, 'empty DELETE');
  assert.equal(JSON.parse(empty.body).length, 0);
  for (const declared of [false, true]) {
    const before = upstreamRequests;
    const response = await request(app.port, proxyPath, { total: proxyLimit + 1, chunk: Buffer.alloc(64 * 1024), declared, headers: { 'content-type': 'application/octet-stream' } });
    expectStatus(response, 413, `proxy overflow, declared=${declared}`, !declared);
    assert.equal(upstreamRequests, before, 'oversized request reached upstream');
  }
  const beforeUnauthenticated = upstreamRequests;
  expectStatus(await request(app.port, proxyPath, { bytes: Buffer.from('small'), authenticated: false }), 401, 'unauthenticated proxy');
  assert.equal(upstreamRequests, beforeUnauthenticated);
  await stopApp(app);
  console.log(JSON.stringify({ functional: 'passed', jsonLimit: MiB, proxyLimit }));

  // A fresh process avoids letting the exact-limit allocation tests inflate
  // the RSS baseline. Warm only the small successful proxy/auth path first.
  const memoryApp = await startApp('memory', upstreamPort);
  for (let i = 0; i < 3; i++) expectStatus(await request(memoryApp.port, proxyPath, { bytes: Buffer.from('warm'), headers: { 'content-type': 'application/octet-stream' } }), 200, 'memory warmup');
  const baseline = await rss(memoryApp.child.pid);
  const concurrency = 4;
  const offeredPerRequest = Math.max(128 * MiB, proxyLimit * 16);
  // Budget allows transient old/new buffers during geometric growth, 2 MiB
  // per connection for transport overhead, plus 64 MiB of GC/native warmup
  // slack. It is intentionally much smaller than complete buffering
  // of all offered streams, and is a regression ceiling, not a capacity SLA.
  const growthBudget = 64 * MiB + concurrency * (2 * proxyLimit + 2 * MiB);
  assert(offeredPerRequest * concurrency > growthBudget * 2, 'offered attack is too small to distinguish unbounded buffering');
  const beforeAttack = upstreamRequests;
  const responses = await Promise.all(Array.from({ length: concurrency }, () => request(memoryApp.port, proxyPath, {
    total: offeredPerRequest, chunk: Buffer.alloc(64 * 1024, 0xff), headers: { 'content-type': 'application/octet-stream' },
  })));
  for (const response of responses) expectStatus(response, 413, 'concurrent chunked attack', true);
  assert.equal(upstreamRequests, beforeAttack, 'attack was forwarded upstream');
  const after = await rss(memoryApp.child.pid);
  const growth = Math.max(0, after.peak - baseline.current);
  assert(growth <= growthBudget, `peak RSS growth ${growth} exceeded ${growthBudget}`);
  console.log(JSON.stringify({ memory: 'passed', concurrency, offeredPerRequest, sentPerRequest: responses.map((r) => r.sent), baselineRss: baseline.current, baselinePeakRss: baseline.peak, peakRss: after.peak, peakRssGrowth: growth, growthBudget }));
  await stopApp(memoryApp);
} finally {
  await Promise.all([...children].map(async (child) => {
    child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }));
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  await rm(directory, { recursive: true, force: true });
}
