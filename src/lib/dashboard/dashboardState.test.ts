import { describe, it, expect, vi } from 'vitest';
import {
  applyResult,
  baselineOf,
  buildRunContext,
  canSave,
  isDirty,
  resolveViewPanel,
} from './dashboardState';
import {
  getViewPanel,
  initialRange,
  initialRefresh,
  isKiosk,
  mergeDashboardParams,
  setViewPanel,
  withSearch,
} from './dashboardUrl';
import { createRefreshScheduler } from './refreshScheduler';
import { createDashboard, createPanel, LIMITS, type Dashboard, type Panel } from './model';
import type { PanelResult } from './queryRunner';

const dash = (over: Partial<Dashboard> = {}): Dashboard => ({
  ...createDashboard({ title: 'D', instanceId: 'inst-1' }),
  ...over,
});
const panel = (id: string): Panel =>
  createPanel({ type: 'timeseries', gridPos: { x: 0, y: 0, w: 12, h: 8 }, id });

const res = (over: Partial<PanelResult> = {}): PanelResult => ({
  panelId: 'p1',
  status: 'success',
  targets: [],
  generation: 1,
  cancelled: false,
  ...over,
});

// ===========================================================================
// Dirty tracking
// ===========================================================================

describe('isDirty', () => {
  it('is clean immediately after loading', () => {
    // Opening a dashboard must not mark it dirty — the repo has shipped that
    // bug before, and it makes every save burn a version of history.
    const d = dash();
    expect(isDirty(d, baselineOf(d))).toBe(false);
  });

  it('notices a panel edit', () => {
    const d = dash();
    const base = baselineOf(d);
    expect(isDirty({ ...d, panels: [panel('p1')] }, base)).toBe(true);
  });

  it('notices a title change', () => {
    const d = dash();
    expect(isDirty({ ...d, title: 'Renamed' }, baselineOf(d))).toBe(true);
  });

  it('is insensitive to key order, because it compares canonical bytes', () => {
    // serializeForSave sorts keys, so a model whose properties were assigned in
    // a different order is not a change. Without that, any code path that
    // rebuilt the object would dirty the dashboard.
    const d = dash();
    const reordered = Object.fromEntries(Object.entries(d).reverse()) as unknown as Dashboard;
    expect(isDirty(reordered, baselineOf(d))).toBe(false);
  });

  it('treats an unserializable model as dirty rather than throwing', () => {
    // A reactive statement that throws takes the whole render down. Refusing to
    // let the user save would be worse than a save that fails with a real
    // message.
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 200; i++) {
      deep.next = {};
      deep = deep.next as Record<string, unknown>;
    }
    const d = dash({ panels: [{ ...panel('p1'), options: root }] });
    expect(() => isDirty(d, 'x')).not.toThrow();
    expect(isDirty(d, 'x')).toBe(true);
  });
});

// ===========================================================================
// Save gating
// ===========================================================================

describe('canSave', () => {
  it.each([
    ['viewer', 'me', 'me', false],
    ['member', 'me', 'me', true],
    ['member', 'someone-else', 'me', false],
    ['admin', 'someone-else', 'me', true],
    ['owner', 'someone-else', 'me', true],
  ] as const)('role %s, author %s, user %s -> %s', (role, createdBy, userId, expected) => {
    // Mirrors the API exactly. Gating on "not a viewer" alone offers a plain
    // member a Save button that 403s on a colleague's dashboard.
    expect(canSave(role, createdBy, userId)).toBe(expected);
  });

  it('refuses when the role is unknown', () => {
    expect(canSave(null, 'me', 'me')).toBe(false);
  });
});

// ===========================================================================
// Result application
// ===========================================================================

