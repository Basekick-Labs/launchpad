import { describe, expect, it } from 'vitest';
import {
  clusterSummary,
  heartbeatAge,
  heartbeatStale,
  nodeApiHostPort,
  parseCheckIntervalMs,
  parseClusterStatus,
  pickLogs,
  pickSeries,
  pickSnapshot,
  rateSeries,
  gaugeSeries,
  seriesSpanMinutes,
  splitHostPort,
  walDiskFree,
  windowLatencyMs,
  type ClusterStatus,
} from './cluster';

/** Trimmed from a live 3-node cluster (arc main): 2 writers + 1 reader. */
const live = {
  enabled: true,
  mode: 'cluster',
  cluster_name: 'arc-dev',
  local_node_id: 'arc-writer1',
  primary_writer_id: 'arc-writer1',
  active_compactor: { assigned: false },
  raft: {
    enabled: true, is_leader: true, leader_addr: '127.0.0.1:9201', leader_id: 'arc-writer1', state: 'Leader',
    membership: {
      servers: [
        { id: 'arc-writer1', suffrage: 'voter' },
        { id: 'arc-writer2', suffrage: 'voter' },
        { id: 'arc-reader1', suffrage: 'nonvoter' },
      ],
    },
  },
  nodes: [
    { id: 'arc-writer1', name: 'arc-writer1', role: 'writer', state: 'healthy', address: '127.0.0.1:9101', api_address: '127.0.0.1:8101', version: '27.01.1-dev', last_heartbeat: '0001-01-01T00:00:00Z', writer_state: 'primary', is_active_compactor: false, stats: { cpu_usage: 0 } },
    { id: 'arc-writer2', name: 'arc-writer2', role: 'writer', state: 'healthy', address: '127.0.0.1:9102', api_address: '127.0.0.1:8102', version: '27.01.1-dev', last_heartbeat: '2026-11-09T12:13:55-06:00', writer_state: 'standby', is_active_compactor: false },
    { id: 'arc-reader1', name: 'arc-reader1', role: 'reader', state: 'healthy', address: '127.0.0.1:9103', api_address: '127.0.0.1:8103', version: '27.01.1-dev', last_heartbeat: '2026-11-09T12:13:57-06:00', writer_state: '', is_active_compactor: false },
  ],
};

const parsed = () => parseClusterStatus(live) as ClusterStatus;

describe('parseClusterStatus', () => {
  it('reads topology, leader, primary writer and raft suffrage', () => {
    const s = parsed();
    expect(s).toMatchObject({ enabled: true, clusterName: 'arc-dev', localNodeId: 'arc-writer1', leaderId: 'arc-writer1', primaryWriterId: 'arc-writer1', activeCompactorId: null, raftEnabled: true });
    expect(s.nodes.map((n) => [n.id, n.role, n.state, n.writerState, n.raftSuffrage])).toEqual([
      ['arc-reader1', 'reader', 'healthy', null, 'nonvoter'],
      ['arc-writer1', 'writer', 'healthy', 'primary', 'voter'],
      ['arc-writer2', 'writer', 'healthy', 'standby', 'voter'],
    ]);
  });

  it('treats the answering node\'s zero-time heartbeat as none', () => {
    expect(parsed().nodes.find((n) => n.id === 'arc-writer1')?.lastHeartbeat).toBeNull();
  });

  it('accepts v26.09.3 shapes (no writer_state, no primary_writer_id) and raft disabled', () => {
    const v26 = {
      ...live,
      primary_writer_id: undefined,
      raft: { enabled: false },
      active_compactor: { assigned: true, node_id: 'arc-writer2', present: true },
      nodes: live.nodes.map(({ writer_state: _w, ...n }) => n),
    };
    const s = parseClusterStatus(v26) as ClusterStatus;
    expect(s.primaryWriterId).toBeNull();
    expect(s.leaderId).toBeNull();
    expect(s.raftEnabled).toBe(false);
    expect(s.activeCompactorId).toBe('arc-writer2');
    expect(s.nodes.every((n) => n.writerState === null && n.raftSuffrage === null)).toBe(true);
  });

  it('reports standalone with Arc\'s reason', () => {
    expect(parseClusterStatus({ success: false, enabled: false, mode: 'standalone', reason: 'Clustering not enabled in configuration (cluster.enabled=false)' }))
      .toEqual({ enabled: false, reason: 'Clustering not enabled in configuration (cluster.enabled=false)' });
  });

  it('drops malformed nodes and unknown enums instead of trusting them', () => {
    const s = parseClusterStatus({
      enabled: true,
      nodes: [{ id: '../etc', role: 'writer' }, { id: 'ok', role: 'overlord', state: 'zombie', version: 'dev' }, 'nope'],
    }) as ClusterStatus;
    expect(s.nodes).toEqual([expect.objectContaining({ id: 'ok', role: 'unknown', state: 'unknown', version: null })]);
    expect(parseClusterStatus('garbage')).toBeNull();
  });
});

