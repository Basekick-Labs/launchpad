/**
 * The single path every panel query takes.
 *
 * Without it a 20-panel dashboard on auto-refresh is a thundering herd against
 * one Arc instance, and a fast range change leaves stale responses racing to
 * overwrite fresh ones.
 *
 * Pipeline: resolve the instance -> interpolate variables -> expand macros ->
 * transport -> normalize to a Frame.
 *
 * ## This runs in the BROWSER, and that is load-bearing
 *
 * It POSTs to `/api/v1/orgs/{orgId}/instances/{instanceId}/proxy/api/v1/query`.
 * The proxy checks membership against that same `orgId` and requires
 * `instance.org_id === orgId`, returning an undifferentiated 404 otherwise — so
 * a forged `Target.instanceId`, including one naming an instance in another org
 * the same user belongs to, gets a 404 rather than data. **The runner never
 * sees an endpoint URL or an admin token.**
 *
 * Two invariants that keep that true:
 *
 * 1. **`orgId` comes from the route, never from the dashboard document.** If a
 *    future `Target.orgId` were honoured here, the proxy's org predicate would
 *    be checking a value the attacker supplied.
 * 2. **Do not reuse this server-side without adding the org-scoped resolver.**
 *    `alertEvaluator.ts` is the cautionary example: it joins `instances` with no
 *    `org_id` predicate and calls Arc with the admin token.
 *
 * Related: the 404 is deliberately undifferentiated — "does not exist" and
 * "belongs to another org" are one branch with one message. Do not synthesize a
 * more specific message here; that rebuilds the oracle the proxy closed.
 *
 * ## Why there is no retry
 *
 * The transport already retries where retrying is safe: `streamUpstreamWithFallback`
 * tries each resolved IP at the connect/header stage and deliberately stops once
 * headers exist, because a POSTed query has already run. Past that point the
 * refresh tick is the retry. Adding one here would multiply a failing dashboard
 * against an instance that is already unwell — 20 panels at the 5s floor is
 * already 240 requests/minute, and the proxy has no rate limit. A per-instance
 * error backoff belongs with the refresh scheduler (#27), which owns the tick.
 */

import { applyMacros, computeIntervalMs, type MacroContext } from './macros';
import { normalizeFrame, type Frame, type FrameShape } from './frame';
import { resolveInstanceRef, type InstanceRefFailure } from './instanceRef';
import { durationToMsLoose } from './duration';
import type { Dashboard, Panel, Target } from './model';
import { ArcQueryError, type QueryResult } from '../arcClient';

// ---------------------------------------------------------------------------
// The transport seam
// ---------------------------------------------------------------------------

export interface TransportRequest {
  orgId: string;
  instanceId: string;
  sql: string;
  database?: string;
  signal?: AbortSignal;
}

/**
 * Injected, never constructed at module scope. A relative URL cannot be parsed
 * outside a browser, so a module-level default would make this file impossible
 * to import under vitest.
 */
export type QueryTransport = (req: TransportRequest) => Promise<QueryResult>;

