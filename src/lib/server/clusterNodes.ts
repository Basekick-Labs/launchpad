/**
 * Cluster topology and per-node data for an Arc instance (#7).
 *
 * Arc serves metrics and application logs only from the node that answers,
 * with no forwarding, so Launchpad calls each node directly at the API
 * address the cluster reports. That address comes from the Arc server, which
 * the org admin controls, so before any request reaches a node:
 *
 *  - the address is derived the way Arc's own router does (APIHostPort);
 *  - its host is resolved once (c-ares, bounded) and every request to that
 *    node, the identity check included, dials that exact IP (safeRequest
 *    pinTo) — no re-resolution, no fallback to another IP;
 *  - the IP must be inside LAUNCHPAD_CLUSTER_NODE_CIDRS, or else on the
 *    instance endpoint's own /24 (IPv4) or /64 (IPv6). That scope is set by
 *    the operator, not the tenant, and is what bounds where requests go;
 *    metadata/link-local/unspecified/multicast are refused regardless;
 *  - metrics, which Arc serves publicly, are fetched without the token; only
 *    the identity check and logs carry it;
 *  - nothing is shown until the node answers /api/v1/cluster/local as that
 *    node of that cluster, on that IP. That is for labelling data correctly
 *    (load balancers, reused addresses), not a security boundary.
 *
 * Free of $env imports (the caller passes options) so it runs under vitest
 * against real local HTTP servers.
 */

import net from 'node:net';
import { Resolver } from 'node:dns/promises';
import { assertSafeResolvedUrl, classifyIp, ipInCidr, parseCidr, safeRequest } from './ssrf.js';
import { SharedCache } from './sharedCache.js';
import { connectionFingerprint, parseJson } from './util.js';
import {
  nodeApiHostPort,
  parseCheckIntervalMs,
  parseClusterStatus,
  pickLogs,
  pickSeries,
  pickSnapshot,
  SERIES_KEYS,
  seriesSpanMinutes,
  type ClusterErrorCode,
  type ClusterNode,
  type ClusterStatus,
  type LogLevel,
  type NodeLogEntry,
  type NodeReachability,
  type NodeSnapshot,
  type SeriesPoint,
  type SeriesType,
  type Standalone,
} from '../cluster.js';

export interface ClusterTarget {
  id: string;
  endpoint_url: string | null;
  admin_token: string | null;
  /** Scheme for node API addresses; null = the endpoint's. */
  node_scheme: string | null;
}

export type Cidr = NonNullable<ReturnType<typeof parseCidr>>;

export interface ClusterOptions {
  allowPrivate: boolean;
  /** Operator-set node scope (LAUNCHPAD_CLUSTER_NODE_CIDRS). */
  nodeCidrs: readonly Cidr[];
}

export class ClusterError extends Error {
  constructor(public readonly code: ClusterErrorCode, message: string) {
    super(message);
    this.name = 'ClusterError';
  }
}

const IDLE_TIMEOUT_MS = 5000;
const TOPOLOGY_DEADLINE_MS = 8000;
const REACH_CHECK_MS = 2500;
const REACH_BUDGET_MS = 6000;
const NODE_DEADLINE_MS = 8000;
const DNS_TIMEOUT_MS = 2000;
const CLUSTER_MAX_BYTES = 1024 * 1024;
const SMALL_MAX_BYTES = 16 * 1024;
const METRICS_MAX_BYTES = 256 * 1024;
const SERIES_MAX_BYTES = 4 * 1024 * 1024;
const LOGS_MAX_BYTES = 2 * 1024 * 1024;
const REACHABILITY_CONCURRENCY = 4;