describe('applyResult', () => {
  const current = () => true;

  it('stores a fresh result', () => {
    expect(applyResult({}, res(), current).p1).toBeDefined();
  });

  it('DROPS a cancelled result', () => {
    // The runner reports a superseded run as status 'idle', so storing it would
    // paint "this panel has no query" over a working chart.
    const existing = { p1: res({ generation: 1 }) };
    const out = applyResult(existing, res({ cancelled: true, status: 'idle', generation: 2 }), current);
    expect(out).toBe(existing);
    expect(out.p1.status).toBe('success');
  });

  it('DROPS a stale result even when it is not cancelled', () => {
    const existing = { p1: res({ generation: 5 }) };
    const out = applyResult(existing, res({ generation: 2 }), (_id, g) => g === 5);
    expect(out).toBe(existing);
  });

  it('needs BOTH guards: a cancelled run can still be the current generation', () => {
    // isCurrent alone does not catch a cancelled run whose panel was not re-run.
    const out = applyResult({}, res({ cancelled: true, generation: 1 }), () => true);
    expect(out.p1).toBeUndefined();
  });

  it('returns a NEW object when it stores, so Svelte re-renders', () => {
    const before = {};
    expect(applyResult(before, res(), current)).not.toBe(before);
  });
});

// ===========================================================================
// Run context
// ===========================================================================

describe('buildRunContext', () => {
  it('carries the resolved instants', () => {
    const ctx = buildRunContext({ orgId: 'o', from: 1, to: 2, timezone: 'UTC' });
    expect(ctx).toMatchObject({ orgId: 'o', from: 1, to: 2, timezone: 'UTC' });
  });

  it('is reusable, so a panel-scoped re-run does not re-resolve', () => {
    // Re-resolving moves `now`, which moves that panel's cache key away from
    // every other panel's and makes dedupe inert for it.
    const ctx = buildRunContext({ orgId: 'o', from: 100, to: 200, timezone: 'UTC' });
    expect(ctx.from).toBe(100);
    expect(ctx.to).toBe(200);
  });
});

describe('resolveViewPanel', () => {
  it('finds the panel', () => {
    expect(resolveViewPanel([panel('p1')], 'p1')?.id).toBe('p1');
  });

  it('falls back for a stale link naming a deleted panel', () => {
    expect(resolveViewPanel([panel('p1')], 'gone')).toBeNull();
  });

  it('is null when no panel is requested', () => {
    expect(resolveViewPanel([panel('p1')], null)).toBeNull();
  });
});

// ===========================================================================
// URL
// ===========================================================================

describe('mergeDashboardParams', () => {
  const base = () => new URLSearchParams('from=now-6h&to=now&refresh=30s&other=keep');

  it('preserves parameters it was not asked about', () => {
    // Five parameters share this string; a writer that rebuilds it deletes the
    // others — which is how a fullscreen toggle silently resets the time range.
    const out = new URLSearchParams(mergeDashboardParams(base(), { viewPanel: 'p1' }));
    expect(out.get('from')).toBe('now-6h');
    expect(out.get('refresh')).toBe('30s');
    expect(out.get('other')).toBe('keep');
    expect(out.get('viewPanel')).toBe('p1');
  });

  it('removes on null and leaves alone on undefined', () => {
    const out = new URLSearchParams(mergeDashboardParams(base(), { refresh: null }));
    expect(out.has('refresh')).toBe(false);
    expect(out.get('from')).toBe('now-6h');
  });

  it('treats an empty string as a removal', () => {
    // Refresh "off" is the empty string in the model; it should not appear in
    // the URL as `refresh=`.
    expect(new URLSearchParams(mergeDashboardParams(base(), { refresh: '' })).has('refresh')).toBe(
      false,
    );
  });

  it('writes kiosk as a flag', () => {
    expect(new URLSearchParams(mergeDashboardParams(base(), { kiosk: true })).get('kiosk')).toBe('1');
    expect(new URLSearchParams(mergeDashboardParams(base(), { kiosk: false })).has('kiosk')).toBe(
      false,
    );
  });
});

describe('withSearch', () => {
  it('omits the question mark when there is nothing to say', () => {
    expect(withSearch('/d/abc', '')).toBe('/d/abc');
    expect(withSearch('/d/abc', 'a=1')).toBe('/d/abc?a=1');
  });
});

