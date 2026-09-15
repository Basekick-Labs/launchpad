import { describe, it, expect, vi } from 'vitest';
import {
  createQueryRunner,
  classify,
  effectiveBounds,
  type RunContext,
  type QueryRunnerOptions,
} from './queryRunner';
import { createFakeTransport } from './testTransport';
import { createDashboard, createPanel, type Dashboard, type Panel, type Target } from './model';
import { ArcQueryError } from '../arcClient';

const FROM = Date.UTC(2026, 0, 1, 0, 0, 0);
const TO = Date.UTC(2026, 0, 1, 6, 0, 0);

const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  orgId: 'org-1',
  from: FROM,
  to: TO,
  timezone: 'UTC',
  ...over,
});

function dash(over: Partial<Dashboard> = {}): Dashboard {
  return { ...createDashboard({ title: 'D', instanceId: 'inst-1' }), ...over };
}

function panel(id: string, targets: Partial<Target>[], over: Partial<Panel> = {}): Panel {
  const p = createPanel({ type: 'timeseries', gridPos: { x: 0, y: 0, w: 12, h: 8 }, id });
  return {
    ...p,
    targets: targets.map((t, i) => ({ refId: String.fromCharCode(65 + i), sql: 'SELECT 1', ...t })),
    ...over,
  };
}

/**
 * Drains pending microtasks AND one macrotask turn. `await Promise.resolve()` is
 * not enough: the chain is runPanel -> allSettled -> runTarget -> share ->
 * acquirePermit -> transport, so the transport call is several hops deep.
 */
const flush = () => new Promise((r) => setTimeout(r, 0));

const runner = (over: Partial<QueryRunnerOptions> = {}) => {
  const fake = createFakeTransport();
  const r = createQueryRunner({ transport: fake.transport, ...over });
  return { fake, r };
};

// ===========================================================================
// Acceptance criteria
// ===========================================================================

describe('AC: a stale result never replaces a fresh one', () => {
  it('marks the superseded generation so the caller can drop it', async () => {
    const { fake, r } = runner();
    const d = dash();
    const p = panel('p1', [{ sql: 'SELECT a' }]);

    const first = r.runPanel(d, p, ctx());
    await flush();
    // Range changes mid-flight.
    r.cancelPanel('p1');
    const second = r.runPanel(d, p, ctx({ from: FROM + 1000, to: TO + 1000 }));
    await flush();

    fake.resolveAll();
    const [a, b] = await Promise.all([first, second]);

    expect(a.cancelled).toBe(true);
    expect(a.generation).toBeLessThan(b.generation);
    expect(r.isCurrent('p1', a.generation)).toBe(false);
    expect(r.isCurrent('p1', b.generation)).toBe(true);
  });

  it('never reports a cancelled run as an error', async () => {
    // Painting a superseded panel red shows the user a failure they cannot act
    // on, and it is the most common way this goes wrong.
    const { fake, r } = runner();
    const promise = r.runPanel(dash(), panel('p1', [{}]), ctx());
    r.cancelPanel('p1');
    fake.resolveAll();
    const result = await promise;
    expect(result.cancelled).toBe(true);
    expect(result.status).toBe('idle');
    expect(result.error).toBeUndefined();
    expect(result.targets.every((t) => !t.error)).toBe(true);
  });
});

describe('AC: concurrency is capped', () => {
  it('never opens more than the limit, measured at the transport', async () => {
    // Asserted on the fake's high-water mark, not stats(): stats() samples only
    // at await points and would pass an implementation that briefly opens 20.
    const fake = createFakeTransport(0);
    const r = createQueryRunner({ transport: fake.transport, concurrency: 5 });
    const d = dash();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        r.runPanel(d, panel(`p${i}`, [{ sql: `SELECT ${i}` }]), ctx()),
      ),
    );

    expect(fake.peakConcurrent).toBeLessThanOrEqual(5);
    // Everything eventually ran, so the cap throttles rather than drops.
    expect(fake.calls.length).toBe(20);
    expect(results.every((x) => x.status === 'success')).toBe(true);
  });
});

