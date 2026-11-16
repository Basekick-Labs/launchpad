import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cancelQuery, getQueriesView, getQueryDetail, resetQueryManagementCacheForTests } from './queryManagement';
import { ClusterError, resetClusterCachesForTests } from './clusterNodes';
import { getDb } from './db';
import { listChanges } from './instanceChangeLog';

/**
 * Fake Arc nodes with a query registry each. Node "a" is the endpoint;
 * `clustered` decides whether it reports a cluster of a, b (and c, whose API
 * address has nothing listening, when `withC`).
 */
type Entry = Record<string, unknown> & { id: string; status: string };
interface Fake {
  id: string;
  port: number;
  server: http.Server;
  mode: 'on' | 'off' | 'unlicensed' | 'rejected';
  active: Entry[];
  history: Entry[];
  /** Status a DELETE answers with instead of cancelling; 0 = cancel normally. */
  cancelStatus: number;
  /** Move an active query to the history after the active list is read. */
  finishAfterActiveRead: string | null;
  requests: string[];
}
const nodes: Record<string, Fake> = {};
let clustered = false;
let withC = false;
const TOKEN = 'admin-token';
const opts = { allowPrivate: true, nodeCidrs: [] };

const running = (id: string, over: Record<string, unknown> = {}): Entry => ({
  id, sql: `SELECT ${id}`, token_id: 7, token_name: 'grafana', status: 'running', start_time: '2026-11-17T10:00:00Z', duration_ms: 1200, is_parallel: false, ...over,
});
const finished = (id: string, status: string, endTime: string, over: Record<string, unknown> = {}): Entry => ({
  ...running(id), status, end_time: endTime, duration_ms: 900, row_count: 3, ...over,
});

function handler(id: string) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const n = nodes[id];
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (p === '/api/v1/cluster') {
      if (!clustered) return send(200, { success: false, enabled: false, mode: 'standalone', reason: 'off' });
      const ids = withC ? ['a', 'b', 'c'] : ['a', 'b'];
      return send(200, {
        enabled: true, cluster_name: 'qm', local_node_id: 'a',
        nodes: ids.map((x) => ({ id: x, name: x, role: 'writer', state: 'healthy', address: `127.0.0.1:${9000 + x.charCodeAt(0)}`, api_address: x === 'c' ? '127.0.0.1:1' : `127.0.0.1:${nodes[x].port}` })),
      });
    }
    if (p === '/api/v1/cluster/health') return send(200, { health_checker: { check_interval_ms: 5000 } });
    if (p === '/api/v1/cluster/local') return send(200, { id, cluster_name: 'qm' });
    if (p === '/health') return send(200, { status: 'ok' });
    if (p === '/api/v1/auth/verify') return send(200, { valid: true, token_info: { id: 5 } });
    if (!p.startsWith('/api/v1/queries')) return send(404, { error: `Cannot ${req.method} ${p}` });

    n.requests.push(`${req.method} ${p}${url.search}`);
    if (n.mode === 'off') return send(404, { error: `Cannot ${req.method} ${p}` });
    if (n.mode === 'rejected') return send(401, { error: 'Invalid or expired token' });
    if (n.mode === 'unlicensed') return send(403, { success: false, error: "Query management requires an enterprise license with the 'query_management' feature enabled" });
    if (req.method === 'GET' && p === '/api/v1/queries/active') {
      const body = { success: true, queries: n.active, count: n.active.length };
      if (n.finishAfterActiveRead) {
        const q = n.active.find((x) => x.id === n.finishAfterActiveRead)!;
        n.active = n.active.filter((x) => x !== q);
        n.history.unshift({ ...q, status: 'completed', end_time: '2026-11-17T10:00:09Z' });
        n.finishAfterActiveRead = null;
      }
      return send(200, body);
    }
    if (req.method === 'GET' && p === '/api/v1/queries/history') {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return send(200, { success: true, queries: n.history.slice(0, limit), count: Math.min(limit, n.history.length) });
    }
    const m = /^\/api\/v1\/queries\/([^/]+)$/.exec(p);
    if (!m) return send(404, { error: `Cannot ${req.method} ${p}` });
    const qid = decodeURIComponent(m[1]);
    const inActive = n.active.find((x) => x.id === qid);
    const inHistory = n.history.find((x) => x.id === qid);
    if (req.method === 'GET') return inActive || inHistory ? send(200, { success: true, query: inActive ?? inHistory }) : send(404, { success: false, error: 'Query not found' });
    if (req.method === 'DELETE') {
      if (n.cancelStatus) return send(n.cancelStatus, { success: false, error: 'boom' });
      if (inActive) {
        n.active = n.active.filter((x) => x !== inActive);
        n.history.unshift({ ...inActive, status: 'cancelled', end_time: '2026-11-17T10:00:10Z' });
        return send(200, { success: true, message: 'Query cancelled' });
      }
      if (inHistory) return send(409, { success: false, error: `Query already ${inHistory.status}` });
      return send(404, { success: false, error: 'Query not found' });
    }
    return send(405, { error: 'Method Not Allowed' });
  };
}

