import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, getAuditPage, getAuditStats, parseAuditQuery, parseStatsQuery, resetAuditCachesForTests, type AuditQuery } from './auditLog';
import { resetClusterCachesForTests } from './clusterNodes';
import type { AuditFilter } from '../auditLog';

/**
 * Fake Arc nodes serving /api/v1/audit/* the way internal/api/audit_routes.go
 * does: exact-match filters, inclusive since/until, newest first, LIMIT and
 * OFFSET. Node "a" is the endpoint; `clustered` decides whether it reports a
 * cluster of a, b (and c, whose API address has nothing listening).
 */
interface Row { id: number; timestamp: string; event_type: string; actor: string; method: string; path: string; database?: string; status_code: number }
interface Fake {
  id: string;
  port: number;
  server: http.Server;
  audit: 'on' | 'off' | 'unlicensed';
  rows: Row[];
  /** Query strings of the /api/v1/audit/logs requests received. */
  seen: URLSearchParams[];
}
const nodes: Record<string, Fake> = {};
let clustered = false;
let withC = false;
const TOKEN = 'admin-token';
const opts = { allowPrivate: true, nodeCidrs: [] };

const at = (minute: number) => `2026-11-13T10:${String(minute).padStart(2, '0')}:00Z`;
const row = (id: number, minute: number, o: Partial<Row> = {}): Row => ({
  id, timestamp: at(minute), event_type: 'token.created', actor: 'admin', method: 'POST', path: '/api/v1/auth/tokens', status_code: 201, ...o,
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
    const q = url.searchParams;
    if (p === '/api/v1/cluster') {
      if (!clustered) return send(200, { success: false, enabled: false, mode: 'standalone', reason: 'off' });
      const ids = withC ? ['a', 'b', 'c'] : ['a', 'b'];
      return send(200, {
        enabled: true, cluster_name: 'aud', local_node_id: 'a',
        nodes: ids.map((x) => ({ id: x, name: x, role: 'writer', state: 'healthy', address: `127.0.0.1:${9000 + x.charCodeAt(0)}`, api_address: x === 'c' ? '127.0.0.1:1' : `127.0.0.1:${nodes[x].port}` })),
      });
    }
    if (p === '/api/v1/cluster/health') return send(200, { health_checker: { check_interval_ms: 5000 } });
    if (p === '/api/v1/cluster/local') return send(200, { id, cluster_name: 'aud' });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'Unauthorized' });
    if (p.startsWith('/api/v1/audit') && n.audit === 'off') return send(404, { success: false, error: `Cannot GET ${p}` });
    if (p.startsWith('/api/v1/audit') && n.audit === 'unlicensed') {
      return send(403, { success: false, error: "Audit logging requires an enterprise license with the 'audit_logging' feature enabled" });
    }
    if (p === '/api/v1/audit/logs') {
      n.seen.push(q);
      const since = q.get('since') ? Date.parse(q.get('since') as string) : -Infinity;
      const until = q.get('until') ? Date.parse(q.get('until') as string) : Infinity;
      const match = n.rows
        .filter((r) => (!q.get('event_type') || r.event_type === q.get('event_type')) && (!q.get('actor') || r.actor === q.get('actor')))
        .filter((r) => !q.get('database') || r.database === q.get('database'))
        .filter((r) => Date.parse(r.timestamp) >= since && Date.parse(r.timestamp) <= until)
        .sort((x, y) => Date.parse(y.timestamp) - Date.parse(x.timestamp));
      const offset = Number(q.get('offset') ?? 0);
      const data = match.slice(offset, offset + Number(q.get('limit') ?? 100));
      // A nil Go slice marshals as null.
      return send(200, { success: true, data: data.length ? data : null, count: data.length });
    }
    if (p === '/api/v1/audit/stats') {
      const since = Date.parse(q.get('since') as string);
      const counts: Record<string, number> = {};
      for (const r of n.rows) if (Date.parse(r.timestamp) >= since) counts[r.event_type] = (counts[r.event_type] ?? 0) + 1;
      return send(200, { success: true, data: counts, since: q.get('since') });
    }
    return send(404, { error: `Cannot GET ${p}` });
  };
}

beforeAll(async () => {
  for (const id of ['a', 'b']) {
    const server = http.createServer(handler(id));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    nodes[id] = { id, server, port: (server.address() as AddressInfo).port, audit: 'on', rows: [], seen: [] };
  }
});
afterAll(() => Promise.all(Object.values(nodes).map((n) => new Promise<void>((r) => n.server.close(() => r())))));

let seq = 0;
const target = () => ({ id: `inst-${++seq}`, endpoint_url: `http://127.0.0.1:${nodes.a.port}`, admin_token: TOKEN, node_scheme: null });
const NO_FILTER: AuditFilter = { eventType: null, actor: null, database: null, since: null, until: null, node: null };
const query = (o: Omit<Partial<AuditQuery>, 'filter'> & { filter?: Partial<AuditFilter> } = {}): AuditQuery => ({
  limit: o.limit ?? 100,
  cursor: o.cursor ?? null,
  filter: { ...NO_FILTER, ...o.filter },
});