describe('AC: identical queries share one request', () => {
  it('dedupes two panels with the same query', async () => {
    const { fake, r } = runner();
    const d = dash();
    const a = r.runPanel(d, panel('p1', [{ sql: 'SELECT same' }]), ctx());
    const b = r.runPanel(d, panel('p2', [{ sql: 'SELECT same' }]), ctx());
    await flush();
    expect(fake.calls.length).toBe(1);
    fake.resolveAll();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe('success');
    expect(rb.status).toBe('success');
  });

  it('dedupes even when both requests are QUEUED behind the limit', async () => {
    // The entry must be registered when the request is claimed, not when the
    // permit is granted — otherwise the AC fails in exactly the 20-panel
    // scenario it describes.
    const fake = createFakeTransport();
    const r = createQueryRunner({ transport: fake.transport, concurrency: 1 });
    const d = dash();
    const blocker = r.runPanel(d, panel('block', [{ sql: 'SELECT block' }]), ctx());
    await flush();

    const a = r.runPanel(d, panel('p1', [{ sql: 'SELECT queued' }]), ctx());
    const b = r.runPanel(d, panel('p2', [{ sql: 'SELECT queued' }]), ctx());
    await flush();
    // Both are still behind the single permit.
    expect(fake.calls.length).toBe(1);

    fake.resolve(0); // release the blocker
    await flush();
    fake.resolveAll();
    await Promise.all([blocker, a, b]);

    const queuedCalls = fake.calls.filter((c) => c.sql === 'SELECT queued');
    expect(queuedCalls.length).toBe(1);
  });

  it('does NOT dedupe across different databases', async () => {
    // The issue's original key omitted `database`, which becomes the
    // x-arc-database header — so two panels with identical SQL against different
    // databases would share one request and the second would render the first's
    // data. Silent wrong numbers.
    const { fake, r } = runner();
    const d = dash();
    r.runPanel(d, panel('p1', [{ sql: 'SELECT x', database: 'db_a' }]), ctx());
    r.runPanel(d, panel('p2', [{ sql: 'SELECT x', database: 'db_b' }]), ctx());
    await flush();
    expect(fake.calls.length).toBe(2);
  });

  it.each([
    ['a different org', () => ctx({ orgId: 'org-2' })],
    ['a different range', () => ctx({ from: FROM - 1 })],
  ])('does not dedupe across %s', async (_label, other) => {
    const { fake, r } = runner();
    const d = dash();
    r.runPanel(d, panel('p1', [{ sql: 'SELECT x' }]), ctx());
    r.runPanel(d, panel('p2', [{ sql: 'SELECT x' }]), other());
    await flush();
    expect(fake.calls.length).toBe(2);
  });
});

describe('AC: cancelAll aborts everything', () => {
  it('aborts in-flight work and drains the queue', async () => {
    const fake = createFakeTransport();
    const r = createQueryRunner({ transport: fake.transport, concurrency: 2 });
    const d = dash();
    const runs = Array.from({ length: 10 }, (_, i) =>
      r.runPanel(d, panel(`p${i}`, [{ sql: `SELECT ${i}` }]), ctx()),
    );
    await flush();
    r.cancelAll();
    const results = await Promise.all(runs);

    expect(results.every((x) => x.cancelled || x.status === 'idle')).toBe(true);
    // A permit handed to a waiter that returns early without releasing is how
    // the queue deadlocks with nothing running.
    expect(r.stats().active).toBe(0);
    expect(r.stats().queued).toBe(0);
  });

  it('leaves the runner usable for the next tick', async () => {
    // The deadlock this guards against reports inFlight: 5 forever and silently
    // stops every panel until reload.
    const fake = createFakeTransport();
    const r = createQueryRunner({ transport: fake.transport, concurrency: 2 });
    const d = dash();
    const first = Array.from({ length: 8 }, (_, i) =>
      r.runPanel(d, panel(`p${i}`, [{ sql: `SELECT ${i}` }]), ctx()),
    );
    await flush();
    r.cancelAll();
    await Promise.all(first);

    const before = fake.calls.length;
    const again = r.runPanel(d, panel('fresh', [{ sql: 'SELECT fresh' }]), ctx({ noCache: true } as never));
    await flush();
    fake.resolveAll();
    const result = await again;
    expect(fake.calls.length).toBeGreaterThan(before);
    expect(result.status).toBe('success');
  });
});