describe('nodeApiHostPort', () => {
  it('uses an explicit API host', () => {
    expect(nodeApiHostPort({ apiAddress: '10.0.0.5:8000', address: '10.0.0.5:9100' })).toEqual({ host: '10.0.0.5', port: 8000 });
  });

  it('fills a host-less or wildcard API address from the coordinator address, like Arc', () => {
    // Arc's default (server.host unset) advertises ":8000".
    expect(nodeApiHostPort({ apiAddress: ':8000', address: 'arc-writer1:9100' })).toEqual({ host: 'arc-writer1', port: 8000 });
    expect(nodeApiHostPort({ apiAddress: '0.0.0.0:8000', address: '10.1.2.3:9100' })).toEqual({ host: '10.1.2.3', port: 8000 });
    expect(nodeApiHostPort({ apiAddress: '[::]:8000', address: '[fd00::7]:9100' })).toEqual({ host: 'fd00::7', port: 8000 });
  });

  it('gives up when neither address has a usable host', () => {
    expect(nodeApiHostPort({ apiAddress: ':8000', address: ':9100' })).toBeNull();
    expect(nodeApiHostPort({ apiAddress: null, address: '10.0.0.1:9100' })).toBeNull();
  });
});

describe('splitHostPort', () => {
  it('accepts the forms Arc emits', () => {
    expect(splitHostPort('host:80')).toEqual({ host: 'host', port: 80 });
    expect(splitHostPort('[::1]:8000')).toEqual({ host: '::1', port: 8000 });
    expect(splitHostPort(':8101')).toEqual({ host: '', port: 8101 });
  });

  it('rejects anything URL-shaped or out of range', () => {
    for (const bad of ['http://x:80', 'a/b:80', 'user@h:80', 'h:0', 'h:65536', 'h:', '::1:80', 'h:80?x', 'h :80', 'h\\x:80']) {
      expect(splitHostPort(bad)).toBeNull();
    }
  });
});

describe('heartbeat staleness', () => {
  const server = Date.parse('2026-11-09T12:14:00-06:00');

  it('measures against Arc\'s clock and uses Arc\'s 3-interval window', () => {
    const [reader, self, writer2] = parsed().nodes;
    expect(heartbeatAge(self, server)).toBeNull();
    expect(heartbeatAge(reader, server)).toBe(3000);
    expect(heartbeatAge(writer2, server)).toBe(5000);
    expect(heartbeatStale(16_000, 5000)).toBe(true);
    expect(heartbeatStale(15_000, 5000)).toBe(false);
    expect(heartbeatStale(16_000, null)).toBe(true); // Arc's default interval
    expect(heartbeatStale(null, 5000)).toBe(false);
  });

  it('reads the checker interval from /api/v1/cluster/health', () => {
    expect(parseCheckIntervalMs({ health_checker: { check_interval_ms: 5000 } })).toBe(5000);
    expect(parseCheckIntervalMs({ health_checker: { check_interval_ms: -1 } })).toBeNull();
  });
});

