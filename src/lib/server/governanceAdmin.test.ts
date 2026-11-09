import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getGovernanceView, getTokenUsage, resetGovernanceCacheForTests } from './governanceAdmin';
import { resetClusterCachesForTests } from './clusterNodes';
import type { Limits } from '../governance';

/**
 * Fake Arc nodes. Node "a" is the endpoint; `clustered` decides whether it
 * reports a cluster of a, b (and c when `withC`).
 */
interface Fake {
  id: string;
  port: number;
  server: http.Server;
  governance: 'on' | 'off';
  policies: Array<{ id: number; token_id: number } & Partial<Limits>>;
  defaults: Partial<Limits> | null;
}
const nodes: Record<string, Fake> = {};
let clustered = false;
let withC = false;
let tokensStatus = 200;
let defaultsStatus = 200;
let usageBody: string | null = null;
const TOKEN = 'admin-token';
const opts = { allowPrivate: true, nodeCidrs: [] };

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
        enabled: true, cluster_name: 'gov', local_node_id: 'a',
        nodes: ids.map((x) => ({ id: x, name: x, role: 'writer', state: 'healthy', address: `127.0.0.1:${9000 + x.charCodeAt(0)}`, api_address: x === 'c' ? '127.0.0.1:1' : `127.0.0.1:${nodes[x].port}` })),
      });
    }
    if (p === '/api/v1/cluster/health') return send(200, { health_checker: { check_interval_ms: 5000 } });
    if (p === '/api/v1/cluster/local') return send(200, { id, cluster_name: 'gov' });
    if (p === '/health') return send(200, { status: 'ok' });
    if (p === '/api/v1/auth/tokens') return send(tokensStatus, { tokens: [{ id: 5, name: 'admin', permissions: ['admin'] }, { id: 7, name: 'dash', permissions: ['read'] }] });
    if (p === '/api/v1/auth/verify') return send(200, { valid: true, token_info: { id: 5 } });
    if (p.startsWith('/api/v1/governance') && n.governance === 'off') return send(404, { error: `Cannot GET ${p}` });
    if (p === '/api/v1/governance/policies') return send(200, { success: true, policies: n.policies, count: n.policies.length });
    const m = /^\/api\/v1\/governance\/usage\/(\d+)$/.exec(p);
    if (m) {
      if (m[1] === '0' && defaultsStatus !== 200) return send(defaultsStatus, { error: 'boom' });
      if (usageBody !== null) {
        res.writeHead(200);
        return res.end(usageBody);
      }
      const own = n.policies.find((x) => x.token_id === Number(m[1]));
      const policy = own ?? (n.defaults ? { id: 0, token_id: Number(m[1]), ...n.defaults } : null);
      return send(200, { success: true, usage: { token_id: Number(m[1]), queries_this_hour: 4, queries_this_day: 9, rate_limit_remaining_per_minute: 26, rate_limit_remaining_per_hour: 0 }, policy });
    }
    return send(404, { error: `Cannot GET ${p}` });
  };
}

beforeAll(async () => {
  for (const id of ['a', 'b']) {
    const server = http.createServer(handler(id));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    nodes[id] = { id, server, port: (server.address() as AddressInfo).port, governance: 'on', policies: [], defaults: null };
  }
});
afterAll(() => Promise.all(Object.values(nodes).map((n) => new Promise<void>((r) => n.server.close(() => r())))));

let seq = 0;
const target = () => ({ id: `inst-${++seq}`, endpoint_url: `http://127.0.0.1:${nodes.a.port}`, admin_token: TOKEN, node_scheme: null });

beforeEach(() => {
  resetGovernanceCacheForTests();
  resetClusterCachesForTests();
  clustered = false;
  withC = false;
  tokensStatus = 200;
  defaultsStatus = 200;
  usageBody = null;
  for (const n of Object.values(nodes)) {
    n.governance = 'on';
    n.policies = [];
    n.defaults = null;
  }
});

describe('getGovernanceView', () => {
  it('reads a standalone instance as one node, with defaults and Launchpad\'s own token', async () => {
    nodes.a.policies = [{ id: 1, token_id: 7, rate_limit_per_minute: 30 }];
    nodes.a.defaults = { max_queries_per_day: 1000 };
    const v = await getGovernanceView(target(), opts);
    expect(v.nodes.map((n) => [n.nodeId, n.state])).toEqual([['standalone', 'on']]);
    expect(v.nodes[0].defaults?.max_queries_per_day).toBe(1000);
    expect(v.launchpadTokenId).toBe(5);
    expect(v.policies).toEqual([expect.objectContaining({ tokenId: 7, inSync: true })]);
    expect(v.tokens.map((t) => t.name)).toEqual(['admin', 'dash']);
  });

  it('reads every node of a cluster and shows where they differ', async () => {
    clustered = true;
    nodes.a.policies = [{ id: 1, token_id: 7, rate_limit_per_minute: 30 }];
    nodes.b.policies = [{ id: 1, token_id: 7, rate_limit_per_minute: 60 }];
    const v = await getGovernanceView(target(), opts);
    expect(v.nodes.map((n) => [n.nodeId, n.state])).toEqual([['a', 'on'], ['b', 'on']]);
    expect(v.policies[0]).toMatchObject({ tokenId: 7, inSync: false });
    expect(v.policies[0].shared.rate_limit_per_minute).toBeNull();
    expect(v.nodes[0]).not.toHaveProperty('policies'); // the merge is what the client gets
  });

  it('tells a node with governance off from one that cannot be reached', async () => {
    clustered = true;
    withC = true; // c's API address has nothing listening
    nodes.b.governance = 'off';
    const v = await getGovernanceView(target(), opts);
    expect(v.nodes.map((n) => [n.nodeId, n.state, n.issue?.code ?? null])).toEqual([['a', 'on', null], ['b', 'off', 'governance_off'], ['c', 'unreachable', 'unreachable']]);
  });

  it('does not call policies deleted when the token list could not be read', async () => {
    tokensStatus = 500;
    nodes.a.policies = [{ id: 1, token_id: 7, rate_limit_per_minute: 30 }];
    const v = await getGovernanceView(target(), opts);
    expect(v.tokensLoaded).toBe(false);
    expect(v.tokens).toEqual([]);
  });

  it('tells defaults that could not be read from no defaults', async () => {
    defaultsStatus = 500;
    const v = await getGovernanceView(target(), opts);
    expect(v.nodes[0]).toMatchObject({ state: 'on', defaults: null, defaultsKnown: false });
    defaultsStatus = 200;
    resetGovernanceCacheForTests();
    expect((await getGovernanceView(target(), opts)).nodes[0]).toMatchObject({ defaults: null, defaultsKnown: true });
  });
});

describe('getTokenUsage', () => {
  it('reads each node\'s usage against that node\'s own limits', async () => {
    clustered = true;
    nodes.a.policies = [{ id: 1, token_id: 7, rate_limit_per_minute: 30 }];
    nodes.b.defaults = { max_queries_per_hour: 100 };
    const u = await getTokenUsage(target(), 7, opts);
    expect(u.map((n) => [n.nodeId, n.effective?.from, n.effective?.limits.rate_limit_per_minute, n.effective?.limits.max_queries_per_hour])).toEqual([
      ['a', 'policy', 30, 0],
      ['b', 'defaults', 0, 100],
    ]);
  });

  it('reports a body that is not usage as unavailable instead of failing', async () => {
    usageBody = 'not json';
    const [u] = await getTokenUsage(target(), 7, opts);
    expect(u).toMatchObject({ state: 'unavailable', issue: { code: 'upstream_status' } });
  });
});