/** Just under the Cluster view's 15 s refresh, so concurrent viewers share a load. */
const TOPOLOGY_TTL_MS = 14_000;
/** A node lookup may use a topology this old rather than wait for a reload. */
const TOPOLOGY_STALE_OK_MS = 60_000;
const METRICS_TTL_MS = 12_000;
const SERIES_TTL_MS = 30_000;
const LOGS_TTL_MS = 10_000;
const IDENTITY_TTL_MS = 60_000;
/** A definite answer (wrong node, bad token) is cached longer than a transient one. */
function errorTtl(err: unknown): number {
  const code = err instanceof ClusterError ? err.code : 'internal';
  return code === 'identity_mismatch' || code === 'token_rejected' || code === 'address_blocked' ? 15_000 : 5000;
}

const cacheOpts = (ttlMs: number, maxEntries: number) => ({ ttlMs, errorTtlMs: errorTtl, maxEntries });

// Snapshot/series values are the large ones (tens to hundreds of KB).
const topologyCache = new SharedCache<Topology>(cacheOpts(TOPOLOGY_TTL_MS, 256));
const reachCache = new SharedCache<Record<string, NodeReachability>>(cacheOpts(TOPOLOGY_TTL_MS, 256));
const identityCache = new SharedCache<true>(cacheOpts(IDENTITY_TTL_MS, 1024));
const metricsCache = new SharedCache<{ snapshot: NodeSnapshot; fetchedAt: number }>(cacheOpts(METRICS_TTL_MS, 256));
const seriesCache = new SharedCache<Record<SeriesType, SeriesPoint[]>>(cacheOpts(SERIES_TTL_MS, 64));
const logsCache = new SharedCache<NodeLogsResult>(cacheOpts(LOGS_TTL_MS, 64));
const endpointIpCache = new SharedCache<string>(cacheOpts(30_000, 256));

const NETWORK_CODES = /^(ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|ENOTFOUND|EAI_|ESERVFAIL|ETIMEOUT|ENODATA|EREFUSED|ENOTIMP|ECANCELLED)/;
const TLS_CODES = /CERT|SSL|TLS|EPROTO|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/i;

/** Map a thrown error to a ClusterError; unknown errors are bugs, not "unreachable". */
function toClusterError(err: unknown): ClusterError {
  if (err instanceof ClusterError) return err;
  const e = err as { code?: string; name?: string; message?: string } | null;
  const code = e?.code ?? '';
  const message = e?.message ?? '';
  if (TLS_CODES.test(code)) return new ClusterError('tls_error', 'TLS handshake with the node failed');
  if (NETWORK_CODES.test(code) || e?.name === 'AbortError' || e?.name === 'TimeoutError' || /timed out/i.test(message)) {
    return new ClusterError('unreachable', 'The node did not respond in time');
  }
  if (/forbidden address|private address|not allowed/i.test(message)) {
    return new ClusterError('address_blocked', 'The node address is outside what Launchpad may contact');
  }
  if (/too large/i.test(message)) return new ClusterError('upstream_status', 'The node returned more data than allowed');
  console.error('[cluster] unexpected error', { error: message || String(err) });
  return new ClusterError('internal', 'Unexpected error');
}

async function wrap<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw toClusterError(err);
  }
}

/** Failures are logged when they change, and recoveries once — not every poll. */
const lastLogged = new Map<string, string>();
function logOutcome(key: string, outcome: 'ok' | ClusterErrorCode, fields: Record<string, unknown>): void {
  const prev = lastLogged.get(key);
  if (outcome === 'ok') {
    if (prev) console.info('[cluster] recovered', { ...fields, previous: prev });
    lastLogged.delete(key);
    return;
  }
  if (prev === outcome) return;
  lastLogged.delete(key);
  lastLogged.set(key, outcome);
  if (lastLogged.size > 512) lastLogged.delete(lastLogged.keys().next().value as string);
  console.warn('[cluster] request failed', { ...fields, outcome });
}

async function logged<T>(key: string, fields: Record<string, unknown>, p: Promise<T>): Promise<T> {
  try {
    const v = await p;
    logOutcome(key, 'ok', fields);
    return v;
  } catch (err) {
    const e = toClusterError(err);
    logOutcome(key, e.code, fields);
    throw e;
  }
}

