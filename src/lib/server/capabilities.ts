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
  parseSchedulers,
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
/**
 * Whole-discovery deadline. PROBE_TIMEOUT_MS is idle-only (safeRequest), so a
 * server that drips a byte at a time would otherwise hold the shared in-flight
 * promise, and every caller for that instance, indefinitely.
 */
const DISCOVERY_DEADLINE_MS = 12_000;
/** Enough of a 403 body to tell "admin required" from "requires a license". */
const PROBE_BODY_BYTES = 512;
const HEALTH_MAX_BYTES = 64 * 1024;
/** /api/v1/cluster lists every node with stats. */
const CLUSTER_MAX_BYTES = 1024 * 1024;
/** /api/v1/schedulers lists every scheduled continuous query. */
const SCHEDULERS_MAX_BYTES = 1024 * 1024;

/**
 * Successes are cached long enough that probing does not flood Arc's audit log
 * (with include_reads on, every probe is a row) and failures briefly, so a
 * dead instance does not make every page view wait out the deadline.
 */
const SUCCESS_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 15 * 1000;
/** A forced refresh within this window returns the cached value. */
const MIN_REFRESH_INTERVAL_MS = 10 * 1000;
const SWEEP_THRESHOLD = 256;

const GATED = CAPABILITIES.flatMap((d) => (d.probePath ? [{ id: d.id, path: d.probePath }] : []));

interface CacheEntry {
  value: InstanceCapabilities;
  fetchedAt: number;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<InstanceCapabilities>>();
/** Last logged outcome per connection, so failures log on change, not per call. */
const lastLogged = new Map<string, string>();

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
    if (v.expiresAt <= now) {
      cache.delete(k);
      lastLogged.delete(k);
    }
  }
}

/** Test hook: module state is per process, and tests share one. */
export function resetCapabilityCacheForTests(): void {
  cache.clear();
  inFlight.clear();
  lastLogged.clear();
}

interface ProbeContext {
  base: string;
  token: string | null;
  allowPrivate: boolean;
  signal: AbortSignal;
  /** First transport error per path, for the operator log line. */
  errors: Record<string, string>;
}