describe('clusterSummary', () => {
  it('counts healthy nodes and flags mixed versions', () => {
    expect(clusterSummary(parsed())).toEqual({ total: 3, healthy: 3, versions: ['27.01.1-dev'], mixedVersions: false });
    const mixed = parsed();
    mixed.nodes[0] = { ...mixed.nodes[0], version: '26.09.3', state: 'dead' };
    expect(clusterSummary(mixed)).toMatchObject({ healthy: 2, mixedVersions: true, versions: ['26.09.3', '27.01.1-dev'] });
  });
});

describe('node metrics', () => {
  it('keeps only known finite metrics', () => {
    expect(pickSnapshot({ goroutines: 50, num_cpu: 14, secret_field: 'x', http_requests_total: NaN, memory_sys_bytes: -1 }))
      .toEqual({ goroutines: 50, num_cpu: 14 });
  });

  it('treats an unsampled WAL disk (0) as not reported', () => {
    expect(walDiskFree({ wal_disk_free_bytes: 0 })).toBeNull();
    expect(walDiskFree({ wal_disk_free_bytes: 1024 })).toBe(1024);
  });

  it('computes latency over the window, not Arc\'s lifetime average', () => {
    const prev = { http_latency_sum_us: 1_000_000, http_latency_count: 100 };
    const curr = { http_latency_sum_us: 1_300_000, http_latency_count: 110 };
    expect(windowLatencyMs(prev, curr, 'http_latency_sum_us', 'http_latency_count')).toBe(30);
    expect(windowLatencyMs(null, curr, 'http_latency_sum_us', 'http_latency_count')).toBeNull();
    expect(windowLatencyMs(curr, curr, 'http_latency_sum_us', 'http_latency_count')).toBeNull(); // no requests
    expect(windowLatencyMs(curr, prev, 'http_latency_sum_us', 'http_latency_count')).toBeNull(); // restart
  });

  const series = {
    type: 'api',
    data: [
      { timestamp: '2026-11-09T18:00:00Z', values: { http_requests_total: 100, http_requests_error: 1, auth_requests_total: 9 } },
      { timestamp: '2026-11-09T18:00:05Z', values: { http_requests_total: 150, http_requests_error: 1 } },
      { timestamp: '2026-11-09T18:00:10Z', values: { http_requests_total: 10, http_requests_error: 0 } }, // restart
      { timestamp: '2026-11-09T18:00:15Z', values: { http_requests_total: 30, http_requests_error: 0 } },
      { timestamp: 'bad', values: {} },
    ],
  };

  it('down-selects series keys and drops bad points', () => {
    const pts = pickSeries(series, 'api');
    expect(pts).toHaveLength(4);
    expect(pts[0].values).toEqual({ http_requests_total: 100, http_requests_error: 1 });
    expect(seriesSpanMinutes(pts)).toBe(0);
  });

  it('turns counters into rates and skips counter resets', () => {
    const [xs, ys] = rateSeries(pickSeries(series, 'api'), 'http_requests_total');
    expect(ys).toEqual([10, 4]);
    expect(xs).toHaveLength(2);
    expect(gaugeSeries(pickSeries(series, 'api'), 'http_requests_error')[1]).toEqual([1, 1, 0, 0]);
  });
});

describe('pickLogs', () => {
  it('keeps the documented fields, bounded', () => {
    const logs = pickLogs({
      logs: [
        { timestamp: '2026-11-09T18:13:33Z', level: 'warn', component: 'cluster', message: 'fewer than three writers', caller: 'health.go:416', extra: 'x' },
        { level: 'INFO' },
        { timestamp: 't', message: 'm'.repeat(10_000) },
      ],
    });
    expect(logs[0]).toEqual({ timestamp: '2026-11-09T18:13:33Z', level: 'WARN', component: 'cluster', message: 'fewer than three writers', caller: 'health.go:416' });
    expect(logs).toHaveLength(2);
    expect(logs[1].message).toHaveLength(8192);
  });
});