// ===========================================================================
// Dedupe x cancellation — the interaction, not the parts
// ===========================================================================

describe('refcounted sharing', () => {
  it('one sharer cancelling does not kill the other', async () => {
    const { fake, r } = runner();
    const d = dash();
    const a = r.runPanel(d, panel('p1', [{ sql: 'SELECT shared' }]), ctx());
    const b = r.runPanel(d, panel('p2', [{ sql: 'SELECT shared' }]), ctx());
    await flush();
    expect(fake.calls.length).toBe(1);

    r.cancelPanel('p1');
    fake.resolveAll();

    const rb = await b;
    // The survivor must still get its data.
    expect(rb.cancelled).toBe(false);
    expect(rb.status).toBe('success');
    expect(rb.targets[0].frame).toBeDefined();
    await a;
  });

  it('a re-request after a cancel does not join the dying entry', async () => {
    // If the entry is deleted asynchronously in a finally, a re-request for the
    // same key joins an ALREADY-ABORTED controller, rejects with AbortError, and
    // the panel sits in `loading` forever.
    const { fake, r } = runner();
    const d = dash();
    const p = panel('p1', [{ sql: 'SELECT retry' }]);

    const first = r.runPanel(d, p, ctx());
    await flush();
    r.cancelPanel('p1');
    await first;

    const second = r.runPanel(d, p, ctx());
    await flush();
    // A brand-new transport call, not a join onto the corpse.
    expect(fake.calls.length).toBe(2);
    fake.resolveAll();
    const result = await second;
    expect(result.status).toBe('success');
    expect(result.cancelled).toBe(false);
  });

  it('does not leak in-flight entries', async () => {
    const { fake, r } = runner();
    const d = dash();
    const runs = [
      r.runPanel(d, panel('p1', [{ sql: 'SELECT 1' }]), ctx()),
      r.runPanel(d, panel('p2', [{ sql: 'SELECT 2' }]), ctx()),
    ];
    await flush();
    expect(r.stats().inFlight).toBeGreaterThan(0);
    fake.resolveAll();
    await Promise.all(runs);
    await flush();
    expect(r.stats().inFlight).toBe(0);
    expect(r.stats().active).toBe(0);
  });
});

// ===========================================================================
// Cache
// ===========================================================================

describe('cache', () => {
  it('serves a repeat query without a second request', async () => {
    const { fake, r } = runner();
    const d = dash();
    const p = panel('p1', [{ sql: 'SELECT cached' }]);
    const first = r.runPanel(d, p, ctx());
    await flush();
    fake.resolveAll();
    await first;

    const second = await r.runPanel(d, p, ctx());
    expect(fake.calls.length).toBe(1);
    expect(second.targets[0].cached).toBe(true);
    expect(second.targets[0].frame).toBeDefined();
  });

  it('is not written by a failed request', async () => {
    // An errored or aborted read must never store a short body under a key every
    // other panel reads.
    const { fake, r } = runner();
    const d = dash();
    const p = panel('p1', [{ sql: 'SELECT boom' }]);
    const first = r.runPanel(d, p, ctx());
    await flush();
    fake.reject(0, new ArcQueryError(400, 'syntax error'));
    await first;
    expect(r.stats().cacheSize).toBe(0);

    const second = r.runPanel(d, p, ctx());
    await flush();
    expect(fake.calls.length).toBe(2);
    fake.resolveAll();
    await second;
  });

  it('is not written by a cancelled request', async () => {
    const { fake, r } = runner();
    const first = r.runPanel(dash(), panel('p1', [{ sql: 'SELECT x' }]), ctx());
    await flush();
    r.cancelPanel('p1');
    await first;
    expect(r.stats().cacheSize).toBe(0);
  });

  it('is bounded, because the key contains user-authored SQL', async () => {
    const fake = createFakeTransport(0);
    const r = createQueryRunner({ transport: fake.transport, maxCacheEntries: 3 });
    const d = dash();
    for (let i = 0; i < 10; i++) {
      await r.runPanel(d, panel(`p${i}`, [{ sql: `SELECT ${i}` }]), ctx());
    }
    expect(r.stats().cacheSize).toBeLessThanOrEqual(3);
  });

  it('expires', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeTransport(0);
      const r = createQueryRunner({ transport: fake.transport, cacheTtlMs: 1000 });
      const d = dash();
      const p = panel('p1', [{ sql: 'SELECT ttl' }]);
      await vi.advanceTimersByTimeAsync(0);
      const first = r.runPanel(d, p, ctx());
      await vi.advanceTimersByTimeAsync(1);
      await first;
      vi.advanceTimersByTime(2000);
      const second = r.runPanel(d, p, ctx());
      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(fake.calls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives each target its own frame from one shared result', async () => {
    // The cache stores the RAW result and each target normalizes its own frame,
    // because `format` and `refId` change the frame but not the rows. Caching the
    // Frame would serve panel B's target the shape and refId of panel A's.
    const { fake, r } = runner();
    const d = dash();
    const a = r.runPanel(d, panel('p1', [{ sql: 'SELECT s', format: 'time_series' }]), ctx());
    const b = r.runPanel(d, panel('p2', [{ sql: 'SELECT s', format: 'table' }]), ctx());
    await flush();
    expect(fake.calls.length).toBe(1); // still one request
    fake.resolveAll();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.targets[0].frame!.shape).not.toBe(rb.targets[0].frame!.shape);
    expect(rb.targets[0].frame!.shape).toBe('table');
  });
});

