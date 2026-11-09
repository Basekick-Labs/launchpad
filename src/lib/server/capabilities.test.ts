import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearCapabilityCache, discoverCapabilities, type DiscoveryTarget } from './capabilities';
import { getDb } from './db';

/**
 * A fake Arc: each path answers from `routes`, and every request is recorded
 * so tests can assert what discovery sent.
 */
type Route = { status: number; body: string; delayMs?: number };
let routes: Record<string, Route> = {};
let requests: Array<{ path: string; method: string; auth: string | undefined }> = [];
let server: http.Server;
let base = '';

const json = (status: number, body: unknown): Route => ({ status, body: JSON.stringify(body) });

function enterpriseRoutes(): Record<string, Route> {
  return {
    '/health': json(200, { status: 'ok', license: { tier: 'enterprise', status: 'active', expires_at: '2031-01-07T19:20:56Z' } }),
    '/api/v1/auth/verify': json(200, { valid: true, permissions: ['read', 'write', 'delete', 'admin'] }),
    '/api/v1/cluster': json(200, {
      enabled: true, mode: 'cluster', local_node_id: 'n1', nodes: [{ id: 'n1', version: '27.01.1' }],
      license: { valid: true, tier: 'enterprise', features: ['clustering', 'rbac', 'tiering'] },
    }),
    '/api/v1/rbac/organizations': json(200, { count: 0, organizations: [] }),
    '/api/v1/tiering/policies': json(404, { error: 'Cannot GET /api/v1/tiering/policies' }),
    '/api/v1/governance/policies': json(404, { error: 'Cannot GET' }),
    '/api/v1/queries/active': json(404, { error: 'Cannot GET' }),
    '/api/v1/audit/logs?limit=1': json(404, { error: 'Cannot GET' }),
    '/api/v1/backup/status': json(200, { status: 'idle' }),
    '/api/v1/compaction/status': json(200, { manager: {} }),
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ path: req.url ?? '', method: req.method ?? '', auth: req.headers.authorization });
    const route = routes[req.url ?? ''] ?? { status: 404, body: '{}' };
    const send = () => {
      res.writeHead(route.status, { 'content-type': 'application/json' });
      res.end(route.body);
    };
    if (route.delayMs) setTimeout(send, route.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let seq = 0;
function seedInstance(token: string | null = 'admin-token'): DiscoveryTarget {
  const db = getDb();
  const id = `inst-${++seq}`;
  db.prepare('INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)').run('u1', 'u1@example.test');
  db.prepare('INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('o1', 'Org', 'u1');
  db.prepare('INSERT INTO instances (id, org_id, resource_id, endpoint_url, status, admin_token) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'o1', `res-${seq}`, base, 'running', token);
  return { id, endpoint_url: base, admin_token: token };
}

const opts = { allowPrivate: true };

beforeEach(() => {
  clearCapabilityCache();
  routes = enterpriseRoutes();
  requests = [];
});

describe('discoverCapabilities', () => {
  it('sends the admin token on every probe, /health included, and only GETs', async () => {
    await discoverCapabilities(seedInstance(), opts);
    expect(requests.length).toBe(10);
    expect(requests.every((r) => r.auth === 'Bearer admin-token' && r.method === 'GET')).toBe(true);
  });

  it('derives states from the answers and persists the reported version', async () => {
    const t = seedInstance();
    const caps = await discoverCapabilities(t, opts);
    expect(caps.capabilities.cluster.state).toBe('available');
    expect(caps.capabilities.rbac.state).toBe('available');
    expect(caps.capabilities.tiering).toEqual({ state: 'disabled', reason: 'disabled_in_config' });
    expect(caps.capabilities.audit_log).toEqual({ state: 'unlicensed', reason: 'not_licensed' });
    const row = getDb().prepare('SELECT detected_arc_version FROM instances WHERE id = ?').get(t.id) as { detected_arc_version: string };
    expect(row.detected_arc_version).toBe('27.01.1');
  });

  it('does not write a version to a row whose endpoint changed meanwhile', async () => {
    const t = seedInstance();
    getDb().prepare("UPDATE instances SET endpoint_url = 'https://elsewhere.example' WHERE id = ?").run(t.id);
    await discoverCapabilities(t, opts);
    const row = getDb().prepare('SELECT detected_arc_version FROM instances WHERE id = ?').get(t.id) as { detected_arc_version: string | null };
    expect(row.detected_arc_version).toBeNull();
  });

  it('treats a large healthy body as available, reading only its head', async () => {
    routes['/api/v1/rbac/organizations'] = json(200, { organizations: 'x'.repeat(2 * 1024 * 1024) });
    const caps = await discoverCapabilities(seedInstance(), opts);
    expect(caps.capabilities.rbac.state).toBe('available');
  });

  it('shares one probe set between concurrent callers', async () => {
    routes['/health'].delayMs = 50;
    const t = seedInstance();
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => discoverCapabilities(t, opts)));
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(requests.filter((r) => r.path === '/health').length).toBe(1);
  });

  it('serves the cache until forced, and rate-limits forcing', async () => {
    const t = seedInstance();
    await discoverCapabilities(t, opts);
    await discoverCapabilities(t, opts);
    await discoverCapabilities(t, { ...opts, force: true }); // within MIN_REFRESH_INTERVAL_MS
    expect(requests.filter((r) => r.path === '/health').length).toBe(1);
  });

  it('re-probes when the stored token changes', async () => {
    const t = seedInstance();
    await discoverCapabilities(t, opts);
    await discoverCapabilities({ ...t, admin_token: 'rotated' }, opts);
    expect(requests.filter((r) => r.path === '/health').map((r) => r.auth)).toEqual(['Bearer admin-token', 'Bearer rotated']);
  });

  it('stops after /health when Arc is down, and caches the failure', async () => {
    routes['/health'] = json(503, {});
    const t = seedInstance();
    const caps = await discoverCapabilities(t, opts);
    await discoverCapabilities(t, opts);
    expect(caps.reachable).toBe(false);
    expect(requests.map((r) => r.path)).toEqual(['/health']);
  });

  it('probes only /health without a stored token', async () => {
    const caps = await discoverCapabilities(seedInstance(null), opts);
    expect(requests.map((r) => r.path)).toEqual(['/health']);
    expect(requests[0].auth).toBeUndefined();
    expect(caps.license?.tier).toBe('enterprise');
    expect(caps.capabilities.rbac.reason).toBe('no_token');
  });

  it('reports a non-admin token instead of guessing licenses', async () => {
    routes['/api/v1/auth/verify'] = json(200, { valid: true, permissions: ['read', 'write'] });
    for (const p of ['/api/v1/rbac/organizations', '/api/v1/tiering/policies', '/api/v1/backup/status']) {
      routes[p] = json(403, { error: 'Permission denied: admin required', success: false });
    }
    const caps = await discoverCapabilities(seedInstance(), opts);
    expect(caps.tokenIsAdmin).toBe(false);
    expect(caps.capabilities.rbac.reason).toBe('token_not_admin');
    expect(caps.capabilities.tiering.reason).toBe('token_not_admin');
  });
});