async function probe(
  ctx: ProbeContext,
  path: string,
  size: { truncateResponseAt?: number; maxResponseBytes?: number },
): Promise<ProbeOutcome> {
  try {
    const res = await safeRequest(`${ctx.base}${path}`, {
      allowHttp: true,
      allowPrivate: ctx.allowPrivate,
      method: 'GET',
      headers: ctx.token ? { authorization: `Bearer ${ctx.token}` } : {},
      timeoutMs: PROBE_TIMEOUT_MS,
      signal: ctx.signal,
      ...size,
    });
    return { status: res.status, body: res.body.toString('utf8') };
  } catch (err) {
    ctx.errors[path] = err instanceof Error ? err.message.slice(0, 120) : 'error';
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const is2xx = (o: ProbeOutcome | undefined): o is NonNullable<ProbeOutcome> => !!o && o.status >= 200 && o.status < 300;

async function runProbes(ctx: ProbeContext): Promise<ProbeResults> {
  const results: ProbeResults = {
    hasToken: !!ctx.token, health: null, tokenPermissions: null, tokenRejected: false, cluster: null, schedulers: null,
    probes: {},
  };
  if (!ctx.base) return results;

  // Round 1: /health, plus the token check when there is a token. Arc serves
  // /api/v1/auth/verify publicly, so it costs no auth-failure count.
  const [health, verify] = await Promise.all([
    probe(ctx, '/health', { maxResponseBytes: HEALTH_MAX_BYTES }),
    ctx.token ? probe(ctx, '/api/v1/auth/verify', { maxResponseBytes: HEALTH_MAX_BYTES }) : Promise.resolve(undefined),
  ]);
  if (!is2xx(health)) return results;
  results.health = { license: parseHealthLicense(asObject(parseJson(health.body))?.license) };
  if (!ctx.token) return results;

  if (verify?.status === 401) {
    // Every further probe would be a 401, and an auth-failure tick in Arc.
    results.tokenRejected = true;
    return results;
  }
  if (is2xx(verify)) {
    const perms = asObject(parseJson(verify.body))?.permissions;
    if (Array.isArray(perms) && perms.every((p) => typeof p === 'string')) results.tokenPermissions = perms;
  }
  const tokenIsAdmin = results.tokenPermissions ? results.tokenPermissions.includes('admin') : null;

  // Round 2: /api/v1/cluster and /api/v1/schedulers take any token; the gated
  // areas need admin.
  const gated = tokenIsAdmin === false ? [] : GATED;
  const [cluster, schedulers, ...answers] = await Promise.all([
    probe(ctx, '/api/v1/cluster', { maxResponseBytes: CLUSTER_MAX_BYTES }),
    probe(ctx, '/api/v1/schedulers', { maxResponseBytes: SCHEDULERS_MAX_BYTES }),
    ...gated.map((g) => probe(ctx, g.path, { truncateResponseAt: PROBE_BODY_BYTES })),
  ]);
  results.clusterProbe = cluster;
  // A disabled cluster answers 200 with success:false and the reason.
  if (is2xx(cluster)) results.cluster = parseClusterInfo(parseJson(cluster.body));
  results.schedulersProbe = schedulers;
  // A scheduler that is not running is a 200 too, with the reason.
  if (is2xx(schedulers)) results.schedulers = parseSchedulers(parseJson(schedulers.body));
  gated.forEach((g, i) => {
    results.probes[g.id] = answers[i];
  });
  return results;
}

/** Anything worth a short TTL: an unreachable Arc or a probe that failed. */
function isDegraded(value: InstanceCapabilities): boolean {
  return !value.reachable ||
    Object.values(value.capabilities).some((c) => c.reason === 'unreachable' || c.reason === 'error');
}

/**
 * Record the version the instance reported, or clear it when a successful
 * cluster probe reported none (cluster mode turned off). Only for the
 * connection that was probed: if the endpoint changed meanwhile, the row no
 * longer matches and nothing is written.
 */
function persistVersion(t: DiscoveryTarget, results: ProbeResults, version: string | null): void {
  if (!results.cluster) return; // no answer: leave what is stored
  getDb()
    .prepare(
      `UPDATE instances SET detected_arc_version = ?
       WHERE id = ? AND endpoint_url = ? AND deleted_at IS NULL
         AND detected_arc_version IS NOT ?`,
    )
    .run(version, t.id, t.endpoint_url, version);
}

function logOutcome(key: string, t: DiscoveryTarget, value: InstanceCapabilities, errors: Record<string, string>, ms: number): void {
  const failed = Object.entries(value.capabilities)
    .filter(([, c]) => c.state === 'unknown')
    .map(([id, c]) => `${id}:${c.reason}`);
  const summary = `${value.reachable}|${failed.join(',')}`;
  if (lastLogged.get(key) === summary) return;
  lastLogged.set(key, summary);
  if (value.reachable && failed.length === 0) return; // recovered or healthy: nothing to report
  console.warn('[capabilities] discovery degraded', {
    instance_id: t.id,
    reachable: value.reachable,
    unknown: failed,
    errors,
    duration_ms: ms,
  });
}

/**
 * Discover what an instance supports. Cached per connection, and concurrent
 * callers share one probe set. The shared promise is deliberately not tied
 * to any caller's request signal: one client disconnecting must not fail it
 * for the others. DISCOVERY_DEADLINE_MS bounds it instead.
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
    const started = Date.now();
    const ctx: ProbeContext = {
      base: (t.endpoint_url ?? '').replace(/\/+$/, ''),
      token: t.admin_token,
      allowPrivate: opts.allowPrivate,
      signal: AbortSignal.timeout(DISCOVERY_DEADLINE_MS),
      errors: {},
    };
    try {
      const results = await runProbes(ctx);
      const value = deriveCapabilities(results);
      const fetchedAt = Date.now();
      cache.set(key, { value, fetchedAt, expiresAt: fetchedAt + (isDegraded(value) ? FAILURE_TTL_MS : SUCCESS_TTL_MS) });
      sweep(fetchedAt);
      logOutcome(key, t, value, ctx.errors, fetchedAt - started);
      try {
        persistVersion(t, results, value.version);
      } catch (err) {
        // The value is cached and correct; a locked DB must not fail callers.
        console.warn('[capabilities] could not store detected version', {
          instance_id: t.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, run);
  return run;
}