// ===========================================================================
// Panel-level behaviour
// ===========================================================================

describe('target skipping', () => {
  it('skips hidden and empty targets', async () => {
    const { fake, r } = runner();
    const result = await r.runPanel(
      dash(),
      panel('p1', [{ sql: '' }, { sql: 'SELECT ok', hide: true }]),
      ctx(),
    );
    // createPanel emits {refId:'A', sql:''} for every new panel, so without the
    // empty skip an unconfigured panel POSTs "" to Arc on every refresh tick.
    expect(fake.calls.length).toBe(0);
    expect(result.status).toBe('idle');
    expect(result.targets).toEqual([]);
  });
});

describe('multiple targets', () => {
  it('keeps the successes when one target fails', async () => {
    const { fake, r } = runner();
    const run = r.runPanel(dash(), panel('p1', [{ sql: 'SELECT a' }, { sql: 'SELECT b' }]), ctx());
    await flush();
    expect(fake.calls.length).toBe(2);
    fake.reject(0, new ArcQueryError(400, 'bad sql'));
    fake.resolve(1);
    const result = await run;
    // Partial failure is a partial success, not a dead panel.
    expect(result.status).toBe('success');
    expect(result.targets.find((t) => t.refId === 'A')!.error!.kind).toBe('query');
    expect(result.targets.find((t) => t.refId === 'B')!.frame).toBeDefined();
  });

  it('is an error only when every target failed', async () => {
    const { fake, r } = runner();
    const run = r.runPanel(dash(), panel('p1', [{ sql: 'SELECT a' }, { sql: 'SELECT b' }]), ctx());
    await flush();
    fake.reject(0, new ArcQueryError(400, 'bad a'));
    fake.reject(1, new ArcQueryError(400, 'bad b'));
    const result = await run;
    expect(result.status).toBe('error');
    expect(result.error!.kind).toBe('query');
  });

  it('retains the executed SQL for the inspector', async () => {
    const { fake, r } = runner();
    const run = r.runPanel(
      dash(),
      panel('p1', [{ sql: "SELECT $__timeGroup(time, '1m'), avg(v) WHERE $__timeFilter(time)" }]),
      ctx(),
    );
    await flush();
    fake.resolveAll();
    const result = await run;
    const sql = result.targets[0].executedSql;
    expect(sql).toContain('to_timestamp');
    expect(sql).toContain("'2026-01-01T00:00:00Z'");
    expect(sql).not.toContain('$__');
  });
});

// ===========================================================================
// Instance resolution
// ===========================================================================

