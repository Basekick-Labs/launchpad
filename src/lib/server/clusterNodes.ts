/**
 * Cluster topology and per-node data for an Arc instance (#7).
 *
 * Arc serves metrics and application logs only from the node that answers,
 * with no forwarding, so Launchpad calls each node directly at the API
 * address the cluster reports. That address comes from the Arc server, which
 * the org admin controls, so before any request reaches a node:
 *
 *  - the address is derived the way Arc's own router does (APIHostPort) and
 *    must be a plain host:port;
 *  - every IP it resolves to must be in the same class (loopback / private /
 *    public) as the instance endpoint, and never link-local, metadata,
 *    unspecified or multicast, whatever LAUNCHPAD_ALLOW_PRIVATE_ENDPOINTS says;
 *  - metrics, which Arc serves publicly, are fetched without the token; only
 *    the identity check and logs carry it;
 *  - nothing is shown until the node answers /api/v1/cluster/local as that
 *    node of that cluster. This is about labelling data correctly (behind a
 *    load balancer or after an address is reused); the address policy above
 *    is what bounds where the token can go.
 *
 * Free of $env imports (the caller passes allowPrivate) so it runs under
 * vitest against real local HTTP servers.
 */

import { createHash } from 'node:crypto';
import { assertSafeResolvedUrl, classifyIp, safeRequest, type IpClass } from './ssrf.js';
import {
  nodeApiHostPort,
  parseCheckIntervalMs,
  parseClusterStatus,
  pickLogs,
  pickSeries,
  pickSnapshot,
  SERIES_KEYS,
  seriesSpanMinutes,
  type ClusterStatus,
  type LogLevel,
  type NodeLogEntry,
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

export interface ClusterOptions {
  allowPrivate: boolean;
}

export type ClusterErrorCode =
  | 'unreachable'
  | 'standalone'
  | 'not_found'
  | 'bad_address'
  | 'address_blocked'
  | 'identity_mismatch'
  | 'tls_error'
  | 'token_rejected'
  | 'upstream_status';

export class ClusterError extends Error {
  constructor(public readonly code: ClusterErrorCode, message: string) {
    super(message);
    this.name = 'ClusterError';
  }
}

const IDLE_TIMEOUT_MS = 5000;
const VIEW_DEADLINE_MS = 10_000;
const NODE_DEADLINE_MS = 8000;
const CLUSTER_MAX_BYTES = 1024 * 1024;
const SMALL_MAX_BYTES = 16 * 1024;
const METRICS_MAX_BYTES = 256 * 1024;
const SERIES_MAX_BYTES = 2 * 1024 * 1024;
const LOGS_MAX_BYTES = 2 * 1024 * 1024;
/** Tokenless /health checks fanned out to nodes at once. */
const REACHABILITY_CONCURRENCY = 8;

/** Arc samples its in-memory metrics every 5 s; refetching sooner adds nothing. */
const SNAPSHOT_TTL_MS = 5000;
const VIEW_TTL_MS = 10_000;
const IDENTITY_TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;
const SWEEP_THRESHOLD = 512;

interface Entry<T> {
  value?: T;
  error?: ClusterError;
  expiresAt: number;
}

/**
 * A small TTL cache with single-flight loads. The shared load is not tied to
 * any caller's request signal (one viewer disconnecting must not fail it for
 * the others); each load has its own deadline instead.
 */
class SharedCache<T> {
  private entries = new Map<string, Entry<T>>();
  private loading = new Map<string, Promise<T>>();

  constructor(private ttlMs: number) {}

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) {
      if (hit.error) throw hit.error;
      return hit.value as T;
    }
    const pending = this.loading.get(key);
    if (pending) return pending;
    const run = (async () => {
      try {
        const value = await load();
        this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        return value;
      } catch (err) {
        const error = toClusterError(err);
        this.entries.set(key, { error, expiresAt: Date.now() + Math.min(this.ttlMs, FAILURE_TTL_MS) });
        throw error;
      } finally {
        this.loading.delete(key);
        this.sweep();
      }
    })();
    this.loading.set(key, run);
    return run;
  }

  private sweep(): void {
    if (this.entries.size <= SWEEP_THRESHOLD) return;
    const now = Date.now();
    for (const [k, v] of this.entries) if (v.expiresAt <= now) this.entries.delete(k);
  }

  clear(): void {
    this.entries.clear();
    this.loading.clear();
  }
}

const TLS_CODES = /CERT|SSL|TLS|EPROTO|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/i;

