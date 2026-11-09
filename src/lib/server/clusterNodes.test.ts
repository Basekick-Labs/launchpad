import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getClusterView,
  getNodeLogs,
  getNodeSnapshot,
  resetClusterCachesForTests,
  type ClusterTarget,
} from './clusterNodes';
import type { ClusterStatus } from '../cluster';
import { parseCidr } from './ssrf';

/**
 * Three fake Arc nodes on loopback. Each answers as itself on
 * /api/v1/cluster/local; node "a" is the instance endpoint and reports the
 * topology, whose api_address values each test can rewrite.
 */
interface FakeNode {
  id: string;
  server: http.Server;
  port: number;
  requests: Array<{ path: string; auth: string | undefined }>;
}

const nodes: Record<string, FakeNode> = {};
let apiAddress: Record<string, string> = {};
let clusterOverride: unknown = null;
let clusterStatusCode = 200;

const TOKEN = 'admin-token';
const opts = { allowPrivate: true, nodeCidrs: [] };
let seriesStatus = 200;
let metricsStatus = 200;
let logsStatus = 200;
let clusterNameOverride: string | undefined | null = 'test-cluster';

function topology() {
  return {
    enabled: true,
    mode: 'cluster',
    ...(clusterNameOverride === null ? {} : { cluster_name: clusterNameOverride }),
    local_node_id: 'a',
    raft: { enabled: true, leader_id: 'a', state: 'Leader' },
    nodes: ['a', 'b', 'c'].map((id) => ({
      id, name: id, role: id === 'c' ? 'reader' : 'writer', state: 'healthy',
      address: `127.0.0.1:${9000 + id.charCodeAt(0)}`,
      api_address: apiAddress[id],
      version: '27.01.1',
      last_heartbeat: '2026-11-09T18:00:00Z',
    })),
  };
}

function handler(id: string) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const node = nodes[id];
    node.requests.push({ path: req.url ?? '', auth: req.headers.authorization });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://x');
    switch (url.pathname) {
      case '/api/v1/cluster':
        return send(clusterStatusCode, clusterOverride ?? topology());
      case '/api/v1/cluster/health':
        return send(200, { health_checker: { check_interval_ms: 5000 } });
      case '/api/v1/cluster/local':
        return send(200, { id, cluster_name: 'test-cluster' });
      case '/health':
        return send(200, { status: 'ok' });
      case '/api/v1/metrics':
        return send(metricsStatus, { num_cpu: 4, memory_sys_bytes: 1024, uptime_seconds: 60, not_a_metric: 'x' });
      case '/api/v1/metrics/timeseries/api':
        if (seriesStatus !== 200) return send(seriesStatus, {});
      // fallthrough
      case '/api/v1/metrics/timeseries/system':
      case '/api/v1/metrics/timeseries/application':
        return send(200, {
          data: [
            { timestamp: '2026-11-09T18:00:00Z', values: { goroutines: 40, http_requests_total: 10, ingest_records_total: 5, secret: 1 } },
            { timestamp: '2026-11-09T18:05:00Z', values: { goroutines: 42, http_requests_total: 20, ingest_records_total: 9 } },
          ],
        });
      case '/api/v1/logs':
        if (logsStatus !== 200) return send(logsStatus, { error: 'Permission denied: admin required' });
        return send(200, { logs: [{ timestamp: '2026-11-09T18:00:00Z', level: 'warn', message: `from ${id}`, component: 'cluster' }] });
      default:
        return send(404, { error: 'Cannot GET' });
    }
  };
}

beforeAll(async () => {
  for (const id of ['a', 'b', 'c']) {
    const server = http.createServer(handler(id));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    nodes[id] = { id, server, port: (server.address() as AddressInfo).port, requests: [] };
  }
});

afterAll(() => Promise.all(Object.values(nodes).map((n) => new Promise<void>((r) => n.server.close(() => r())))));

let seq = 0;
function target(overrides: Partial<ClusterTarget> = {}): ClusterTarget {
  return { id: `inst-${++seq}`, endpoint_url: `http://127.0.0.1:${nodes.a.port}`, admin_token: TOKEN, node_scheme: null, ...overrides };
}