interface Get {
  token?: string | null;
  signal: AbortSignal;
  maxBytes?: number;
  truncate?: number;
  pinTo?: string;
}

async function get(url: string, opts: ClusterOptions, g: Get): Promise<{ status: number; body: string; date: number | null }> {
  const res = await safeRequest(url, {
    allowHttp: true,
    allowPrivate: opts.allowPrivate,
    method: 'GET',
    headers: g.token ? { authorization: `Bearer ${g.token}` } : {},
    timeoutMs: IDLE_TIMEOUT_MS,
    signal: g.signal,
    maxResponseBytes: g.maxBytes,
    truncateResponseAt: g.truncate,
    pinTo: g.pinTo,
  });
  const dateHeader = res.headers.date;
  const date = typeof dateHeader === 'string' ? Date.parse(dateHeader) : NaN;
  return { status: res.status, body: res.body.toString('utf8'), date: Number.isNaN(date) ? null : date };
}

function endpointBase(t: ClusterTarget): string {
  const base = (t.endpoint_url ?? '').replace(/\/+$/, '');
  if (!base) throw new ClusterError('unreachable', 'This connection has no endpoint');
  return base;
}

function fingerprint(t: ClusterTarget, opts: ClusterOptions): string {
  return connectionFingerprint(t.id, t.endpoint_url, t.admin_token, t.node_scheme ?? '', String(opts.allowPrivate));
}

// ---------------------------------------------------------------------------
// Node address resolution and scope

/** c-ares, not dns.lookup: it does not occupy the libuv threadpool, and it times out. */
const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });

