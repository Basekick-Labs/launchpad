/**
 * Capability discovery for a connected Arc instance (#6).
 *
 * Arc has no capabilities endpoint, so this probes the routes that exist and
 * hands the answers to the pure decision table in $lib/capabilities. Every
 * probe carries the instance's admin token, so discovery does not depend on
 * which Arc routes answer without authentication.
 *
 * Deliberately free of $env imports (the caller passes allowPrivate) so the
 * module runs under vitest against a real local HTTP server.
 */

import { createHash } from 'node:crypto';
import { safeRequest } from './ssrf.js';
import { getDb } from './db.js';
import {
  CAPABILITIES,
  deriveCapabilities,
  parseClusterInfo,
  parseHealthLicense,
  type CapabilityId,
  type ClusterInfo,
  type InstanceCapabilities,
  type ProbeOutcome,
  type ProbeResults,
} from '../capabilities.js';

export interface DiscoveryTarget {
  id: string;
  endpoint_url: string | null;
  admin_token: string | null;
}

export interface DiscoveryOptions {
  allowPrivate: boolean;
  /** Bypass the cache (admin refresh). Still single-flighted. */
  force?: boolean;
}

const PROBE_TIMEOUT_MS = 5000;
/** Enough of a 403 body to tell "admin required" from "requires a license". */
const PROBE_BODY_BYTES = 512;
const HEALTH_MAX_BYTES = 64 * 1024;
/** /api/v1/cluster lists every node with stats. */
const CLUSTER_MAX_BYTES = 1024 * 1024;

/**
 * Successes are cached long enough that probing does not flood Arc's audit log
 * (with include_reads on, every probe is a row) and failures briefly, so a
 * dead instance does not make every page view wait out the timeout.
 */
export const SUCCESS_TTL_MS = 5 * 60 * 1000;
export const FAILURE_TTL_MS = 15 * 1000;
/** A forced refresh within this window returns the cached value. */
export const MIN_REFRESH_INTERVAL_MS = 10 * 1000;
const SWEEP_THRESHOLD = 256;

interface CacheEntry {
  value: InstanceCapabilities;
  fetchedAt: number;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<InstanceCapabilities>>();

/**
 * Keyed by the connection, not just the instance id: after the endpoint or
 * token changes the old entry is simply never read again, and a probe still
 * in flight for the old connection cannot repopulate the new one.
 */
function cacheKey(t: DiscoveryTarget): string {
  const tokenHash = createHash('sha256').update(t.admin_token ?? '').digest('hex').slice(0, 16);
  return `${t.id}|${t.endpoint_url ?? ''}|${tokenHash}`;
}

function sweep(now: number): void {
  if (cache.size <= SWEEP_THRESHOLD) return;
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
}

/** Test hook. */
export function clearCapabilityCache(): void {
  cache.clear();
  inFlight.clear();
}

async function probe(
  base: string,
  path: string,
  token: string | null,
  opts: DiscoveryOptions,
  size: { truncateResponseAt?: number; maxResponseBytes?: number },
): Promise<ProbeOutcome> {
  try {
    const res = await safeRequest(`${base}${path}`, {
      allowHttp: true,
      allowPrivate: opts.allowPrivate,
      method: 'GET', // not HEAD: Arc's audit middleware records HEAD requests
      headers: token ? { authorization: `Bearer ${token}` } : {},
      timeoutMs: PROBE_TIMEOUT_MS,
      ...size,
    });
    return { status: res.status, body: res.body.toString('utf8') };
  } catch {
    return null;
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function runProbes(t: DiscoveryTarget, opts: DiscoveryOptions): Promise<ProbeResults> {
  const base = (t.endpoint_url ?? '').replace(/\/+$/, '');
  const token = t.admin_token;
  const empty: ProbeResults = {
    hasToken: !!token, health: null, tokenPermissions: null, tokenRejected: false, cluster: null, probes: {},
  };
  if (!base) return empty;

  // /health first: when Arc is down, skip the other probes rather than wait
  // out a timeout on each.
  const health = await probe(base, '/health', token, opts, { maxResponseBytes: HEALTH_MAX_BYTES });
  if (!health || health.status < 200 || health.status >= 300) return empty;
  const healthBody = parseJson(health.body) as Record<string, unknown> | null;
  const results: ProbeResults = {
    ...empty,
    health: { license: parseHealthLicense(healthBody?.license) },
  };
  if (!token) return results;

  const gated = CAPABILITIES.filter((d) => d.probePath !== null);
  const [verify, cluster, ...answers] = await Promise.all([
    probe(base, '/api/v1/auth/verify', token, opts, { maxResponseBytes: HEALTH_MAX_BYTES }),
    probe(base, '/api/v1/cluster', token, opts, { maxResponseBytes: CLUSTER_MAX_BYTES }),
    ...gated.map((d) => probe(base, d.probePath!, token, opts, { truncateResponseAt: PROBE_BODY_BYTES })),
  ]);

  if (verify?.status === 401) results.tokenRejected = true;
  if (verify && verify.status >= 200 && verify.status < 300) {
    const perms = (parseJson(verify.body) as Record<string, unknown> | null)?.permissions;
    if (Array.isArray(perms) && perms.every((p) => typeof p === 'string')) results.tokenPermissions = perms;
  }

  let clusterInfo: ClusterInfo | null = null;
  if (cluster?.status === 401) results.tokenRejected = true;
  // A disabled cluster answers 200 with success:false and the reason.
  if (cluster && cluster.status >= 200 && cluster.status < 300) clusterInfo = parseClusterInfo(parseJson(cluster.body));
  results.cluster = clusterInfo;

  gated.forEach((d, i) => {
    results.probes[d.id as CapabilityId] = answers[i];
  });
  return results;
}

/**
 * Record the detected version. Only for the connection that was probed: if
 * the endpoint changed meanwhile, the row no longer matches and nothing is
 * written.
 */
function persistVersion(t: DiscoveryTarget, version: string | null): void {
  if (!version) return;
  getDb()
    .prepare(
      `UPDATE instances SET detected_arc_version = ?
       WHERE id = ? AND endpoint_url = ? AND deleted_at IS NULL
         AND detected_arc_version IS NOT ?`,
    )
    .run(version, t.id, t.endpoint_url, version);
}

/**
 * Discover what an instance supports. Cached per connection, and concurrent
 * callers share one probe set. The shared promise is deliberately not tied
 * to any caller's request signal: one client disconnecting must not fail it
 * for the others.
 */
export async function discoverCapabilities(
  t: DiscoveryTarget,
  opts: DiscoveryOptions,
): Promise<InstanceCapabilities> {
  const key = cacheKey(t);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && (opts.force ? now - hit.fetchedAt < MIN_REFRESH_INTERVAL_MS : hit.expiresAt > now)) {
    return hit.value;
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const run = (async () => {
    try {
      const value = deriveCapabilities(await runProbes(t, opts));
      const fetchedAt = Date.now();
      cache.set(key, {
        value,
        fetchedAt,
        expiresAt: fetchedAt + (value.reachable ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
      });
      sweep(fetchedAt);
      persistVersion(t, value.version);
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, run);
  return run;
}
