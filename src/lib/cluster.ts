/**
 * Arc cluster model (#7): parsing what /api/v1/cluster and a node's metrics
 * routes return, plus the arithmetic the Cluster view needs. Pure and
 * isomorphic; the I/O lives in src/lib/server/clusterNodes.ts.
 *
 * Shapes are checked against Arc main (27.01) and v26.09.3. Fields that only
 * exist on main (writer_state, primary_writer_id) or only in some states
 * (active_compactor.*, raft.leader_id during an election) are optional here.
 */

import { normalizeVersion } from './capabilities';

export const NODE_ROLES = ['standalone', 'writer', 'reader', 'compactor'] as const;
export type NodeRole = (typeof NODE_ROLES)[number] | 'unknown';
export const NODE_STATES = ['healthy', 'unhealthy', 'dead', 'joining', 'leaving', 'unknown'] as const;
export type NodeState = (typeof NODE_STATES)[number];

/** Arc's node ids are free-form config; keep them to safe, bounded strings. */
export const NODE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** More nodes than this is not a cluster Launchpad renders. */
export const MAX_NODES = 256;

export interface ClusterNode {
  id: string;
  name: string;
  role: NodeRole;
  state: NodeState;
  /** primary | standby; null when not a writer or on v26.09.3. */
  writerState: string | null;
  version: string | null;
  /** Coordinator address (host:port), used to fill a host-less api_address. */
  address: string | null;
  apiAddress: string | null;
  /** ISO time of the last heartbeat the answering node received; null for itself. */
  lastHeartbeat: string | null;
  isActiveCompactor: boolean;
  /** Raft suffrage from raft.membership, when Arc reports it. */
  raftSuffrage: 'voter' | 'nonvoter' | null;
}

export interface ClusterStatus {
  enabled: true;
  clusterName: string | null;
  /** The node that answered: everything here is its view of the cluster. */
  localNodeId: string | null;
  leaderId: string | null;
  raftEnabled: boolean;
  raftState: string | null;
  primaryWriterId: string | null;
  activeCompactorId: string | null;
  nodes: ClusterNode[];
}