async function resolveHost(host: string, signal: AbortSignal): Promise<string[]> {
  if (net.isIP(host) !== 0) return [host];
  const settle = (p: Promise<string[]>) => p.catch(() => [] as string[]);
  const lookup = Promise.all([settle(resolver.resolve4(host)), settle(resolver.resolve6(host))]).then(([a, b]) => [...a, ...b]);
  const ips = await new Promise<string[]>((resolve, reject) => {
    const onAbort = () => reject(new ClusterError('unreachable', 'The node address did not resolve in time'));
    signal.addEventListener('abort', onAbort, { once: true });
    lookup.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
  if (ips.length === 0) throw new ClusterError('unreachable', 'The node address does not resolve from Launchpad');
  return ips;
}

/** The instance endpoint's IP, which anchors the default node scope. */
function endpointIp(t: ClusterTarget, opts: ClusterOptions): Promise<string> {
  const base = endpointBase(t);
  return endpointIpCache.get(`${base}|${opts.allowPrivate}`, async () => {
    try {
      return (await assertSafeResolvedUrl(base, { allowHttp: true, allowPrivate: opts.allowPrivate })).ip;
    } catch (err) {
      throw toClusterError(err);
    }
  });
}

function neighbourhood(ip: string): Cidr {
  return parseCidr(net.isIPv4(ip) ? `${ip}/24` : `${ip.replace(/%.*$/, '')}/64`) as Cidr;
}

function inScope(ip: string, anchor: string, opts: ClusterOptions): boolean {
  if (classifyIp(ip) === 'forbidden') return false;
  if (!opts.allowPrivate && classifyIp(ip) !== 'public') return false;
  if (opts.nodeCidrs.some((c) => ipInCidr(ip, c))) return true;
  return ipInCidr(ip, neighbourhood(anchor));
}

interface ResolvedNode {
  nodeId: string;
  /** Origin to request, e.g. http://arc-writer1:8000 (Host header and SNI). */
  origin: string;
  /** The vetted IP every request to this node dials. */
  ip: string;
  /** host:port shown to the admin as the data's source. */
  display: string;
}

async function resolveNode(t: ClusterTarget, node: ClusterNode, opts: ClusterOptions, signal: AbortSignal): Promise<ResolvedNode> {
  const hp = nodeApiHostPort(node);
  if (!hp) throw new ClusterError('bad_address', 'Arc reports no usable API address for this node');
  const base = endpointBase(t);
  const scheme = t.node_scheme === 'http' || t.node_scheme === 'https' ? t.node_scheme : new URL(base).protocol.replace(':', '');
  const host = hp.host.includes(':') ? `[${hp.host}]` : hp.host;

  const [anchor, ips] = await Promise.all([endpointIp(t, opts), resolveHost(hp.host, signal)]);
  const ip = ips.find((candidate) => inScope(candidate, anchor, opts));
  if (!ip) {
    throw new ClusterError(
      'address_blocked',
      'The node address is outside the endpoint\'s network; an operator can allow it with LAUNCHPAD_CLUSTER_NODE_CIDRS',
    );
  }
  return { nodeId: node.id, origin: `${scheme}://${host}:${hp.port}`, ip, display: `${host}:${hp.port}` };
}

// ---------------------------------------------------------------------------
// Topology and reachability

interface Topology {
  status: ClusterStatus | Standalone;
  checkIntervalMs: number | null;
  serverTime: number | null;
  fetchedAt: number;
}

async function loadTopology(t: ClusterTarget, opts: ClusterOptions): Promise<Topology> {
  const base = endpointBase(t);
  const signal = AbortSignal.timeout(TOPOLOGY_DEADLINE_MS);
  const g = { token: t.admin_token, signal };
  const [cluster, health] = await Promise.all([
    get(`${base}/api/v1/cluster`, opts, { ...g, maxBytes: CLUSTER_MAX_BYTES }),
    get(`${base}/api/v1/cluster/health`, opts, { ...g, maxBytes: SMALL_MAX_BYTES }).catch(() => null),
  ]);
  if (cluster.status === 401 || cluster.status === 403) throw new ClusterError('token_rejected', 'Arc rejected the stored token');
  if (cluster.status < 200 || cluster.status >= 300) throw new ClusterError('upstream_status', `Arc answered ${cluster.status}`);
  const status = parseClusterStatus(parseJson(cluster.body));
  if (!status) throw new ClusterError('upstream_status', 'Arc returned an unexpected cluster response');
  return {
    status,
    checkIntervalMs: health?.status === 200 ? parseCheckIntervalMs(parseJson(health.body)) : null,
    serverTime: cluster.date,
    fetchedAt: Date.now(),
  };
}

function getTopology(t: ClusterTarget, opts: ClusterOptions, maxAgeMs?: number): Promise<Topology> {
  const key = fingerprint(t, opts);
  return logged(`${t.id}|topology`, { instance_id: t.id, resource: 'topology' },
    topologyCache.get(key, () => wrap(loadTopology(t, opts)), maxAgeMs));
}

/**
 * Whether Launchpad can reach each node: tokenless /health (public in Arc).
 * Reported coarsely (reachable / blocked / unreachable) so it does not serve
 * as a port scanner; details go to the server log.
 */
async function loadReachability(t: ClusterTarget, status: ClusterStatus, opts: ClusterOptions): Promise<Record<string, NodeReachability>> {
  const budget = AbortSignal.timeout(REACH_BUDGET_MS);
  const out = new Map<string, NodeReachability>(status.nodes.map((n) => [n.id, { reachable: null, error: null }]));
  let next = 0;
  const worker = async () => {
    while (next < status.nodes.length && !budget.aborted) {
      const node = status.nodes[next++];
      const signal = AbortSignal.any([budget, AbortSignal.timeout(REACH_CHECK_MS)]);
      try {
        const r = await resolveNode(t, node, opts, signal);
        const res = await get(`${r.origin}/health`, opts, { signal, maxBytes: SMALL_MAX_BYTES, pinTo: r.ip });
        out.set(node.id, res.status >= 200 && res.status < 300 ? { reachable: true, error: null } : { reachable: false, error: 'unreachable' });
      } catch (err) {
        if (budget.aborted) break; // not checked in time: leave reachable null
        const code = toClusterError(err).code;
        out.set(node.id, { reachable: false, error: code === 'address_blocked' || code === 'bad_address' ? code : 'unreachable' });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REACHABILITY_CONCURRENCY, status.nodes.length) }, worker));
  return Object.fromEntries(out);
}

export interface ClusterView {
  status: ClusterStatus | Standalone;
  checkIntervalMs: number | null;
  serverTime: number | null;
  reachability: Record<string, NodeReachability>;
  fetchedAt: number;
}

/** Topology plus reachability; each cached ~14 s per connection and shared. */
export async function getClusterView(t: ClusterTarget, opts: ClusterOptions): Promise<ClusterView> {
  const topo = await getTopology(t, opts);
  let reachability: Record<string, NodeReachability> = {};
  if (topo.status.enabled) {
    const status = topo.status;
    reachability = await reachCache.get(`${fingerprint(t, opts)}|${topo.fetchedAt}`, () => loadReachability(t, status, opts));
  }
  return { ...topo, reachability };
}

// ---------------------------------------------------------------------------
// Identity

async function verifyIdentity(t: ClusterTarget, status: ClusterStatus, node: ResolvedNode, opts: ClusterOptions): Promise<void> {
  await identityCache.get(`${fingerprint(t, opts)}|${node.nodeId}|${node.origin}|${node.ip}`, () =>
    wrap((async () => {
      const res = await get(`${node.origin}/api/v1/cluster/local`, opts, {
        token: t.admin_token,
        signal: AbortSignal.timeout(NODE_DEADLINE_MS),
        maxBytes: SMALL_MAX_BYTES,
        pinTo: node.ip,
      });
      if (res.status === 401 || res.status === 403) throw new ClusterError('token_rejected', 'The node rejected the stored token');
      // Go answers plain HTTP sent to a TLS port with this 400.
      if (res.status === 400 && /HTTPS server/i.test(res.body)) throw new ClusterError('tls_error', 'The node serves HTTPS');
      if (res.status !== 200) throw new ClusterError('upstream_status', `The node answered ${res.status}`);
      const body = parseJson(res.body) as Record<string, unknown> | null;
      const sameNode = body?.id === node.nodeId;
      // Both must be present and equal: the topology response is the
      // tenant's, so an omitted cluster name must not skip the check.
      const sameCluster = !!status.clusterName && body?.cluster_name === status.clusterName;
      if (!sameNode || !sameCluster) {
        throw new ClusterError('identity_mismatch', 'The address Arc reports for this node answered as a different node');
      }
      return true as const;
    })()),
  );
}

async function reachNode(t: ClusterTarget, nodeId: string, opts: ClusterOptions, signal: AbortSignal): Promise<ResolvedNode> {
  const topo = await getTopology(t, opts, TOPOLOGY_STALE_OK_MS);
  if (!topo.status.enabled) throw new ClusterError('standalone', 'Clustering is not enabled on this instance');
  const node = topo.status.nodes.find((n) => n.id === nodeId);
  if (!node) throw new ClusterError('not_found', 'No such node in this cluster');
  const resolved = await resolveNode(t, node, opts, signal);
  await verifyIdentity(t, topo.status, resolved, opts);
  return resolved;
}

// ---------------------------------------------------------------------------
// Per-node data

export interface NodeSnapshotResult {
  nodeId: string;
  source: string;
  fetchedAt: number;
  snapshot: NodeSnapshot;
  series: Record<SeriesType, SeriesPoint[]>;
  spanMinutes: number;
}

/**
 * Metrics snapshot (cached ~12 s) and charted series (cached ~30 s) for one
 * node, shared across viewers. Arc serves /api/v1/metrics* publicly: no token.
 */
export function getNodeSnapshot(t: ClusterTarget, nodeId: string, durationMinutes: number, opts: ClusterOptions): Promise<NodeSnapshotResult> {
  const fp = fingerprint(t, opts);
  return logged(`${t.id}|${nodeId}|snapshot`, { instance_id: t.id, node_id: nodeId, resource: 'snapshot' }, (async () => {
    const signal = AbortSignal.timeout(NODE_DEADLINE_MS);
    const node = await reachNode(t, nodeId, opts, signal);
    const g = { signal, pinTo: node.ip };
    const [metrics, series] = await Promise.all([
      metricsCache.get(`${fp}|${nodeId}`, () => wrap((async () => {
        const res = await get(`${node.origin}/api/v1/metrics`, opts, { ...g, maxBytes: METRICS_MAX_BYTES });
        if (res.status !== 200) throw new ClusterError('upstream_status', `The node answered ${res.status}`);
        return { snapshot: pickSnapshot(parseJson(res.body)), fetchedAt: Date.now() };
      })())),
      seriesCache.get(`${fp}|${nodeId}|${durationMinutes}`, async () => {
        const types = Object.keys(SERIES_KEYS) as SeriesType[];
        // One series failing (or growing past the cap) leaves that chart
        // empty instead of failing the snapshot.
        const parsed = await Promise.all(types.map((type) =>
          get(`${node.origin}/api/v1/metrics/timeseries/${type}?duration_minutes=${durationMinutes}`, opts, { ...g, maxBytes: SERIES_MAX_BYTES })
            .then((res) => (res.status === 200 ? pickSeries(parseJson(res.body), type) : []))
            .catch(() => [] as SeriesPoint[]),
        ));
        return Object.fromEntries(types.map((type, i) => [type, parsed[i]])) as Record<SeriesType, SeriesPoint[]>;
      }),
    ]);
    return {
      nodeId,
      source: node.display,
      fetchedAt: metrics.fetchedAt,
      snapshot: metrics.snapshot,
      series,
      spanMinutes: Math.max(...Object.values(series).map(seriesSpanMinutes)),
    };
  })());
}

export interface NodeLogsQuery {
  limit: number;
  level: LogLevel | null;
  sinceMinutes: number;
}

export interface NodeLogsResult {
  nodeId: string;
  source: string;
  fetchedAt: number;
  logs: NodeLogEntry[];
}

/** Arc application logs from one node (admin-only in Arc, so the token goes). Cached ~10 s. */
export function getNodeLogs(t: ClusterTarget, nodeId: string, q: NodeLogsQuery, opts: ClusterOptions): Promise<NodeLogsResult> {
  const key = `${fingerprint(t, opts)}|${nodeId}|${q.limit}|${q.level ?? ''}|${q.sinceMinutes}`;
  return logged(`${t.id}|${nodeId}|logs`, { instance_id: t.id, node_id: nodeId, resource: 'logs' },
    logsCache.get(key, () => wrap((async () => {
      const signal = AbortSignal.timeout(NODE_DEADLINE_MS);
      const node = await reachNode(t, nodeId, opts, signal);
      const params = new URLSearchParams({ limit: String(q.limit), since_minutes: String(q.sinceMinutes) });
      if (q.level) params.set('level', q.level);
      const res = await get(`${node.origin}/api/v1/logs?${params}`, opts, {
        token: t.admin_token,
        signal,
        maxBytes: LOGS_MAX_BYTES,
        pinTo: node.ip,
      });
      if (res.status === 401) throw new ClusterError('token_rejected', 'The node rejected the stored token');
      if (res.status === 403) throw new ClusterError('token_not_admin', 'Arc application logs need an admin token');
      if (res.status !== 200) throw new ClusterError('upstream_status', `The node answered ${res.status}`);
      return { nodeId, source: node.display, fetchedAt: Date.now(), logs: pickLogs(parseJson(res.body), q.limit) };
    })())));
}

/** Test hook: module caches are per process. */
export function resetClusterCachesForTests(): void {
  for (const c of [topologyCache, reachCache, identityCache, metricsCache, seriesCache, logsCache, endpointIpCache]) c.clear();
  lastLogged.clear();
}