const all = () => Object.values(nodes).flatMap((n) => n.requests.map((r) => ({ node: n.id, ...r })));

/** A port nothing listens on: bind, note it, close. */
async function deadPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

beforeEach(() => {
  resetClusterCachesForTests();
  for (const n of Object.values(nodes)) n.requests = [];
  apiAddress = Object.fromEntries(Object.values(nodes).map((n) => [n.id, `127.0.0.1:${n.port}`]));
  clusterOverride = null;
  clusterStatusCode = 200;
  seriesStatus = 200;
  metricsStatus = 200;
  logsStatus = 200;
  clusterNameOverride = 'test-cluster';
});

describe('getClusterView', () => {
  it('reads topology with the token, and checks reachability without it', async () => {
    const view = await getClusterView(target(), opts);
    expect((view.status as ClusterStatus).nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(view.checkIntervalMs).toBe(5000);
    expect(view.serverTime).not.toBeNull();
    expect(view.reachability).toEqual({
      a: { reachable: true, error: null }, b: { reachable: true, error: null }, c: { reachable: true, error: null },
    });
    const health = all().filter((r) => r.path === '/health');
    expect(health).toHaveLength(3);
    expect(health.every((r) => r.auth === undefined)).toBe(true);
    expect(all().find((r) => r.path === '/api/v1/cluster')?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it('fills a host-less or wildcard api_address from the coordinator host, as Arc does', async () => {
    apiAddress.b = `:${nodes.b.port}`;
    apiAddress.c = `0.0.0.0:${nodes.c.port}`;
    const view = await getClusterView(target(), opts);
    expect(view.reachability.b).toEqual({ reachable: true, error: null });
    expect(view.reachability.c).toEqual({ reachable: true, error: null });
  });

  it('never contacts metadata addresses, even with private endpoints allowed', async () => {
    apiAddress.b = '169.254.169.254:80';
    const view = await getClusterView(target(), opts);
    expect(view.reachability.b).toEqual({ reachable: false, error: 'address_blocked' });
    expect(view.reachability.a).toEqual({ reachable: true, error: null });
  });

  it('keeps nodes to the endpoint\'s /24 unless the operator widens it', async () => {
    apiAddress.b = `127.0.1.1:${nodes.b.port}`; // loopback, but outside 127.0.0.0/24
    expect((await getClusterView(target(), opts)).reachability.b).toEqual({ reachable: false, error: 'address_blocked' });
    resetClusterCachesForTests();
    const widened = { ...opts, nodeCidrs: [parseCidr('127.0.0.0/8')!] };
    expect((await getClusterView(target(), widened)).reachability.b.error).not.toBe('address_blocked');
  });

  it('reports standalone without probing nodes', async () => {
    clusterOverride = { success: false, enabled: false, mode: 'standalone', reason: 'Clustering not enabled in configuration' };
    const view = await getClusterView(target(), opts);
    expect(view.status).toEqual({ enabled: false, reason: 'Clustering not enabled in configuration' });
    expect(all().filter((r) => r.path === '/health')).toHaveLength(0);
  });

  it('maps a rejected token', async () => {
    clusterStatusCode = 401;
    await expect(getClusterView(target(), opts)).rejects.toMatchObject({ code: 'token_rejected' });
  });

  it('is shared between concurrent callers, and keyed by the stored token', async () => {
    const t = target();
    await Promise.all([getClusterView(t, opts), getClusterView(t, opts), getClusterView(t, opts)]);
    expect(all().filter((r) => r.path === '/api/v1/cluster')).toHaveLength(1);
    await getClusterView({ ...t, admin_token: 'rotated' }, opts);
    expect(all().filter((r) => r.path === '/api/v1/cluster')).toHaveLength(2);
  });
});

describe('getNodeSnapshot', () => {
  it('verifies identity with the token, then reads metrics without it', async () => {
    const snap = await getNodeSnapshot(target(), 'b', 15, opts);
    expect(snap.nodeId).toBe('b');
    expect(snap.source).toBe(`127.0.0.1:${nodes.b.port}`);
    expect(snap.snapshot).toEqual({ num_cpu: 4, memory_sys_bytes: 1024, uptime_seconds: 60 });
    expect(snap.series.system[1].values).toEqual({ goroutines: 42 });
    expect(snap.spanMinutes).toBe(5);

    const b = nodes.b.requests;
    expect(b.find((r) => r.path === '/api/v1/cluster/local')?.auth).toBe(`Bearer ${TOKEN}`);
    const metrics = b.filter((r) => r.path.startsWith('/api/v1/metrics'));
    expect(metrics).toHaveLength(4);
    expect(metrics.every((r) => r.auth === undefined)).toBe(true);
    expect(b.find((r) => r.path.includes('timeseries/system'))?.path).toContain('duration_minutes=15');
  });

  it('refuses data from an address that answers as another node', async () => {
    apiAddress.b = `127.0.0.1:${nodes.c.port}`; // b's address actually reaches c
    await expect(getNodeSnapshot(target(), 'b', 15, opts)).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(nodes.c.requests.some((r) => r.path.startsWith('/api/v1/metrics'))).toBe(false);
  });

  it('requires the cluster name: a topology that omits it cannot skip the check', async () => {
    clusterNameOverride = null;
    await expect(getNodeSnapshot(target(), 'b', 15, opts)).rejects.toMatchObject({ code: 'identity_mismatch' });
  });

  it('caches and shares concurrent loads', async () => {
    const t = target();
    await Promise.all([getNodeSnapshot(t, 'c', 15, opts), getNodeSnapshot(t, 'c', 15, opts)]);
    await getNodeSnapshot(t, 'c', 15, opts);
    expect(nodes.c.requests.filter((r) => r.path === '/api/v1/metrics')).toHaveLength(1);
    expect(nodes.c.requests.filter((r) => r.path === '/api/v1/cluster/local')).toHaveLength(1);
  });

  it('leaves a failed series empty instead of failing the snapshot', async () => {
    seriesStatus = 500;
    const snap = await getNodeSnapshot(target(), 'b', 15, opts);
    expect(snap.series.api).toEqual([]);
    expect(snap.series.system).toHaveLength(2);
  });

  it('reports a metrics failure as an upstream error', async () => {
    metricsStatus = 500;
    await expect(getNodeSnapshot(target(), 'b', 15, opts)).rejects.toMatchObject({ code: 'upstream_status' });
  });

  it('reports a node that is down, without re-dialling it on the next call', async () => {
    apiAddress.b = `127.0.0.1:${await deadPort()}`;
    const t = target();
    await expect(getNodeSnapshot(t, 'b', 15, opts)).rejects.toMatchObject({ code: 'unreachable' });
    await expect(getNodeSnapshot(t, 'b', 15, opts)).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('names a TLS failure when the node scheme does not match', async () => {
    await expect(getNodeSnapshot(target({ node_scheme: 'https' }), 'b', 15, opts)).rejects.toMatchObject({ code: 'tls_error' });
  });

  it('rejects unknown nodes and standalone instances', async () => {
    await expect(getNodeSnapshot(target(), 'zzz', 15, opts)).rejects.toMatchObject({ code: 'not_found' });
    clusterOverride = { enabled: false, reason: 'x' };
    await expect(getNodeSnapshot(target(), 'b', 15, opts)).rejects.toMatchObject({ code: 'standalone' });
  });
});

describe('getNodeLogs', () => {
  it('reads the node\'s own logs with the token', async () => {
    const res = await getNodeLogs(target(), 'c', { limit: 50, level: 'warn', sinceMinutes: 30 }, opts);
    expect(res.logs).toEqual([{ timestamp: '2026-11-09T18:00:00Z', level: 'WARN', component: 'cluster', message: 'from c', caller: null }]);
    const req = nodes.c.requests.find((r) => r.path.startsWith('/api/v1/logs'));
    expect(req?.auth).toBe(`Bearer ${TOKEN}`);
    expect(req?.path).toBe('/api/v1/logs?limit=50&since_minutes=30&level=warn');
  });

  it('says a read-only token cannot read logs, rather than calling it rejected', async () => {
    logsStatus = 403;
    await expect(getNodeLogs(target(), 'c', { limit: 50, level: null, sinceMinutes: 30 }, opts)).rejects.toMatchObject({ code: 'token_not_admin' });
  });
});
