import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '../capabilities';
import { discoverCapabilities, resetCapabilityCacheForTests, type DiscoveryTarget } from './capabilities';
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
    '/api/v1/schedulers': json(200, {
      cq_scheduler: { running: true, license_valid: true, job_count: 1, jobs: [{ cq_id: 1, cq_name: 'cpu_1m', interval: '1m0s' }] },
      retention_scheduler: {
        enabled: false,
        reason: 'Retention feature not enabled (retention.enabled=false), or the scheduler failed to start (see the startup log)',
      },
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
  resetCapabilityCacheForTests();
  routes = enterpriseRoutes();
  requests = [];
});

afterEach(() => {
  vi.useRealTimers();
});

const PROBE_COUNT = 4 + CAPABILITIES.filter((d) => d.probePath).length; // health, verify, cluster, schedulers
const paths = () => requests.map((r) => r.path).sort();

describe('discoverCapabilities', () => {
  it('sends the admin token on every probe, /health included, and only GETs', async () => {
    await discoverCapabilities(seedInstance(), opts);
    expect(requests.length).toBe(PROBE_COUNT);
    expect(requests.every((r) => r.auth === 'Bearer admin-token' && r.method === 'GET')).toBe(true);
  });

  it('derives states from the answers and persists the reported version', async () => {
    const t = seedInstance();
    const caps = await discoverCapabilities(t, opts);
    expect(caps.capabilities.cluster.state).toBe('available');
    expect(caps.capabilities.rbac.state).toBe('available');
    expect(caps.capabilities.tiering).toEqual({ state: 'disabled', reason: 'disabled_in_config' });
    expect(caps.capabilities.audit_log).toEqual({ state: 'unlicensed', reason: 'not_licensed' });
    expect(caps.capabilities.cq_scheduler).toEqual({
      state: 'available', reason: 'ok', scheduler: { jobCount: 1, schedule: null, nextRun: null },
    });
    expect(caps.capabilities.retention_scheduler).toEqual({ state: 'disabled', reason: 'off_or_failed_to_start' });
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

  it('clears the stored version when the cluster reports none', async () => {
    const t = seedInstance();
    getDb().prepare("UPDATE instances SET detected_arc_version = '26.09.3' WHERE id = ?").run(t.id);
    routes['/api/v1/cluster'] = json(200, { enabled: false, mode: 'standalone', reason: 'Clustering not enabled in configuration' });
    await discoverCapabilities(t, opts);
    const row = getDb().prepare('SELECT detected_arc_version FROM instances WHERE id = ?').get(t.id) as { detected_arc_version: string | null };
    expect(row.detected_arc_version).toBeNull();
  });

  it('shares one probe set between concurrent callers', async () => {
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

  it('re-probes on a forced refresh once the minimum interval has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t = seedInstance();
    await discoverCapabilities(t, opts);
    vi.setSystemTime(Date.now() + 11_000);
    await discoverCapabilities(t, { ...opts, force: true });
    expect(requests.filter((r) => r.path === '/health').length).toBe(2);
  });

  it('caches a partial failure only briefly', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    routes['/api/v1/governance/policies'] = json(500, {});
    const t = seedInstance();
    await discoverCapabilities(t, opts);
    vi.setSystemTime(Date.now() + 16_000);
    await discoverCapabilities(t, opts);
    expect(requests.filter((r) => r.path === '/health').length).toBe(2);
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
    expect(paths()).toEqual(['/api/v1/auth/verify', '/health']);
  });

  it('stops after the token check when Arc rejects the token', async () => {
    routes['/api/v1/auth/verify'] = json(401, { valid: false });
    const caps = await discoverCapabilities(seedInstance(), opts);
    expect(paths()).toEqual(['/api/v1/auth/verify', '/health']);
    expect(caps.capabilities.rbac.reason).toBe('token_rejected');
    expect(caps.capabilities.cluster.reason).toBe('token_rejected');
  });

  it('reports why the schedulers probe failed, and caches that only briefly', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    routes['/api/v1/schedulers'] = json(500, {});
    const t = seedInstance();
    const caps = await discoverCapabilities(t, opts);
    expect(caps.capabilities.cq_scheduler).toEqual({ state: 'unknown', reason: 'error' });
    expect(caps.capabilities.retention_scheduler).toEqual({ state: 'unknown', reason: 'error' });
    vi.setSystemTime(Date.now() + 16_000);
    await discoverCapabilities(t, opts);
    expect(requests.filter((r) => r.path === '/api/v1/schedulers').length).toBe(2);
  });

  it('reports why the cluster probe failed', async () => {
    routes['/api/v1/cluster'] = json(500, {});
    const caps = await discoverCapabilities(seedInstance(), opts);
    expect(caps.capabilities.cluster).toEqual({ state: 'unknown', reason: 'error' });
  });


  it('probes only /health without a stored token', async () => {
    const caps = await discoverCapabilities(seedInstance(null), opts);
    expect(requests.map((r) => r.path)).toEqual(['/health']);
    expect(requests[0].auth).toBeUndefined();
    expect(caps.license?.tier).toBe('enterprise');
    expect(caps.capabilities.rbac.reason).toBe('no_token');
  });

  it('reports a non-admin token instead of probing admin routes with it', async () => {
    routes['/api/v1/auth/verify'] = json(200, { valid: true, permissions: ['read', 'write'] });
    const caps = await discoverCapabilities(seedInstance(), opts);
    // Each 403 would be an auth-failure tick in Arc; cluster and schedulers
    // take any token.
    expect(paths()).toEqual(['/api/v1/auth/verify', '/api/v1/cluster', '/api/v1/schedulers', '/health']);
    expect(caps.tokenIsAdmin).toBe(false);
    expect(caps.capabilities.rbac.reason).toBe('token_not_admin');
    expect(caps.capabilities.cluster.state).toBe('available');
    expect(caps.capabilities.cq_scheduler.state).toBe('available');
  });

  it('reads the 403 wording when verify gave no permissions', async () => {
    routes['/api/v1/auth/verify'] = json(500, {});
    routes['/api/v1/tiering/policies'] = json(403, { error: 'Permission denied: admin required', success: false });
    const caps = await discoverCapabilities(seedInstance(), opts);
    expect(caps.capabilities.tiering).toEqual({ state: 'unknown', reason: 'token_not_admin' });
  });
});