beforeAll(async () => {
  for (const id of ['a', 'b']) {
    const server = http.createServer(handler(id));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    nodes[id] = { id, server, port: (server.address() as AddressInfo).port, mode: 'on', active: [], history: [], cancelStatus: 0, finishAfterActiveRead: null, requests: [] };
  }
  const db = getDb();
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'ada@example.test');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('o1', 'Org', 'u1');
});
afterAll(() => Promise.all(Object.values(nodes).map((n) => new Promise<void>((r) => n.server.close(() => r())))));

let seq = 0;
let target = () => ({ id: '', endpoint_url: '', admin_token: TOKEN, node_scheme: null });

beforeEach(() => {
  resetQueryManagementCacheForTests();
  resetClusterCachesForTests();
  clustered = false;
  withC = false;
  for (const n of Object.values(nodes)) {
    n.mode = 'on';
    n.active = [];
    n.history = [];
    n.cancelStatus = 0;
    n.finishAfterActiveRead = null;
    n.requests = [];
  }
  // A fresh instance per test, so no cache or change log carries over.
  const id = `inst-${++seq}`;
  getDb().prepare('INSERT INTO instances (id, org_id, resource_id, status) VALUES (?, ?, ?, ?)').run(id, 'o1', id, 'running');
  target = () => ({ id, endpoint_url: `http://127.0.0.1:${nodes.a.port}`, admin_token: TOKEN, node_scheme: null });
});

const changes = () => listChanges(target().id, null).changes.map((c) => [c.method, c.path, c.status, c.outcome]);