function toClusterError(err: unknown): ClusterError {
  if (err instanceof ClusterError) return err;
  const code = (err as { code?: string } | null)?.code ?? '';
  if (TLS_CODES.test(code)) return new ClusterError('tls_error', 'TLS handshake with the node failed');
  return new ClusterError('unreachable', 'The node did not respond');
}

/** Connection identity: a changed endpoint, token or node scheme is a new key. */
function connectionKey(t: ClusterTarget): string {
  const tokenHash = createHash('sha256').update(t.admin_token ?? '').digest('hex').slice(0, 16);
  return `${t.id}|${t.endpoint_url ?? ''}|${tokenHash}|${t.node_scheme ?? ''}`;
}

/** Failures are logged when they change, not on every poll of a dead node. */
const lastLogged = new Map<string, string>();
function logChange(key: string, outcome: string, fields: Record<string, unknown>): void {
  if (lastLogged.get(key) === outcome) return;
  if (lastLogged.size > SWEEP_THRESHOLD) lastLogged.clear();
  lastLogged.set(key, outcome);
  if (outcome !== 'ok') console.warn('[cluster] node request failed', { ...fields, outcome });
}

async function get(
  url: string,
  opts: ClusterOptions & { token?: string | null; signal: AbortSignal; maxBytes: number },
): Promise<{ status: number; body: string; date: number | null }> {
  const res = await safeRequest(url, {
    allowHttp: true,
    allowPrivate: opts.allowPrivate,
    method: 'GET',
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    timeoutMs: IDLE_TIMEOUT_MS,
    signal: opts.signal,
    maxResponseBytes: opts.maxBytes,
  });
  const dateHeader = res.headers.date;
  const date = typeof dateHeader === 'string' ? Date.parse(dateHeader) : NaN;
  return { status: res.status, body: res.body.toString('utf8'), date: Number.isNaN(date) ? null : date };
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function endpointBase(t: ClusterTarget): string {
  const base = (t.endpoint_url ?? '').replace(/\/+$/, '');
  if (!base) throw new ClusterError('unreachable', 'This connection has no endpoint');
  return base;
}

// ---------------------------------------------------------------------------
// Node address policy

const endpointClassCache = new SharedCache<IpClass>(30_000);

async function ipClassOf(url: string, opts: ClusterOptions): Promise<IpClass> {
  const target = await assertSafeResolvedUrl(url, { allowHttp: true, allowPrivate: opts.allowPrivate });
  const classes = new Set(target.ips.map(classifyIp));
  if (classes.has('forbidden')) return 'forbidden';
  // A host resolving across classes cannot be placed; treat it as forbidden.
  return classes.size === 1 ? [...classes][0] : 'forbidden';
}

export interface ResolvedNode {
  nodeId: string;
  /** Origin to request, e.g. http://10.0.0.5:8000 */
  origin: string;
  /** host:port shown to the admin as the data's source. */
  display: string;
}

/** Where to reach `nodeId`, after the address policy; throws ClusterError. */
export async function resolveNode(
  t: ClusterTarget,
  status: ClusterStatus,
  nodeId: string,
  opts: ClusterOptions,
): Promise<ResolvedNode> {
  const node = status.nodes.find((n) => n.id === nodeId);
  if (!node) throw new ClusterError('not_found', 'No such node in this cluster');
  const hp = nodeApiHostPort(node);
  if (!hp) throw new ClusterError('bad_address', 'Arc reports no usable API address for this node');

  const base = endpointBase(t);
  const endpointScheme = new URL(base).protocol.replace(':', '');
  const scheme = t.node_scheme === 'http' || t.node_scheme === 'https' ? t.node_scheme : endpointScheme;
  const host = hp.host.includes(':') ? `[${hp.host}]` : hp.host;
  const origin = `${scheme}://${host}:${hp.port}`;

  let nodeClass: IpClass;
  let endpointClass: IpClass;
  try {
    [nodeClass, endpointClass] = await Promise.all([
      ipClassOf(origin, opts),
      endpointClassCache.get(`${base}|${opts.allowPrivate}`, () => ipClassOf(base, opts)),
    ]);
  } catch (err) {
    if (err instanceof ClusterError) throw err;
    // assertSafeResolvedUrl: a name that does not resolve is unreachable; any
    // other refusal (private target without the opt-in, blocked name) is policy.
    const code = (err as { code?: string }).code ?? '';
    const message = err instanceof Error ? err.message : '';
    if (/ENOTFOUND|EAI_AGAIN|ENODATA/.test(code) || /did not resolve/.test(message)) {
      throw new ClusterError('unreachable', 'The node address does not resolve from Launchpad');
    }
    throw new ClusterError('address_blocked', 'The node address is not allowed from Launchpad');
  }
  if (nodeClass === 'forbidden' || nodeClass !== endpointClass) {
    throw new ClusterError('address_blocked', 'The node address is outside the network class of the instance endpoint');
  }
  return { nodeId, origin, display: `${host}:${hp.port}` };
}

// ---------------------------------------------------------------------------
// Cluster view

export interface NodeReachability {
  reachable: boolean;
  error: ClusterErrorCode | null;
}

export interface ClusterView {
  status: ClusterStatus | Standalone;
  checkIntervalMs: number | null;
  /** The answering node's clock (Date header), for heartbeat ages. */
  serverTime: number | null;
  /** Whether Launchpad itself can reach each node's API (tokenless /health). */
  reachability: Record<string, NodeReachability>;
  fetchedAt: number;
}

const viewCache = new SharedCache<ClusterView>(VIEW_TTL_MS);

async function loadView(t: ClusterTarget, opts: ClusterOptions): Promise<ClusterView> {
  const base = endpointBase(t);
  const signal = AbortSignal.timeout(VIEW_DEADLINE_MS);
  const common = { ...opts, token: t.admin_token, signal };
  const [cluster, health] = await Promise.all([
    get(`${base}/api/v1/cluster`, { ...common, maxBytes: CLUSTER_MAX_BYTES }),
    get(`${base}/api/v1/cluster/health`, { ...common, maxBytes: SMALL_MAX_BYTES }).catch(() => null),
  ]);
  if (cluster.status === 401 || cluster.status === 403) throw new ClusterError('token_rejected', 'Arc rejected the stored token');
  if (cluster.status < 200 || cluster.status >= 300) throw new ClusterError('upstream_status', `Arc answered ${cluster.status}`);
  const status = parseClusterStatus(json(cluster.body));
  if (!status) throw new ClusterError('upstream_status', 'Arc returned an unexpected cluster response');

  const view: ClusterView = {
    status,
    checkIntervalMs: health && health.status === 200 ? parseCheckIntervalMs(json(health.body)) : null,
    serverTime: cluster.date,
    reachability: {},
    fetchedAt: Date.now(),
  };
  if (status.enabled) view.reachability = await checkReachability(t, status, opts, signal);
  return view;
}

async function checkReachability(
  t: ClusterTarget,
  status: ClusterStatus,
  opts: ClusterOptions,
  signal: AbortSignal,
): Promise<Record<string, NodeReachability>> {
  const out: Record<string, NodeReachability> = {};
  const queue = [...status.nodes];
  const worker = async () => {
    for (let n = queue.shift(); n; n = queue.shift()) {
      try {
        const node = await resolveNode(t, status, n.id, opts);
        // /health is public in Arc: no token, so no auth-failure counts.
        const res = await get(`${node.origin}/health`, { ...opts, signal, maxBytes: SMALL_MAX_BYTES });
        out[n.id] = res.status >= 200 && res.status < 300
          ? { reachable: true, error: null }
          : { reachable: false, error: 'upstream_status' };
      } catch (err) {
        out[n.id] = { reachable: false, error: toClusterError(err).code };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REACHABILITY_CONCURRENCY, queue.length) }, worker));
  return out;
}