describe('instance resolution', () => {
  it('uses target over panel over dashboard', async () => {
    const { fake, r } = runner();
    const d = dash({ instanceId: 'dash-inst' });
    const runs = [
      r.runPanel(d, panel('p1', [{}]), ctx()),
      r.runPanel(d, panel('p2', [{}], { instanceId: 'panel-inst' }), ctx()),
      r.runPanel(d, panel('p3', [{ instanceId: 'target-inst' }]), ctx()),
    ];
    await flush();
    const ids = fake.calls.map((c) => c.instanceId);
    expect(ids).toContain('dash-inst');
    expect(ids).toContain('panel-inst');
    expect(ids).toContain('target-inst');

    fake.resolveAll();
    await Promise.all(runs);
  });

  it('errors without querying when no instance is set', async () => {
    const { fake, r } = runner();
    const d = dash({ instanceId: null });
    const result = await r.runPanel(d, panel('p1', [{}]), ctx());
    expect(fake.calls.length).toBe(0);
    expect(result.status).toBe('error');
    expect(result.error!.kind).toBe('unresolved');
  });

  it('errors when an instance variable has no selection', async () => {
    const { fake, r } = runner();
    const d = dash({
      instanceId: '$inst',
      variables: [
        { name: 'inst', type: 'instance', label: '', hide: 'none', options: [], current: null } as never,
      ],
    });
    const result = await r.runPanel(d, panel('p1', [{}]), ctx());
    expect(fake.calls.length).toBe(0);
    expect(result.error!.kind).toBe('unresolved');
  });

  it('dereferences a declared instance variable', async () => {
    const { fake, r } = runner();
    const d = dash({
      instanceId: '$inst',
      variables: [
        { name: 'inst', type: 'instance', label: '', hide: 'none', options: [], current: null } as never,
      ],
    });
    r.runPanel(d, panel('p1', [{}]), ctx({ variables: { inst: 'chosen-inst' } }));
    await flush();
    expect(fake.calls[0].instanceId).toBe('chosen-inst');
  });
});

// ===========================================================================
// Panel time overrides
// ===========================================================================

describe('effectiveBounds', () => {
  it('passes the dashboard range through by default', () => {
    expect(effectiveBounds(panel('p', [{}]), ctx())).toEqual({ from: FROM, to: TO });
  });

  it('honours timeFrom, with or without the now- prefix', () => {
    const a = effectiveBounds(panel('p', [{}], { timeFrom: 'now-1d' }), ctx());
    const b = effectiveBounds(panel('p', [{}], { timeFrom: '1d' }), ctx());
    expect(a).toEqual({ from: TO - 86_400_000, to: TO });
    expect(a).toEqual(b);
  });

  it('shifts both bounds for timeShift', () => {
    const out = effectiveBounds(panel('p', [{}], { timeShift: '1d' }), ctx());
    expect(out).toEqual({ from: FROM - 86_400_000, to: TO - 86_400_000 });
  });

  it('ignores an unparseable override rather than querying a bogus range', () => {
    expect(effectiveBounds(panel('p', [{}], { timeFrom: 'nonsense' }), ctx())).toEqual({
      from: FROM,
      to: TO,
    });
  });

  it('keeps a shifted panel off its unshifted twin cache entry', async () => {
    // Keying on the dashboard range would collide a week-over-week panel with
    // its twin and render the same data twice.
    const { fake, r } = runner();
    const d = dash();
    r.runPanel(d, panel('p1', [{ sql: 'SELECT wow' }]), ctx());
    r.runPanel(d, panel('p2', [{ sql: 'SELECT wow' }], { timeShift: '7d' }), ctx());
    await flush();
    expect(fake.calls.length).toBe(2);
  });
});

describe('maxDataPoints', () => {
  it('changes the key, because it changes the bucket width', async () => {
    // A resize must not serve a frame bucketed at the old width.
    const { fake, r } = runner();
    const d = dash();
    const p = panel('p1', [{ sql: "SELECT $__timeGroup(time, '$__interval')" }]);
    r.runPanel(d, p, ctx(), { maxDataPoints: 100 });
    r.runPanel(d, p, ctx(), { maxDataPoints: 2000 });
    await flush();
    expect(fake.calls.length).toBe(2);
    expect(fake.calls[0].sql).not.toBe(fake.calls[1].sql);
  });

  it('does not split the key for a query with no interval macro', async () => {
    // With no macro the expansion is byte-identical, so the rows are identical
    // and sharing is correct. This is what makes keying on expandedSql sufficient.
    const { fake, r } = runner();
    const d = dash();
    const p = panel('p1', [{ sql: 'SELECT count(*) FROM t' }]);
    r.runPanel(d, p, ctx(), { maxDataPoints: 100 });
    r.runPanel(d, panel('p2', [{ sql: 'SELECT count(*) FROM t' }]), ctx(), { maxDataPoints: 2000 });
    await flush();
    expect(fake.calls.length).toBe(1);
  });
});