beforeEach(() => {
  resetAuditCachesForTests();
  resetClusterCachesForTests();
  clustered = false;
  withC = false;
  for (const n of Object.values(nodes)) {
    n.audit = 'on';
    n.rows = [];
    n.seen = [];
  }
});

describe('getAuditPage', () => {
  it('reads a standalone instance as one node', async () => {
    nodes.a.rows = [row(1, 1), row(2, 2, { event_type: 'auth.failed', status_code: 401, actor: 'anonymous' })];
    const p = await getAuditPage(target(), query(), opts);
    expect(p.allNodes).toEqual(['standalone']);
    expect(p.nodes).toEqual([expect.objectContaining({ nodeId: 'standalone', state: 'on', issue: null })]);
    expect(p.events.map((e) => [e.nodeId, e.id, e.eventType])).toEqual([['standalone', 2, 'auth.failed'], ['standalone', 1, 'token.created']]);
    expect(p.next).toBeNull();
  });

  it('passes the filters to Arc', async () => {
    nodes.a.rows = [row(1, 1, { actor: 'ci', database: 'prod' }), row(2, 2, { actor: 'other', database: 'prod' })];
    const p = await getAuditPage(target(), query({ filter: { actor: 'ci', database: 'prod', eventType: 'token.created', since: '2026-11-13T09:00:00.000Z' } }), opts);
    expect(p.events.map((e) => e.id)).toEqual([1]);
    const seen = nodes.a.seen[0];
    expect(Object.fromEntries(seen)).toEqual({ limit: '100', event_type: 'token.created', actor: 'ci', database: 'prod', since: '2026-11-13T09:00:00.000Z' });
  });

  it('merges every node of a cluster by time and pages through them without gaps or repeats', async () => {
    clustered = true;
    nodes.a.rows = [row(1, 10), row(2, 30), row(3, 50)];
    nodes.b.rows = [row(1, 20), row(2, 40)];
    const tgt = target();
    const first = await getAuditPage(tgt, query({ limit: 2 }), opts);
    expect(first.allNodes).toEqual(['a', 'b']);
    expect(first.events.map((e) => `${e.nodeId}${e.id}`)).toEqual(['a3', 'b2']);
    expect(first.next).not.toBeNull();

    // Written after the first page: must not shift what the next pages return.
    nodes.a.rows.push(row(4, 59));

    const shown = [...first.events];
    let next = first.next;
    while (next) {
      const p = await getAuditPage(tgt, query({ limit: 2, cursor: decodeCursor(next) }), opts);
      shown.push(...p.events);
      next = p.next;
    }
    expect(shown.map((e) => `${e.nodeId}${e.id}`)).toEqual(['a3', 'b2', 'a2', 'b1', 'a1']);
    // Later pages ask each node for events up to its first-page newest.
    expect(nodes.a.seen[1].get('until')).toBe(at(50));
    expect(nodes.a.seen[1].get('offset')).toBe('1');
  });

  it('stops reading a node once it has no more', async () => {
    clustered = true;
    nodes.a.rows = [row(1, 10), row(2, 30), row(3, 50)];
    nodes.b.rows = [row(1, 59)]; // newest of all: used on the first page, and b has no more
    const tgt = target();
    const first = await getAuditPage(tgt, query({ limit: 2 }), opts);
    expect(Object.keys(decodeCursor(first.next as string) ?? {})).toEqual(['a']);
    await getAuditPage(tgt, query({ limit: 2, cursor: decodeCursor(first.next as string) }), opts);
    expect(nodes.b.seen).toHaveLength(1);
    expect(nodes.a.seen).toHaveLength(2);
  });

  it('reads only the node the filter names', async () => {
    clustered = true;
    nodes.a.rows = [row(1, 10)];
    nodes.b.rows = [row(1, 20)];
    const p = await getAuditPage(target(), query({ filter: { node: 'b' } }), opts);
    expect(p.events.map((e) => e.nodeId)).toEqual(['b']);
    expect(p.allNodes).toEqual(['a', 'b']);
    expect(nodes.a.seen).toHaveLength(0);
    await expect(getAuditPage(target(), query({ filter: { node: 'zz' } }), opts)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('says which nodes are missing and why, and shows the rest', async () => {
    clustered = true;
    withC = true; // c's API address has nothing listening
    nodes.a.rows = [row(1, 10)];
    nodes.b.audit = 'off';
    const p = await getAuditPage(target(), query(), opts);
    expect(p.events.map((e) => e.nodeId)).toEqual(['a']);
    const states = Object.fromEntries(p.nodes.map((n) => [n.nodeId, [n.state, n.issue?.code ?? null]]));
    expect(states).toEqual({ a: ['on', null], b: ['off', 'audit_off'], c: ['unreachable', expect.any(String)] });
  });

  it('tells a lapsed license from audit logging being off', async () => {
    nodes.a.audit = 'unlicensed';
    const p = await getAuditPage(target(), query(), opts);
    expect(p.nodes[0]).toMatchObject({ state: 'refused', issue: { code: 'not_licensed' } });
    expect(p.events).toEqual([]);
  });

  it('reports a rejected token per node', async () => {
    const p = await getAuditPage({ ...target(), admin_token: 'wrong' }, query(), opts);
    expect(p.nodes[0]).toMatchObject({ state: 'refused', issue: { code: 'token_rejected' } });
  });
});

describe('getAuditStats', () => {
  it('sums counts over nodes since the window start', async () => {
    clustered = true;
    nodes.a.rows = [row(1, 10, { event_type: 'auth.failed' }), row(2, 20), row(3, 1)];
    nodes.b.rows = [row(1, 30, { event_type: 'auth.failed' })];
    const s = await getAuditStats(target(), { since: at(5), node: null }, opts);
    expect(s.byType).toEqual([{ eventType: 'auth.failed', count: 2 }, { eventType: 'token.created', count: 1 }]);
    expect(s.total).toBe(3);
    expect(s.since).toBe(at(5));
  });

  it('defaults to the last 24 hours, as Arc does', async () => {
    const before = Date.now();
    const s = await getAuditStats(target(), { since: null, node: null }, opts);
    const since = Date.parse(s.since);
    expect(since).toBeGreaterThanOrEqual(before - 24 * 3600_000 - 1000);
    expect(since).toBeLessThanOrEqual(Date.now() - 24 * 3600_000 + 1000);
  });
});

describe('request parameters', () => {
  const url = (qs: string) => new URL(`http://lp/audit?${qs}`);

  it('reads a full query and normalises times to UTC', () => {
    expect(parseAuditQuery(url('event_type=auth.failed&actor=ci%20bot&database=prod&since=2026-11-13T11:00:00%2B01:00&node=w1&limit=50'))).toEqual({
      filter: { eventType: 'auth.failed', actor: 'ci bot', database: 'prod', since: '2026-11-13T10:00:00.000Z', until: null, node: 'w1' },
      limit: 50,
      cursor: null,
    });
    expect(parseAuditQuery(url(''))).toMatchObject({ limit: 100, cursor: null, filter: NO_FILTER });
  });

  it('refuses what Arc would reject or Launchpad would not bound', () => {
    for (const qs of [
      `event_type=${'x'.repeat(129)}`,
      'event_type=%20padded',
      'since=yesterday',
      'since=2026-11-13T12:00:00Z&until=2026-11-13T10:00:00Z',
      'limit=0',
      'limit=201',
      `actor=${'x'.repeat(129)}`,
      'actor=%20padded',
      'database=a%0Ab',
      'node=..%2Fetc',
      'cursor=!!',
    ]) {
      expect(typeof parseAuditQuery(url(qs)), qs).toBe('string');
    }
    expect(typeof parseStatsQuery(url('since=nope'))).toBe('string');
    expect(parseStatsQuery(url('since=2026-11-13T10:00:00Z&node=a'))).toEqual({ since: '2026-11-13T10:00:00.000Z', node: 'a' });
  });

  it('round-trips a cursor and refuses a tampered one', () => {
    const c = { a: { until: '2026-11-13T10:00:00.123456789Z', offset: 100 } };
    const encoded = encodeCursor(c) as string;
    expect(decodeCursor(encoded)).toEqual(c);
    expect(encodeCursor({})).toBeNull();
    const bad = (v: unknown) => decodeCursor(Buffer.from(JSON.stringify(v)).toString('base64url'));
    expect(bad({ a: { until: 'tomorrow', offset: 1 } })).toBeNull();
    expect(bad({ a: { until: '2026-11-13T10:00:00Z', offset: -1 } })).toBeNull();
    expect(bad({ a: { until: '2026-11-13T10:00:00Z', offset: 2_000_000 } })).toBeNull();
    expect(bad({ 'no/slash': { until: '2026-11-13T10:00:00Z', offset: 0 } })).toBeNull();
    expect(bad({})).toBeNull();
    expect(bad([])).toBeNull();
  });

  it('keeps node ids that spell Object.prototype keys as plain entries', () => {
    const c = JSON.parse('{"__proto__":{"until":"2026-11-13T10:00:00Z","offset":3},"constructor":{"until":"2026-11-13T10:00:00Z","offset":1}}');
    const decoded = decodeCursor(Buffer.from(JSON.stringify(c)).toString('base64url'));
    expect(Object.keys(decoded ?? {})).toEqual(['__proto__', 'constructor']);
    expect(decoded?.['__proto__']).toEqual({ until: '2026-11-13T10:00:00Z', offset: 3 });
  });
});