/** Topology plus reachability; cached 10 s per connection and shared. */
export function getClusterView(t: ClusterTarget, opts: ClusterOptions): Promise<ClusterView> {
  return viewCache.get(`${connectionKey(t)}|${opts.allowPrivate}`, () => loadView(t, opts));
}

async function requireCluster(t: ClusterTarget, opts: ClusterOptions): Promise<ClusterStatus> {
  const view = await getClusterView(t, opts);
  if (!view.status.enabled) throw new ClusterError('standalone', 'Clustering is not enabled on this instance');
  return view.status;
}

// ---------------------------------------------------------------------------
// Identity

const identityCache = new SharedCache<true>(IDENTITY_TTL_MS);

async function verifyIdentity(t: ClusterTarget, status: ClusterStatus, node: ResolvedNode, opts: ClusterOptions): Promise<void> {
  await identityCache.get(`${connectionKey(t)}|${node.nodeId}|${node.origin}`, async () => {
    const res = await get(`${node.origin}/api/v1/cluster/local`, {
      ...opts,
      token: t.admin_token,
      signal: AbortSignal.timeout(NODE_DEADLINE_MS),
      maxBytes: SMALL_MAX_BYTES,
    });
    if (res.status === 401 || res.status === 403) throw new ClusterError('token_rejected', 'The node rejected the stored token');
    const body = json(res.body) as Record<string, unknown> | null;
    const sameNode = res.status === 200 && body?.id === node.nodeId;
    const sameCluster = !status.clusterName || body?.cluster_name === status.clusterName;
    if (!sameNode || !sameCluster) {
      throw new ClusterError('identity_mismatch', 'The address Arc reports for this node answered as a different node');
    }
    return true;
  });
}