/** The real one. Build it in the page, not here. */
export function createProxyTransport(fetchImpl: typeof fetch = fetch): QueryTransport {
  return async ({ orgId, instanceId, sql, database, signal }) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (database) headers['x-arc-database'] = database;

    const res = await fetchImpl(
      `/api/v1/orgs/${encodeURIComponent(orgId)}/instances/${encodeURIComponent(instanceId)}/proxy/api/v1/query`,
      { method: 'POST', headers, body: JSON.stringify({ sql }), signal },
    );
    if (!res.ok) throw new ArcQueryError(res.status, await res.text().catch(() => ''));

    let body: {
      columns?: string[];
      data?: unknown[][];
      row_count?: number;
      rows_capped?: boolean;
      row_cap?: number;
      truncated?: boolean;
      truncation_reason?: string;
    };
    try {
      body = await res.json();
    } catch (err) {
      // The proxy commits the status before streaming, so an upstream failure
      // mid-body reaches us as a truncated 200.
      throw new ArcQueryError(res.status, 'Arc returned a malformed or truncated response', {
        cause: err,
      });
    }
    return {
      columns: body.columns ?? [],
      rows: body.data ?? [],
      rowCount: body.row_count ?? 0,
      rowsCapped: body.rows_capped,
      rowCap: body.row_cap,
      truncated: body.truncated,
      truncationReason: body.truncation_reason,
    };
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type PanelStatus = 'idle' | 'loading' | 'success' | 'error';

export type QueryErrorKind =
  /** Arc rejected the SQL. Its message is the useful part — show it. */
  | 'query'
  /** The proxy refused, with a message we wrote. Safe to show verbatim. */
  | 'proxy'
  /** Not a member, or not allowed on this path. */
  | 'permission'
  /** The instance is gone, or not in this org. Message stays undifferentiated. */
  | 'instance'
  /** The dashboard does not say which instance to query. */
  | 'unresolved'
  /** Transport failure. Detail is logged, not shown. */
  | 'network';

export interface QueryError {
  kind: QueryErrorKind;
  /** Safe to render. */
  message: string;
  /** Diagnostic only — may contain upstream detail. Never rendered. */
  detail?: string;
  status?: number;
}

export interface TargetResult {
  refId: string;
  /** The SQL actually sent, retained for the panel inspector. */
  executedSql: string;
  frame?: Frame;
  error?: QueryError;
  /** Whether this target's rows came from the cache. */
  cached: boolean;
  /**
   * Wall-clock milliseconds for this target, including time spent queued behind
   * the concurrency limit. A cache hit is ~0, which is why the inspector shows
   * `cached` alongside it — an unlabelled 0ms reads as a broken timer.
   */
  durationMs: number;
}

export interface PanelResult {
  panelId: string;
  status: PanelStatus;
  targets: TargetResult[];
  /** Set only when EVERY executed target failed. */
  error?: QueryError;
  /** The generation this result belongs to; stale ones are dropped by the caller. */
  generation: number;
  /** True when the request was superseded. Never render this as an error. */
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface RunContext {
  /** From the route. NEVER from the dashboard document — see the header. */
  orgId: string;
  /**
   * Absolute instants, resolved ONCE per tick for the whole dashboard.
   *
   * Not a relative string, and not resolved per panel: if each panel resolved
   * `now-6h` itself, two panels a millisecond apart would produce different
   * cache keys and dedupe would never fire — implemented, and inert.
   */
  from: number;
  to: number;
  /** A concrete IANA zone. `'browser'` must be resolved before it gets here. */
  timezone: string;
  /** The dashboard-level interval floor. `Panel.interval` is the panel's. */
  minInterval?: string;
  /** Variable values. #31 fills this; interpolation happens before the key. */
  variables?: Readonly<Record<string, string>>;
}

export interface RunPanelOptions {
  /**
   * Point budget, from the panel's RENDERED WIDTH — which is why it is per call
   * rather than on the context. It feeds `$__interval`, so it changes the SQL,
   * so it changes the cache key: a resize must not serve a frame bucketed at the
   * old width.
   */
  maxDataPoints?: number;
  /** Bypass the cache for this run (an explicit refresh). */
  noCache?: boolean;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface InFlight {
  promise: Promise<QueryResult>;
  controller: AbortController;
  refs: number;
  /** Set the moment abort is decided, so no one can join a dying entry. */
  dead: boolean;
}

interface CacheEntry {
  result: QueryResult;
  expiresAt: number;
}

export interface QueryRunnerOptions {
  transport: QueryTransport;
  /** Max simultaneous transport calls. */
  concurrency?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  /** Diagnostics for failures the user is not shown. */
  onError?: (err: QueryError, ctx: { panelId: string; refId: string }) => void;
}

const DEFAULTS = { concurrency: 5, cacheTtlMs: 5_000, maxCacheEntries: 200 };

/**
 * NUL-joined, not `|`-joined: one component is arbitrary SQL, and `||` is
 * DuckDB's concatenation operator, so a pipe delimiter is not injective.
 */
/**
 * The identity of a REQUEST — everything that determines which rows come back.
 *
 * Exported because the panel editor needs the same answer to decide whether an
 * edit requires a new query or only a redraw, and a second definition would
 * drift. The editor asks {@link panelRequestKeys}; `runTarget` builds it here.
 */
export function requestKey(
  orgId: string,
  instanceId: string,
  database: string | undefined,
  expandedSql: string,
  bounds: { from: number; to: number },
): string {
  return cacheKey([
    orgId,
    instanceId,
    database ?? '',
    expandedSql,
    String(bounds.from),
    String(bounds.to),
  ]);
}

function cacheKey(parts: readonly string[]): string {
  return parts.join(' ');
}

export function createQueryRunner(opts: QueryRunnerOptions) {
  const transport = opts.transport;
  const limit = opts.concurrency ?? DEFAULTS.concurrency;
  const ttl = opts.cacheTtlMs ?? DEFAULTS.cacheTtlMs;
  const maxEntries = opts.maxCacheEntries ?? DEFAULTS.maxCacheEntries;

  const inFlight = new Map<string, InFlight>();
  const cache = new Map<string, CacheEntry>();
  /** Per panel: the current generation, so a late result can be discarded. */
  const generations = new Map<string, number>();

  let active = 0;
  /** Waiters hold their own cancel hook so a cancelled one leaves the queue. */
  const queue: Array<{ start: () => void; cancel: () => void }> = [];

  // -- semaphore ------------------------------------------------------------

  function acquirePermit(signal: AbortSignal): Promise<void> {
    // Never hand a permit to work that is already cancelled.
    if (signal.aborted) return Promise.reject(abortError(signal));
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        start: () => {
          active++;
          resolve();
        },
        // A cancelled waiter must SETTLE, not just leave the queue: an
        // unsettled promise means `runPanel` never returns and its entry is
        // pinned forever.
        cancel: () => reject(abortError(signal)),
      };
      queue.push(waiter);
      signal.addEventListener(
        'abort',
        () => {
          const i = queue.indexOf(waiter);
          if (i >= 0) {
            queue.splice(i, 1);
            waiter.cancel();
          }
        },
        { once: true },
      );
    });
  }

  /**
   * Every acquire pairs with exactly one release, in a `finally` that also runs
   * on the abort path. A permit handed to a waiter that then returns early
   * without releasing is how the queue deadlocks with `active === limit` and
   * nothing running.
   */
  function releasePermit(): void {
    active--;
    const next = queue.shift();
    if (next) next.start();
  }

  // -- dedupe ---------------------------------------------------------------

  /**
   * Joins or creates the shared request for a key, and returns a ONE-SHOT
   * disposer.
   *
   * The disposer captures the entry object and its own `done` flag rather than
   * the key, which closes three failures at once:
   *
   *   - a double release (from `runPanel`'s finally AND `cancelPanel`) cannot
   *     drive `refs` negative, nor abort a request a co-subscriber is still
   *     waiting on;
   *   - cleanup cannot evict a NEWER entry stored under the same key, because
   *     the delete is conditional on identity;
   *   - nobody can join an entry whose abort has been decided, which would
   *     otherwise leave a panel stuck in `loading` after an unrelated cancel.
   */
  function share(
    key: string,
    signalless: (signal: AbortSignal) => Promise<QueryResult>,
  ): { promise: Promise<QueryResult>; release: () => void } {
    let entry = inFlight.get(key);
    if (!entry || entry.dead) {
      const controller = new AbortController();
      const created: InFlight = {
        controller,
        refs: 0,
        dead: false,
        promise: Promise.resolve().then(() => signalless(controller.signal)),
      };
      // Settled entries stop being joinable, but only if they are still the
      // entry stored under this key.
      created.promise
        .catch(() => undefined)
        .then(() => {
          if (inFlight.get(key) === created) inFlight.delete(key);
        });
      inFlight.set(key, created);
      entry = created;
    }

    entry.refs++;
    const held = entry;
    let done = false;
    return {
      promise: held.promise,
      release: () => {
        if (done) return;
        done = true;
        held.refs--;
        if (held.refs <= 0 && !held.dead) {
          held.dead = true;
          // Abort and unregister in the same synchronous step, so no request
          // can join between them.
          if (inFlight.get(key) === held) inFlight.delete(key);
          held.controller.abort();
        }
      },
    };
  }

  // -- cache ----------------------------------------------------------------

  function readCache(key: string): QueryResult | null {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      cache.delete(key);
      return null;
    }
    return hit.result;
  }

  /**
   * Only ever called with a fully-settled successful response. An aborted or
   * errored read must never write, or a short body gets stored under a key
   * every other panel reads.
   *
   * Bounded: the key contains user-authored SQL, and an unbounded map keyed by
   * user input is the shape already fixed twice in this codebase.
   */
  function writeCache(key: string, result: QueryResult): void {
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { result, expiresAt: Date.now() + ttl });
  }

  // -- execution ------------------------------------------------------------

  async function runTarget(
    dashboard: Dashboard,
    panel: Panel,
    target: Target,
    ctx: RunContext,
    bounds: { from: number; to: number },
    runOpts: RunPanelOptions,
    signal: AbortSignal,
  ): Promise<TargetResult> {
    const refId = target.refId;
    const startedAt = performance.now();

    const ref = resolveInstanceRef(dashboard, panel, target, ctx.variables ?? {});
    if (!ref.ok) {
      return {
        refId,
        executedSql: '',
        cached: false,
        durationMs: 0,
        error: unresolvedError(ref.reason, ref.path),
      };
    }

    // Interpolate BEFORE expanding and before keying, so two different variable
    // selections cannot collide on one key once #31 lands.
    const interpolated = interpolate(target.sql, ctx.variables);

    const intervalMs = computeIntervalMs(bounds.to - bounds.from, {
      // The rendered width wins when the caller knows it; otherwise the panel's
      // stored budget. Reading only `runOpts` left `Panel.maxDataPoints` — a
      // stored, validated field documented as feeding this very calculation —
      // silently inert, so the panel editor's control would have done nothing.
      maxDataPoints: runOpts.maxDataPoints ?? panel.maxDataPoints,
      panelInterval: panel.interval,
      minInterval: ctx.minInterval,
    });
    const macroCtx: MacroContext = {
      from: new Date(bounds.from),
      to: new Date(bounds.to),
      intervalMs,
      timezone: ctx.timezone,
    };
    const executedSql = applyMacros(interpolated, macroCtx);

    // The key covers exactly what determines the ROWS. `format` and `refId`
    // change only how those rows are normalized, so they are deliberately
    // absent — which is why the cache stores the raw result and each target
    // normalizes its own frame.
    const key = requestKey(ctx.orgId, ref.id, target.database, executedSql, bounds);

    if (!runOpts.noCache) {
      const hit = readCache(key);
      if (hit) {
        return { refId, executedSql, cached: true, durationMs: 0, frame: toFrame(hit, target) };
      }
    }

    const shared = share(key, (sig) =>
      runWithPermit(sig, () =>
        transport({
          orgId: ctx.orgId,
          instanceId: ref.id,
          sql: executedSql,
          database: target.database,
          signal: sig,
        }),
      ),
    );

    // The panel's signal must be able to end this WAIT, not just the request.
    // Awaiting `shared.promise` alone hangs forever on cancel: the release lives
    // in the finally, the finally needs the await to settle, and the shared
    // controller only aborts once the refcount reaches zero — which the release
    // is what causes. Racing breaks the cycle: the wait ends, the finally runs,
    // the refcount drops, and the request aborts only if nobody else holds it.
    let onAbort: (() => void) | undefined;
    try {
      const result = await new Promise<QueryResult>((resolve, reject) => {
        if (signal.aborted) {
          reject(abortError(signal));
          return;
        }
        onAbort = () => reject(abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        shared.promise.then(resolve, reject);
      });
      writeCache(key, result);
      return {
        refId,
        executedSql,
        cached: false,
        durationMs: Math.round(performance.now() - startedAt),
        frame: toFrame(result, target),
      };
    } catch (err) {
      if (signal.aborted) throw err; // cancelled, not failed — surfaced by runPanel
      const error = classify(err);
      opts.onError?.(error, { panelId: panel.id, refId });
      return {
        refId,
        executedSql,
        cached: false,
        durationMs: Math.round(performance.now() - startedAt),
        error,
      };
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      shared.release();
    }
  }

  /** Permit strictly paired with its release, including on the abort path. */
  async function runWithPermit<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    await acquirePermit(signal);
    try {
      return await work();
    } finally {
      releasePermit();
    }
  }

  // -- public ---------------------------------------------------------------

  async function runPanel(
    dashboard: Dashboard,
    panel: Panel,
    ctx: RunContext,
    runOpts: RunPanelOptions = {},
  ): Promise<PanelResult> {
    const generation = (generations.get(panel.id) ?? 0) + 1;
    generations.set(panel.id, generation);

    // `hide` is kept in the model but not executed. An empty `sql` is what
    // `createPanel` produces for every new panel, so without this skip an
    // unconfigured panel POSTs "" to Arc on every refresh tick.
    const targets = panel.targets.filter((t) => !t.hide && t.sql.trim() !== '');
    if (targets.length === 0) {
      return { panelId: panel.id, status: 'idle', targets: [], generation, cancelled: false };
    }

    const bounds = effectiveBounds(panel, ctx);
    const controller = new AbortController();
    panelControllers.set(panel.id, controller);

    // allSettled, not all: one target rejecting must not abandon the other
    // subscriptions' releases, which would pin their entries for the page's life.
    const settled = await Promise.allSettled(
      targets.map((t) => runTarget(dashboard, panel, t, ctx, bounds, runOpts, controller.signal)),
    );

    if (panelControllers.get(panel.id) === controller) panelControllers.delete(panel.id);

    const cancelled = controller.signal.aborted;
    const results: TargetResult[] = settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : {
            refId: targets[i].refId,
            executedSql: '',
            cached: false,
            durationMs: 0,
            error: cancelled ? undefined : classify(s.reason),
          },
    );

    // A superseded run is not a failure. Painting it red is how a cancelled
    // panel ends up showing an error the user cannot act on.
    if (cancelled) {
      return { panelId: panel.id, status: 'idle', targets: results, generation, cancelled: true };
    }

    const failures = results.filter((r) => r.error);
    const status: PanelStatus = failures.length === results.length ? 'error' : 'success';
    return {
      panelId: panel.id,
      status,
      targets: results,
      error: status === 'error' ? failures[0].error : undefined,
      generation,
      cancelled: false,
    };
  }

  const panelControllers = new Map<string, AbortController>();

  function cancelPanel(panelId: string): void {
    panelControllers.get(panelId)?.abort();
    panelControllers.delete(panelId);
  }

  function cancelAll(): void {
    for (const c of panelControllers.values()) c.abort();
    panelControllers.clear();
  }

  /**
   * Call on unmount. `cancelAll` alone leaves the generation map growing by one
   * entry per panel of every dashboard an SPA session visits.
   */
  function dispose(): void {
    cancelAll();
    generations.clear();
    cache.clear();
    for (const w of queue.splice(0)) w.cancel();
  }

  return {
    runPanel,
    cancelPanel,
    cancelAll,
    dispose,
    clearCache: () => cache.clear(),
    /** Assertable state, so the concurrency and dedupe claims can be tested. */
    stats: () => ({ inFlight: inFlight.size, active, queued: queue.length, cacheSize: cache.size }),
    /** Exposed so the caller can drop a result whose generation moved on. */
    isCurrent: (panelId: string, generation: number) => generations.get(panelId) === generation,
  };
}