describe('getQueriesView', () => {
  it("reads a standalone instance as one node, with Launchpad's own token", async () => {
    nodes.a.active = [running('aaaa')];
    nodes.a.history = [finished('bbbb', 'completed', '2026-11-17T09:59:00Z')];
    const v = await getQueriesView(target(), opts);
    expect(v.nodes).toEqual([{ nodeId: 'standalone', source: expect.stringContaining('127.0.0.1'), state: 'on', issue: null, activeTruncated: false }]);
    expect(v.active.map((q) => [q.nodeId, q.id, q.status])).toEqual([['standalone', 'aaaa', 'running']]);
    expect(v.history.map((q) => [q.id, q.status, q.rowCount])).toEqual([['bbbb', 'completed', 3]]);
    expect(v.launchpadTokenId).toBe(5);
    expect(nodes.a.requests).toEqual(['GET /api/v1/queries/active', 'GET /api/v1/queries/history?limit=200']);
  });

  it('reads every node of a cluster and labels each query with its node', async () => {
    clustered = true;
    nodes.a.active = [running('aaaa', { start_time: '2026-11-17T10:00:05Z' })];
    nodes.b.active = [running('aaaa', { start_time: '2026-11-17T10:00:01Z' })]; // same id, other node
    nodes.b.history = [finished('cccc', 'failed', '2026-11-17T09:00:00Z', { error: 'Out of memory' })];
    const v = await getQueriesView(target(), opts);
    expect(v.nodes.map((n) => [n.nodeId, n.state])).toEqual([['a', 'on'], ['b', 'on']]);
    expect(v.active.map((q) => `${q.nodeId}/${q.id}`)).toEqual(['b/aaaa', 'a/aaaa']);
    expect(v.history).toEqual([expect.objectContaining({ nodeId: 'b', id: 'cccc', status: 'failed', error: 'Out of memory' })]);
  });

  it('shows a query that finished between the two reads once, as finished', async () => {
    nodes.a.active = [running('aaaa'), running('bbbb')];
    nodes.a.finishAfterActiveRead = 'aaaa';
    const v = await getQueriesView(target(), opts);
    expect(v.active.map((q) => q.id)).toEqual(['bbbb']);
    expect(v.history.map((q) => [q.id, q.status])).toEqual([['aaaa', 'completed']]);
  });

  it("tells each node's problem apart and keeps the others' queries", async () => {
    clustered = true;
    withC = true;
    nodes.a.active = [running('aaaa')];
    nodes.b.mode = 'off';
    let v = await getQueriesView(target(), opts);
    expect(v.nodes.map((n) => [n.nodeId, n.state, n.issue?.code ?? null])).toEqual([
      ['a', 'on', null],
      ['b', 'off', 'query_management_off'],
      ['c', 'unreachable', 'unreachable'],
    ]);
    expect(v.active.map((q) => q.nodeId)).toEqual(['a']);

    resetQueryManagementCacheForTests();
    nodes.b.mode = 'unlicensed';
    nodes.a.mode = 'rejected';
    v = await getQueriesView(target(), opts);
    expect(v.nodes.slice(0, 2).map((n) => [n.nodeId, n.state, n.issue?.code])).toEqual([['a', 'refused', 'token_rejected'], ['b', 'refused', 'not_licensed']]);
  });

  it('is shared for a moment between viewers', async () => {
    await getQueriesView(target(), opts);
    await getQueriesView(target(), opts);
    expect(nodes.a.requests.filter((r) => r.includes('/active'))).toHaveLength(1);
  });
});

describe('getQueryDetail', () => {
  it('reads the full query from its node', async () => {
    clustered = true;
    nodes.b.active = [running('aaaa', { sql: `SELECT ${'x'.repeat(5000)}` })];
    const d = await getQueryDetail(target(), 'b', 'aaaa', opts);
    expect(d.query).toMatchObject({ nodeId: 'b', id: 'aaaa', status: 'running', sqlTruncated: false });
    expect(d.query.sql).toHaveLength(5007);
    expect(d.source).toBe(`127.0.0.1:${nodes.b.port}`);
    expect(nodes.a.requests).toEqual([]);
  });

  it('says when the node no longer knows the query, or the node is not in the instance', async () => {
    await expect(getQueryDetail(target(), 'standalone', 'aaaa', opts)).rejects.toMatchObject({ code: 'not_found', message: expect.stringMatching(/no longer knows/) });
    await expect(getQueryDetail(target(), 'b', 'aaaa', opts)).rejects.toMatchObject({ code: 'not_found', message: 'No such node in this instance' });
  });

  it('does not read a turned-off node as a missing query', async () => {
    nodes.a.mode = 'off';
    await expect(getQueryDetail(target(), 'standalone', 'aaaa', opts)).rejects.toMatchObject({ code: 'upstream_status', message: 'Query management is not enabled on this node' });
  });
});