async function reachNode(t: ClusterTarget, nodeId: string, opts: ClusterOptions): Promise<ResolvedNode> {
  const status = await requireCluster(t, opts);
  const node = await resolveNode(t, status, nodeId, opts);
  await verifyIdentity(t, status, node, opts);
  return node;
}

// ---------------------------------------------------------------------------
// Per-node data

export const SERIES_DURATIONS = [5, 15, 30, 60] as const;

export interface NodeSnapshotResult {
  nodeId: string;
  source: string;
  fetchedAt: number;
  snapshot: NodeSnapshot;
  series: Record<SeriesType, SeriesPoint[]>;
  /** Minutes the returned series actually cover (Arc's retention is config). */
  spanMinutes: number;
}

const snapshotCache = new SharedCache<NodeSnapshotResult>(SNAPSHOT_TTL_MS);

/** Metrics snapshot + charted series for one node; cached 5 s and shared. */
export function getNodeSnapshot(
  t: ClusterTarget,
  nodeId: string,
  durationMinutes: number,
  opts: ClusterOptions,
): Promise<NodeSnapshotResult> {
  const key = `${connectionKey(t)}|${nodeId}|${durationMinutes}|${opts.allowPrivate}`;
  return snapshotCache
    .get(key, async () => {
      const node = await reachNode(t, nodeId, opts);
      const signal = AbortSignal.timeout(NODE_DEADLINE_MS);
      // Arc serves /api/v1/metrics* publicly: no token on these.
      const common = { ...opts, signal };
      const types = Object.keys(SERIES_KEYS) as SeriesType[];
      const [metrics, ...series] = await Promise.all([
        get(`${node.origin}/api/v1/metrics`, { ...common, maxBytes: METRICS_MAX_BYTES }),
        ...types.map((type) =>
          get(`${node.origin}/api/v1/metrics/timeseries/${type}?duration_minutes=${durationMinutes}`, {
            ...common,
            maxBytes: SERIES_MAX_BYTES,
          }),
        ),
      ]);
      if (metrics.status !== 200) throw new ClusterError('upstream_status', `The node answered ${metrics.status}`);
      const out = {} as Record<SeriesType, SeriesPoint[]>;
      types.forEach((type, i) => {
        out[type] = series[i].status === 200 ? pickSeries(json(series[i].body), type) : [];
      });
      return {
        nodeId,
        source: node.display,
        fetchedAt: Date.now(),
        snapshot: pickSnapshot(json(metrics.body)),
        series: out,
        spanMinutes: Math.max(...types.map((type) => seriesSpanMinutes(out[type]))),
      };
    })
    .then(
      (v) => {
        logChange(`${t.id}|${nodeId}`, 'ok', {});
        return v;
      },
      (err: ClusterError) => {
        logChange(`${t.id}|${nodeId}`, err.code, { instance_id: t.id, node_id: nodeId });
        throw err;
      },
    );
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

/** Arc application logs from one node (admin-only in Arc, so the token goes). */
export async function getNodeLogs(
  t: ClusterTarget,
  nodeId: string,
  q: NodeLogsQuery,
  opts: ClusterOptions,
): Promise<NodeLogsResult> {
  const node = await reachNode(t, nodeId, opts);
  const params = new URLSearchParams({ limit: String(q.limit), since_minutes: String(q.sinceMinutes) });
  if (q.level) params.set('level', q.level);
  try {
    const res = await get(`${node.origin}/api/v1/logs?${params}`, {
      ...opts,
      token: t.admin_token,
      signal: AbortSignal.timeout(NODE_DEADLINE_MS),
      maxBytes: LOGS_MAX_BYTES,
    });
    if (res.status === 401 || res.status === 403) throw new ClusterError('token_rejected', 'The node rejected the stored token');
    if (res.status !== 200) throw new ClusterError('upstream_status', `The node answered ${res.status}`);
    return { nodeId, source: node.display, fetchedAt: Date.now(), logs: pickLogs(json(res.body), q.limit) };
  } catch (err) {
    const e = toClusterError(err);
    logChange(`${t.id}|${nodeId}|logs`, e.code, { instance_id: t.id, node_id: nodeId, resource: 'logs' });
    throw e;
  }
}

/** Test hook: module caches are per process. */
export function resetClusterCachesForTests(): void {
  viewCache.clear();
  identityCache.clear();
  snapshotCache.clear();
  endpointClassCache.clear();
  lastLogged.clear();
}