export type QueryRunner = ReturnType<typeof createQueryRunner>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A panel may render its own range (`timeFrom`) or a shifted one (`timeShift`),
 * so the bounds that reach the macros — and the cache key — are per panel.
 * Keying on the dashboard range would collide a week-over-week panel with its
 * unshifted twin and silently render the same data twice.
 */
export function effectiveBounds(panel: Panel, ctx: RunContext): { from: number; to: number } {
  let { from, to } = ctx;
  if (panel.timeFrom) {
    const span = durationToMsLoose(panel.timeFrom);
    if (span !== null) from = to - span;
  }
  if (panel.timeShift) {
    const shift = durationToMsLoose(panel.timeShift);
    if (shift !== null) {
      from -= shift;
      to -= shift;
    }
  }
  return { from, to };
}

/** `TargetFormat` -> `FrameShape`. `'logs'` has no frame counterpart. */
function shapeFor(target: Target): FrameShape | 'auto' {
  switch (target.format) {
    case 'table':
      return 'table';
    case 'time_series':
      return 'wide';
    // 'logs' is a RENDERING choice, not a frame layout — the logs panel reads a
    // table. Inferring keeps a log query usable in a table panel too.
    case 'logs':
    default:
      return 'auto';
  }
}

function toFrame(result: QueryResult, target: Target): Frame {
  return normalizeFrame(
    {
      columns: result.columns,
      rows: result.rows,
      rowsCapped: result.rowsCapped,
      truncated: result.truncated,
      truncationReason: result.truncationReason,
    },
    { refId: target.refId, shape: shapeFor(target) },
  );
}