export interface Standalone {
  enabled: false;
  reason: string | null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function text(v: unknown, max = 256): string | null {
  return typeof v === 'string' && v !== '' && v.length <= max ? v : null;
}

function nodeId(v: unknown): string | null {
  return typeof v === 'string' && NODE_ID_RE.test(v) ? v : null;
}

const GO_ZERO_TIME = /^0001-01-01T/;

function parseNode(raw: unknown, suffrage: Map<string, 'voter' | 'nonvoter'>): ClusterNode | null {
  const n = obj(raw);
  const id = nodeId(n?.id);
  if (!n || !id) return null;
  const role = (NODE_ROLES as readonly string[]).includes(n.role as string) ? (n.role as NodeRole) : 'unknown';
  const state = (NODE_STATES as readonly string[]).includes(n.state as string) ? (n.state as NodeState) : 'unknown';
  const hb = text(n.last_heartbeat, 64);
  return {
    id,
    name: text(n.name, 128) ?? id,
    role,
    state,
    writerState: text(n.writer_state, 32),
    version: normalizeVersion(n.version),
    address: text(n.address),
    apiAddress: text(n.api_address),
    lastHeartbeat: hb && !GO_ZERO_TIME.test(hb) && !Number.isNaN(Date.parse(hb)) ? hb : null,
    isActiveCompactor: n.is_active_compactor === true,
    raftSuffrage: suffrage.get(id) ?? null,
  };
}

/** Parse a /api/v1/cluster body; null when it is not one. */
export function parseClusterStatus(raw: unknown): ClusterStatus | Standalone | null {
  const d = obj(raw);
  if (!d || typeof d.enabled !== 'boolean') return null;
  if (!d.enabled) return { enabled: false, reason: text(d.reason, 512) };

  const raft = obj(d.raft);
  const suffrage = new Map<string, 'voter' | 'nonvoter'>();
  const servers = obj(raft?.membership)?.servers;
  if (Array.isArray(servers)) {
    for (const s of servers.slice(0, MAX_NODES)) {
      const o = obj(s);
      const id = nodeId(o?.id);
      if (id && (o?.suffrage === 'voter' || o?.suffrage === 'nonvoter')) suffrage.set(id, o.suffrage);
    }
  }
  const nodes = Array.isArray(d.nodes)
    ? d.nodes.slice(0, MAX_NODES).map((n) => parseNode(n, suffrage)).filter((n): n is ClusterNode => n !== null)
    : [];
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  const compactor = obj(d.active_compactor);

  return {
    enabled: true,
    clusterName: text(d.cluster_name, 128),
    localNodeId: nodeId(d.local_node_id),
    leaderId: nodeId(raft?.leader_id),
    raftEnabled: raft?.enabled === true,
    raftState: text(raft?.state, 32),
    primaryWriterId: nodeId(d.primary_writer_id),
    activeCompactorId: compactor?.assigned === true ? nodeId(compactor.node_id) : null,
    nodes,
  };
}

/**
 * Where a node's HTTP API is, as Arc's own router computes it
 * (internal/cluster/router.go APIHostPort): a node bound to every interface
 * advertises ":<port>" (or a wildcard host), and the host then comes from its
 * coordinator address. Returns host and port, or null when unusable.
 */
export function nodeApiHostPort(node: Pick<ClusterNode, 'apiAddress' | 'address'>): { host: string; port: number } | null {
  const api = splitHostPort(node.apiAddress);
  if (!api) return null;
  let host = api.host;
  if (host === '' || host === '0.0.0.0' || host === '::') {
    const coord = splitHostPort(node.address);
    if (!coord || coord.host === '' || coord.host === '0.0.0.0' || coord.host === '::') return null;
    host = coord.host;
  }
  return { host, port: api.port };
}

/** Go's net.SplitHostPort, for the forms Arc emits: host:port, [v6]:port, :port. */
export function splitHostPort(value: string | null): { host: string; port: number } | null {
  if (!value || value.length > 300 || /[\s/@?#\\]/.test(value)) return null;
  let host: string;
  let portText: string;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0 || value[end + 1] !== ':') return null;
    host = value.slice(1, end);
    portText = value.slice(end + 2);
    if (!host.includes(':')) return null;
  } else {
    const i = value.lastIndexOf(':');
    if (i < 0) return null;
    host = value.slice(0, i);
    portText = value.slice(i + 1);
    if (host.includes(':')) return null; // unbracketed IPv6
  }
  if (!/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65535) return null;
  if (host !== '' && !/^[A-Za-z0-9.:_-]+$/.test(host)) return null;
  return { host, port };
}

/** Arc's default health-check interval (cluster.health_check_interval, 5 s). */
export const DEFAULT_CHECK_INTERVAL_MS = 5000;

/**
 * Milliseconds since the answering node last heard from `node`, measured
 * against the answering node's clock (`serverTime`, from the response Date
 * header) so clock skew between Arc and Launchpad cannot fake staleness.
 * Null for the answering node itself, which does not heartbeat to itself.
 */
export function heartbeatAge(node: ClusterNode, serverTimeMs: number | null): number | null {
  if (!node.lastHeartbeat || serverTimeMs === null) return null;
  return Math.max(0, serverTimeMs - Date.parse(node.lastHeartbeat));
}

/** Arc counts a peer healthy while its last heartbeat is within 3 intervals. */
export function heartbeatStale(ageMs: number | null, checkIntervalMs: number | null): boolean {
  if (ageMs === null) return false;
  return ageMs > 3 * (checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
}

export interface ClusterSummary {
  total: number;
  healthy: number;
  versions: string[];
  mixedVersions: boolean;
}

export function clusterSummary(status: ClusterStatus): ClusterSummary {
  const versions = [...new Set(status.nodes.map((n) => n.version).filter((v): v is string => v !== null))].sort();
  return {
    total: status.nodes.length,
    healthy: status.nodes.filter((n) => n.state === 'healthy').length,
    versions,
    mixedVersions: versions.length > 1,
  };
}

/** Parse /api/v1/cluster/health's checker block for the staleness interval. */
export function parseCheckIntervalMs(raw: unknown): number | null {
  const v = obj(obj(raw)?.health_checker)?.check_interval_ms;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 3_600_000 ? v : null;
}

// ---------------------------------------------------------------------------
// Node metrics

/** The /api/v1/metrics keys the node view reads; everything else is dropped. */
export const SNAPSHOT_KEYS = [
  'uptime_seconds', 'num_cpu', 'goroutines',
  'memory_heap_alloc_bytes', 'memory_sys_bytes',
  'http_requests_total', 'http_requests_error', 'http_latency_sum_us', 'http_latency_count',
  'query_requests_total', 'query_errors_total', 'query_latency_sum_us', 'query_latency_count',
  'query_mgmt_active_queries',
  'ingest_records_total', 'ingest_bytes_total', 'ingest_errors_total',
  'db_connections_open', 'db_connections_in_use', 'db_connections_max',
  'wal_disk_free_bytes', 'wal_directory_bytes',
  'compaction_jobs_total', 'compaction_jobs_failed',
] as const;
export type SnapshotKey = (typeof SNAPSHOT_KEYS)[number];
export type NodeSnapshot = Partial<Record<SnapshotKey, number>>;

/** Keep only known, finite, non-negative numbers from a metrics body. */
export function pickSnapshot(raw: unknown): NodeSnapshot {
  const d = obj(raw);
  const out: NodeSnapshot = {};
  if (!d) return out;
  for (const k of SNAPSHOT_KEYS) {
    const v = d[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

/** Time-series keys charted per Arc series type (others are dropped server-side). */
export const SERIES_KEYS = {
  system: ['memory_heap_mb', 'memory_sys_mb', 'goroutines'],
  api: ['http_requests_total', 'http_requests_error'],
  application: ['ingest_records_total', 'query_requests_total'],
} as const;
export type SeriesType = keyof typeof SERIES_KEYS;

export interface SeriesPoint {
  t: number; // unix seconds
  values: Record<string, number>;
}

/** Parse a /api/v1/metrics/timeseries/:type body down to the charted keys. */
export function pickSeries(raw: unknown, type: SeriesType, maxPoints = 2000): SeriesPoint[] {
  const data = obj(raw)?.data;
  if (!Array.isArray(data)) return [];
  const keys: readonly string[] = SERIES_KEYS[type];
  const out: SeriesPoint[] = [];
  for (const p of data.slice(-maxPoints)) {
    const o = obj(p);
    const t = typeof o?.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    const vals = obj(o?.values);
    if (Number.isNaN(t) || !vals) continue;
    const values: Record<string, number> = {};
    for (const k of keys) {
      const v = vals[k];
      if (typeof v === 'number' && Number.isFinite(v)) values[k] = v;
    }
    out.push({ t: Math.floor(t / 1000), values });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Per-second rate of a cumulative counter between consecutive points. A drop
 * (process restart resets counters) yields no point rather than a negative one.
 */
export function rateSeries(points: SeriesPoint[], key: string): [number[], number[]] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].values[key];
    const b = points[i].values[key];
    const dt = points[i].t - points[i - 1].t;
    if (a === undefined || b === undefined || dt <= 0 || b < a) continue;
    xs.push(points[i].t);
    ys.push((b - a) / dt);
  }
  return [xs, ys];
}

/** A gauge series as-is. */
export function gaugeSeries(points: SeriesPoint[], key: string): [number[], number[]] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of points) {
    const v = p.values[key];
    if (v === undefined) continue;
    xs.push(p.t);
    ys.push(v);
  }
  return [xs, ys];
}

/**
 * Average latency over the window between two snapshots, in ms. Arc's own
 * latency_avg values are lifetime averages, which flatline on a chart.
 */
export function windowLatencyMs(
  prev: NodeSnapshot | null,
  curr: NodeSnapshot,
  sumKey: 'http_latency_sum_us' | 'query_latency_sum_us',
  countKey: 'http_latency_count' | 'query_latency_count',
): number | null {
  if (!prev) return null;
  const ds = (curr[sumKey] ?? NaN) - (prev[sumKey] ?? NaN);
  const dc = (curr[countKey] ?? NaN) - (prev[countKey] ?? NaN);
  if (!Number.isFinite(ds) || !Number.isFinite(dc) || dc <= 0 || ds < 0) return null;
  return ds / dc / 1000;
}

/** Arc reports 0 when it has not sampled the WAL disk; that is not "0 B free". */
export function walDiskFree(s: NodeSnapshot): number | null {
  return s.wal_disk_free_bytes ? s.wal_disk_free_bytes : null;
}

/** Span the series actually covers, in minutes (retention is Arc config). */
export function seriesSpanMinutes(points: SeriesPoint[]): number {
  if (points.length < 2) return 0;
  return Math.round((points[points.length - 1].t - points[0].t) / 60);
}

// ---------------------------------------------------------------------------
// Logs

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface NodeLogEntry {
  timestamp: string;
  level: string;
  component: string | null;
  message: string;
  caller: string | null;
}

/** Keep the documented LogEntry fields, bounded. */
export function pickLogs(raw: unknown, max = 1000): NodeLogEntry[] {
  const logs = obj(raw)?.logs;
  if (!Array.isArray(logs)) return [];
  const out: NodeLogEntry[] = [];
  for (const l of logs.slice(0, max)) {
    const o = obj(l);
    const timestamp = text(o?.timestamp, 64);
    const message = typeof o?.message === 'string' ? o.message.slice(0, 8192) : null;
    if (!timestamp || message === null) continue;
    out.push({
      timestamp,
      level: (text(o?.level, 16) ?? 'INFO').toUpperCase(),
      component: text(o?.component, 128),
      message,
      caller: text(o?.caller, 512),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// UI text

/** What each server-side failure means for an admin looking at a node. */
export function describeClusterError(code: string | null | undefined): string {
  switch (code) {
    case 'unreachable': return 'Launchpad could not reach it';
    case 'address_blocked': return 'Its address is not allowed from Launchpad';
    case 'bad_address': return 'Arc reports no usable API address for it';
    case 'identity_mismatch': return 'Its address answered as a different node';
    case 'tls_error': return 'TLS failed: check "Cluster node scheme" in the connection settings';
    case 'token_rejected': return 'Arc rejected the stored token';
    case 'standalone': return 'Clustering is not enabled on this instance';
    case 'not_found': return 'This node is no longer in the cluster';
    case 'upstream_status': return 'Arc returned an unexpected response';
    default: return 'Something went wrong';
  }
}
