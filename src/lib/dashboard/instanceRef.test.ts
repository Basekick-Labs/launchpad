import { describe, it, expect } from 'vitest';
import { resolveInstanceRef } from './instanceRef';
import { durationToMs, durationToMsLoose } from './duration';
import { createDashboard, createPanel, type Dashboard, type Panel, type Target } from './model';

const dash = (over: Partial<Dashboard> = {}): Dashboard => ({
  ...createDashboard({ title: 'D', instanceId: 'dash-inst' }),
  ...over,
});
const pnl = (over: Partial<Panel> = {}): Panel => ({
  ...createPanel({ type: 'timeseries', gridPos: { x: 0, y: 0, w: 4, h: 4 } }),
  ...over,
});
const tgt = (over: Partial<Target> = {}): Target => ({ refId: 'A', sql: 'SELECT 1', ...over });

const instanceVar = (name: string) =>
  ({ name, type: 'instance', label: '', hide: 'none', options: [], current: null }) as never;

describe('resolveInstanceRef', () => {
  it('prefers the target over the panel over the dashboard', () => {
    expect(
      resolveInstanceRef(dash(), pnl({ instanceId: 'p' }), tgt({ instanceId: 't' })),
    ).toEqual({ ok: true, id: 't', path: 'target.instanceId' });
    expect(resolveInstanceRef(dash(), pnl({ instanceId: 'p' }), tgt())).toEqual({
      ok: true,
      id: 'p',
      path: 'panel.instanceId',
    });
    expect(resolveInstanceRef(dash(), pnl(), tgt())).toEqual({
      ok: true,
      id: 'dash-inst',
      path: 'instanceId',
    });
  });

  it('falls through an empty override rather than treating it as a choice', () => {
    expect(resolveInstanceRef(dash(), pnl({ instanceId: '' }), tgt({ instanceId: '' }))).toEqual({
      ok: true,
      id: 'dash-inst',
      path: 'instanceId',
    });
  });

  it('reports an unset instance instead of guessing', () => {
    // Saving a dashboard with no instance is legal; executing a query against
    // one is not. This is where that distinction lands.
    const out = resolveInstanceRef(dash({ instanceId: null }), pnl(), tgt());
    expect(out).toEqual({ ok: false, path: 'instanceId', reason: 'unset' });
  });

  it('dereferences a declared instance variable', () => {
    const d = dash({ instanceId: '$inst', variables: [instanceVar('inst')] });
    expect(resolveInstanceRef(d, pnl(), tgt(), { inst: 'chosen' })).toEqual({
      ok: true,
      id: 'chosen',
      path: 'instanceId',
    });
  });

  it('rejects a reference to a variable that is not declared', () => {
    const d = dash({ instanceId: '$nope' });
    expect(resolveInstanceRef(d, pnl(), tgt(), { nope: 'sneaky' })).toEqual({
      ok: false,
      path: 'instanceId',
      reason: 'undeclared_variable',
    });
  });

  it('rejects a reference to a variable of the wrong type', () => {
    // A `query` variable named `inst` must not satisfy an instance reference.
    const d = dash({
      instanceId: '$inst',
      variables: [{ name: 'inst', type: 'query', label: '', hide: 'none' } as never],
    });
    expect(resolveInstanceRef(d, pnl(), tgt(), { inst: 'x' }).ok).toBe(false);
  });

  it('rejects a declared variable with nothing selected', () => {
    const d = dash({ instanceId: '$inst', variables: [instanceVar('inst')] });
    expect(resolveInstanceRef(d, pnl(), tgt(), {})).toEqual({
      ok: false,
      path: 'instanceId',
      reason: 'unselected_variable',
    });
  });

  it('reports the path that supplied the id, for audit', () => {
    const d = dash({ variables: [instanceVar('inst')] });
    expect(resolveInstanceRef(d, pnl(), tgt({ instanceId: '$inst' }), {}).path).toBe(
      'target.instanceId',
    );
  });
});

describe('durationToMs', () => {
  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['5m', 300_000],
    ['2h', 7_200_000],
    ['1d', 86_400_000],
    ['1w', 604_800_000],
  ])('parses %s', (v, ms) => {
    expect(durationToMs(v)).toBe(ms);
  });

  it.each([['1M'], ['1y'], ['nonsense'], [''], ['-5m'], ['5 m'], ['1.5h']])('rejects %p', (v) => {
    // `M` is month in Grafana and minute in DuckDB — 43,200x apart. Refusing
    // beats guessing.
    expect(durationToMs(v)).toBeNull();
  });
});

describe('durationToMsLoose', () => {
  it('tolerates the now- prefix that Panel.timeFrom carries', () => {
    expect(durationToMsLoose('now-7d')).toBe(7 * 86_400_000);
    expect(durationToMsLoose('7d')).toBe(7 * 86_400_000);
    expect(durationToMsLoose('  now-1h  ')).toBe(3_600_000);
  });

  it('still rejects what the strict parser rejects', () => {
    expect(durationToMsLoose('now-1M')).toBeNull();
    expect(durationToMsLoose('now/d')).toBeNull();
  });
});