function interpolate(sql: string, vars?: Readonly<Record<string, string>>): string {
  // #31 owns the real engine, including the quoting rules that stop a variable
  // value from closing the macro's parenthesis. Until then this is identity —
  // deliberately, because a half-built substitution is worse than none.
  void vars;
  return sql;
}

function abortError(signal: AbortSignal): Error {
  return (signal.reason as Error) ?? new DOMException('This operation was aborted', 'AbortError');
}

function unresolvedError(reason: InstanceRefFailure, path: string): QueryError {
  const message =
    reason === 'unset'
      ? 'This dashboard does not have an Arc instance selected.'
      : reason === 'undeclared_variable'
        ? 'The panel references an instance variable that is not declared.'
        : 'Select a value for the instance variable to run this query.';
  return { kind: 'unresolved', message, detail: path };
}

/**
 * Status-keyed, which is why the transport throws `ArcQueryError` rather than a
 * plain `Error` — the previous shape discarded the status and left the consumer
 * matching on message text.
 */
export function classify(err: unknown): QueryError {
  if (err instanceof ArcQueryError) {
    const { status, body } = err;
    if (status === 401 || status === 403) {
      return {
        kind: 'permission',
        message: 'You do not have permission to query this instance.',
        status,
        detail: body,
      };
    }
    if (status === 404) {
      // Undifferentiated on purpose — see the module header.
      return { kind: 'instance', message: 'Instance not found.', status, detail: body };
    }
    if (status === 502 || status === 503) {
      // The proxy's 502 bodies are strings we author, including the genuinely
      // actionable "response is too large — narrow the query or add a LIMIT".
      // Collapsing them into "network error" throws away the best message the
      // proxy has.
      const proxyMessage = proxyErrorText(body);
      if (proxyMessage) return { kind: 'proxy', message: proxyMessage, status, detail: body };
      return {
        kind: 'network',
        message: 'Could not reach the Arc instance.',
        status,
        detail: body,
      };
    }
    // Everything else is Arc complaining about the SQL, and its message is the
    // whole point.
    return { kind: 'query', message: body || 'Arc rejected the query.', status, detail: body };
  }

  return {
    kind: 'network',
    message: 'Could not reach the Arc instance.',
    detail: err instanceof Error ? err.message : String(err),
  };
}