describe('initial state', () => {
  it('lets the URL win over the saved default', () => {
    const out = initialRange(new URLSearchParams('from=now-1h&to=now'), {
      from: 'now-6h',
      to: 'now',
    });
    expect(out.from).toBe('now-1h');
  });

  it('falls back to the dashboard default when the URL is silent', () => {
    const out = initialRange(new URLSearchParams(''), { from: 'now-6h', to: 'now' });
    expect(out).toEqual({ from: 'now-6h', to: 'now' });
  });

  it('distinguishes "refresh off in the URL" from "URL says nothing"', () => {
    // `?refresh=` is an explicit off; an absent parameter means use the saved
    // default. Collapsing them makes a shared "refresh off" link turn refresh
    // back on for the recipient.
    expect(initialRefresh(new URLSearchParams('refresh='), '30s')).toBe('');
    expect(initialRefresh(new URLSearchParams(''), '30s')).toBe('30s');
  });
});

describe('viewPanel and kiosk', () => {
  it('round-trips the panel id', () => {
    const search = new URLSearchParams(setViewPanel(new URLSearchParams('from=now-6h'), 'p1'));
    expect(getViewPanel(search)).toBe('p1');
    expect(search.get('from')).toBe('now-6h');
  });

  it('clears on null', () => {
    const search = new URLSearchParams(setViewPanel(new URLSearchParams('viewPanel=p1'), null));
    expect(getViewPanel(search)).toBeNull();
  });

  it.each([
    ['kiosk', true],
    ['kiosk=1', true],
    ['kiosk=false', false],
    ['', false],
  ])('reads %p as %s', (query, expected) => {
    expect(isKiosk(new URLSearchParams(query))).toBe(expected);
  });
});

// ===========================================================================
// Refresh scheduler
// ===========================================================================

describe('createRefreshScheduler', () => {
  const harness = (over: { hidden?: () => boolean } = {}) => {
    let fn: (() => void) | null = null;
    let ticks = 0;
    const s = createRefreshScheduler({
      onTick: () => ticks++,
      isHidden: over.hidden ?? (() => false),
      setTimer: (f) => {
        fn = f;
        return 1;
      },
      clearTimer: () => {
        fn = null;
      },
    });
    return { s, fire: () => fn?.(), get ticks() { return ticks; }, get armed() { return fn !== null; } };
  };

  it('ticks on the interval', () => {
    const h = harness();
    h.s.set('30s');
    h.fire();
    h.fire();
    expect(h.ticks).toBe(2);
  });

  it('is off for an empty interval', () => {
    const h = harness();
    h.s.set('');
    expect(h.armed).toBe(false);
    expect(h.s.intervalMs).toBe(0);
  });

  it('CLAMPS below the floor rather than rejecting', () => {
    // A shared dashboard at 0ms would make every viewer's browser poll the
    // proxy as fast as it can — and the proxy attaches the admin token. An
    // imported dashboard must still open, so this clamps.
    const h = harness();
    h.s.set('100ms');
    expect(h.s.intervalMs).toBe(LIMITS.minRefreshMs);
  });

  it('does not query while the tab is hidden', () => {
    let hidden = true;
    const h = harness({ hidden: () => hidden });
    h.s.set('30s');
    h.fire();
    expect(h.ticks).toBe(0);
    hidden = false;
  });

  it('catches up immediately when the tab comes back', () => {
    // A wall display that was backgrounded should show current data at once,
    // not after a full interval of staleness.
    let hidden = true;
    const h = harness({ hidden: () => hidden });
    h.s.set('30s');
    h.fire();
    hidden = false;
    h.s.resume();
    expect(h.ticks).toBe(1);
  });

  it('does not catch up when nothing was missed', () => {
    const h = harness();
    h.s.set('30s');
    h.s.resume();
    expect(h.ticks).toBe(0);
  });

  it('pauses and stops cleanly', () => {
    const h = harness();
    h.s.set('30s');
    h.s.pause();
    expect(h.armed).toBe(false);
    h.s.stop();
    expect(h.armed).toBe(false);
  });

  it('replaces the timer rather than stacking them', () => {
    const h = harness();
    h.s.set('30s');
    h.s.set('60s');
    h.fire();
    expect(h.ticks).toBe(1);
  });

  it('ignores an unparseable interval', () => {
    const h = harness();
    h.s.set('nonsense');
    expect(h.armed).toBe(false);
  });
});