// ===========================================================================
// Error classification
// ===========================================================================

describe('classify', () => {
  it.each([
    [401, 'permission'],
    [403, 'permission'],
    [404, 'instance'],
    [400, 'query'],
    [422, 'query'],
    [500, 'query'],
  ])('maps status %i to %s', (status, kind) => {
    expect(classify(new ArcQueryError(status, 'body')).kind).toBe(kind);
  });

  it('surfaces the proxy message on a 502, which is the most actionable one', () => {
    // The proxy's size refusal tells the user exactly what to do. Collapsing it
    // into "network error" throws away the best message the proxy has.
    const body = JSON.stringify({
      error: 'Arc response is too large to proxy. Narrow the query or add a LIMIT.',
    });
    const out = classify(new ArcQueryError(502, body));
    expect(out.kind).toBe('proxy');
    expect(out.message).toContain('too large');
  });

  it('falls back to generic on a 502 with no proxy message', () => {
    const out = classify(new ArcQueryError(502, '<html>gateway</html>'));
    expect(out.kind).toBe('network');
    expect(out.message).not.toContain('html');
  });

  it('keeps a transport failure generic but retains the detail', () => {
    const out = classify(new TypeError('Failed to fetch'));
    expect(out.kind).toBe('network');
    expect(out.message).not.toContain('Failed to fetch');
    expect(out.detail).toContain('Failed to fetch');
  });

  it('shows Arc its own complaint about the SQL', () => {
    const out = classify(new ArcQueryError(400, 'Parser Error: syntax error at or near "SELCT"'));
    expect(out.kind).toBe('query');
    expect(out.message).toContain('SELCT');
  });

  it('does not leak the 404 distinction the proxy deliberately hides', () => {
    // "does not exist" and "belongs to another org" are one message upstream; a
    // helpful client message would rebuild the oracle the proxy closed.
    const out = classify(new ArcQueryError(404, 'Instance not found'));
    expect(out.message.toLowerCase()).not.toContain('organization');
    expect(out.message.toLowerCase()).not.toContain('another');
  });
});

describe('diagnostics', () => {
  it('reports errors to onError with panel context', async () => {
    const fake = createFakeTransport();
    const seen: Array<{ panelId: string; refId: string }> = [];
    const r = createQueryRunner({
      transport: fake.transport,
      onError: (_e, c) => seen.push(c),
    });
    const run = r.runPanel(dash(), panel('p1', [{ sql: 'SELECT x' }]), ctx());
    await flush();
    fake.reject(0, new ArcQueryError(400, 'nope'));
    await run;
    expect(seen).toEqual([{ panelId: 'p1', refId: 'A' }]);
  });

  it('does not report a cancellation as an error', async () => {
    const fake = createFakeTransport();
    const seen: unknown[] = [];
    const r = createQueryRunner({ transport: fake.transport, onError: (e) => seen.push(e) });
    const run = r.runPanel(dash(), panel('p1', [{ sql: 'SELECT x' }]), ctx());
    await flush();
    r.cancelPanel('p1');
    await run;
    expect(seen).toEqual([]);
  });
});

describe('dispose', () => {
  it('clears the per-panel state a long-lived SPA would otherwise accumulate', async () => {
    const fake = createFakeTransport(0);
    const r = createQueryRunner({ transport: fake.transport });
    const d = dash();
    for (let i = 0; i < 5; i++) {
      await r.runPanel(d, panel(`p${i}`, [{ sql: `SELECT ${i}` }]), ctx());
    }
    expect(r.stats().cacheSize).toBeGreaterThan(0);
    r.dispose();
    expect(r.stats().cacheSize).toBe(0);
    expect(r.stats().queued).toBe(0);
  });
});