describe('cancelQuery', () => {
  it('cancels on the node that runs the query, and records who did it', async () => {
    clustered = true;
    nodes.a.active = [running('aaaa')];
    nodes.b.active = [running('aaaa')];
    const o = await cancelQuery(target(), 'b', 'aaaa', 'u1', opts);
    expect(o).toMatchObject({ result: 'cancelled', nodeId: 'b', queryId: 'aaaa', query: expect.objectContaining({ status: 'cancelled' }) });
    expect(nodes.b.requests).toContain('DELETE /api/v1/queries/aaaa');
    // The same id on the other node is another query: left alone.
    expect(nodes.a.requests).toEqual([]);
    expect(nodes.a.active.map((q) => q.id)).toEqual(['aaaa']);
    expect(changes()).toEqual([['DELETE', '/api/v1/queries/aaaa', 200, 'ok']]);
  });

  it('reports a query that had already finished, with how it ended', async () => {
    nodes.a.history = [finished('aaaa', 'completed', '2026-11-17T10:00:02Z')];
    const o = await cancelQuery(target(), 'standalone', 'aaaa', 'u1', opts);
    expect(o).toMatchObject({ result: 'already_finished', query: expect.objectContaining({ status: 'completed' }) });
    expect(changes()).toEqual([['DELETE', '/api/v1/queries/aaaa', 409, 'error']]);
  });

  it('reports a query the node no longer knows', async () => {
    const o = await cancelQuery(target(), 'standalone', 'aaaa', 'u1', opts);
    expect(o).toEqual({ result: 'not_found', nodeId: 'standalone', queryId: 'aaaa', query: null });
  });

  it('turns a refusal into an error, and still records the attempt', async () => {
    nodes.a.mode = 'unlicensed';
    await expect(cancelQuery(target(), 'standalone', 'aaaa', 'u1', opts)).rejects.toMatchObject({ code: 'upstream_status', message: 'The license no longer includes query management' });
    nodes.a.mode = 'off';
    await expect(cancelQuery(target(), 'standalone', 'aaaa', 'u1', opts)).rejects.toMatchObject({ message: 'Query management is not enabled on this node' });
    expect(changes()).toEqual([
      ['DELETE', '/api/v1/queries/aaaa', 404, 'error'],
      ['DELETE', '/api/v1/queries/aaaa', 403, 'error'],
    ]);
  });

  it("reads only Arc's own 404 as an unknown query", async () => {
    nodes.a.active = [running('aaaa')];
    nodes.a.cancelStatus = 404; // {"error": "boom"}: not what Arc's handler says
    await expect(cancelQuery(target(), 'standalone', 'aaaa', 'u1', opts)).rejects.toMatchObject({ code: 'upstream_status', message: 'Arc answered 404' });
    expect(changes()).toEqual([['DELETE', '/api/v1/queries/aaaa', 404, 'error']]);
  });

  it('looks before reporting a 5xx: still running is an error, of unknown outcome', async () => {
    nodes.a.active = [running('aaaa')];
    nodes.a.cancelStatus = 503;
    const err = await cancelQuery(target(), 'standalone', 'aaaa', 'u1', opts).catch((e) => e);
    expect(err).toBeInstanceOf(ClusterError);
    expect(err.message).toBe('Arc answered 503; the query is still running');
    expect(changes()).toEqual([['DELETE', '/api/v1/queries/aaaa', 503, 'unknown']]);
  });

  it('does not send a cancel to a node it cannot reach', async () => {
    clustered = true;
    withC = true;
    await expect(cancelQuery(target(), 'c', 'aaaa', 'u1', opts)).rejects.toMatchObject({ code: 'unreachable' });
    await expect(cancelQuery(target(), 'zzz', 'aaaa', 'u1', opts)).rejects.toMatchObject({ code: 'not_found' });
    expect(changes()).toEqual([]);
  });

  it('drops the shared view, so the next read shows the cancel', async () => {
    nodes.a.active = [running('aaaa')];
    expect((await getQueriesView(target(), opts)).active).toHaveLength(1);
    await cancelQuery(target(), 'standalone', 'aaaa', 'u1', opts);
    const v = await getQueriesView(target(), opts);
    expect(v.active).toEqual([]);
    expect(v.history.map((q) => [q.id, q.status])).toEqual([['aaaa', 'cancelled']]);
  });
});