/** The proxy answers with `{"error": "..."}`; Arc's own body is not this shape. */
function proxyErrorText(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}

/**
 * Every request this panel would issue, as keys.
 *
 * The panel editor compares these across an edit: if they are unchanged, the
 * rows cannot have changed and the edit is a redraw rather than a query.
 *
 * Deliberately a function of the WHOLE input — dashboard, panel, context and run
 * options — because the expanded SQL moves with `panel.interval`,
 * `maxDataPoints`, `timeFrom`, `timeShift`, the dashboard range and
 * `minInterval`. Comparing `target.sql` alone silently misses all six: a user
 * setting "Min interval 5m" would watch a preview that never changed and then
 * save a panel that did.
 *
 * `null` for a target whose instance cannot be resolved — two unresolvable
 * targets are not the same request, they are both no request at all.
 */
export function panelRequestKeys(
  dashboard: Dashboard,
  panel: Panel,
  ctx: RunContext,
  runOpts: RunPanelOptions = {},
): Array<string | null> {
  const bounds = effectiveBounds(panel, ctx);
  const intervalMs = computeIntervalMs(bounds.to - bounds.from, {
    maxDataPoints: runOpts.maxDataPoints ?? panel.maxDataPoints,
    panelInterval: panel.interval,
    minInterval: ctx.minInterval,
  });
  return panel.targets
    .filter((t) => !t.hide && t.sql.trim() !== '')
    .map((target) => {
      const ref = resolveInstanceRef(dashboard, panel, target, ctx.variables ?? {});
      if (!ref.ok) return null;
      const executedSql = applyMacros(target.sql, {
        from: new Date(bounds.from),
        to: new Date(bounds.to),
        intervalMs,
        timezone: ctx.timezone,
      });
      return requestKey(ctx.orgId, ref.id, target.database, executedSql, bounds);
    });
}
