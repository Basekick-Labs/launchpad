import { describe, it, expect } from 'vitest';
import {
  csvFilename,
  duplicatePanel,
  errorToShow,
  failedTargets,
  inspectorRows,
  panelNotices,
  panelView,
  timeOverrideLabel,
} from './panelState';
import { normalizeFrame } from './frame';
import { createPanel, type Panel } from './model';
import type { PanelResult, TargetResult } from './queryRunner';

const frame = (rows: unknown[][], columns = ['time', 'v']) =>
  normalizeFrame({ columns, rows });

const target = (over: Partial<TargetResult> = {}): TargetResult => ({
  refId: 'A',
  executedSql: 'SELECT 1',
  cached: false,
  durationMs: 5,
  ...over,
});

const result = (over: Partial<PanelResult> = {}): PanelResult => ({
  panelId: 'p1',
  status: 'success',
  targets: [target({ frame: frame([['2026-01-01T00:00:00Z', 1]]) })],
  generation: 1,
  cancelled: false,
  ...over,
});

const panel = (over: Partial<Panel> = {}): Panel => ({
  ...createPanel({ type: 'timeseries', gridPos: { x: 0, y: 0, w: 12, h: 8 }, id: 'p1' }),
  ...over,
});

// ===========================================================================
// panelView
// ===========================================================================

describe('panelView', () => {
  it('shows a spinner in the body only on the FIRST load', () => {
    // A refresh must not blank a chart that already has data — that is the most
    // irritating thing a dashboard can do.
    expect(panelView(null, true)).toEqual({ body: 'pending', busy: true });
    expect(panelView(result(), true)).toEqual({ body: 'content', busy: true });
  });

  it('keeps the previous content for a CANCELLED run', () => {
    // The runner reports a superseded run as status 'idle' — which happens on
    // every range change and every overtaking refresh tick. Reading that as a
    // result paints "this panel has no query" over a working chart.
    expect(panelView(result({ cancelled: true, status: 'idle' }), false).body).toBe('content');
  });

  it('is idle for a panel with no query', () => {
    expect(panelView(result({ status: 'idle', targets: [] }), false).body).toBe('idle');
  });

  it('is empty when the query returned zero rows', () => {
    expect(panelView(result({ targets: [target({ frame: frame([]) })] }), false).body).toBe('empty');
  });

  it('is an error when the panel failed', () => {
    const failed = result({
      status: 'error',
      targets: [target({ error: { kind: 'query', message: 'bad sql' } })],
      error: { kind: 'query', message: 'bad sql' },
    });
    expect(panelView(failed, false).body).toBe('error');
  });

  it('treats an unselected instance as configuration, not failure', () => {
    // A freshly imported dashboard whose instance is not chosen yet would
    // otherwise show a red badge on every single panel.
    const unresolved = result({
      status: 'error',
      targets: [target({ error: { kind: 'unresolved', message: 'pick an instance' } })],
      error: { kind: 'unresolved', message: 'pick an instance' },
    });
    expect(panelView(unresolved, false).body).toBe('idle');
  });

  it('reports busy independently of what is painted', () => {
    expect(panelView(result(), true).busy).toBe(true);
    expect(panelView(result(), false).busy).toBe(false);
  });
});

// ===========================================================================
// Partial failure
// ===========================================================================

describe('failedTargets', () => {
  it('finds a failed target inside a SUCCESSFUL panel', () => {
    // The runner calls a panel successful when any target succeeded, so a red
    // target is otherwise invisible — one series silently missing from a chart
    // that looks entirely healthy.
    const mixed = result({
      status: 'success',
      targets: [
        target({ refId: 'A', frame: frame([['2026-01-01T00:00:00Z', 1]]) }),
        target({ refId: 'B', error: { kind: 'query', message: 'boom' } }),
      ],
    });
    expect(failedTargets(mixed).map((t) => t.refId)).toEqual(['B']);
    expect(errorToShow(mixed)!.message).toBe('boom');
  });

  it('is empty for a healthy panel', () => {
    expect(failedTargets(result())).toEqual([]);
    expect(errorToShow(result())).toBeUndefined();
  });

  it('handles no result at all', () => {
    expect(failedTargets(null)).toEqual([]);
  });
});

// ===========================================================================
// Notices
// ===========================================================================

describe('panelNotices', () => {
  it('surfaces a truncation notice', () => {
    // The panel rendered, but the data is incomplete. A dashboard that quietly
    // draws capped data tells a confident lie.
    const capped = normalizeFrame({
      columns: ['time', 'v'],
      rows: [['2026-01-01T00:00:00Z', 1]],
      rowsCapped: true,
    });
    const out = panelNotices(result({ targets: [target({ frame: capped })] }));
    expect(out.some((n) => n.code === 'truncated')).toBe(true);
  });

  it('deduplicates the same notice across targets', () => {
    const capped = normalizeFrame({
      columns: ['time', 'v'],
      rows: [['2026-01-01T00:00:00Z', 1]],
      rowsCapped: true,
    });
    const out = panelNotices(
      result({
        targets: [target({ refId: 'A', frame: capped }), target({ refId: 'B', frame: capped })],
      }),
    );
    expect(out.filter((n) => n.code === 'truncated')).toHaveLength(1);
  });

  it('is empty for a clean frame', () => {
    expect(panelNotices(result())).toEqual([]);
  });
});

// ===========================================================================
// Time override badge
// ===========================================================================

describe('timeOverrideLabel', () => {
  it('reads a timeFrom override', () => {
    expect(timeOverrideLabel(panel({ timeFrom: 'now-7d' }))).toBe('last 7d');
  });

  it('reads a timeShift override', () => {
    expect(timeOverrideLabel(panel({ timeShift: '1d' }))).toBe('1d earlier');
  });

  it('reads both', () => {
    expect(timeOverrideLabel(panel({ timeFrom: 'now-7d', timeShift: '1d' }))).toBe(
      'last 7d, 1d earlier',
    );
  });

  it('is null when the panel follows the dashboard', () => {
    expect(timeOverrideLabel(panel())).toBeNull();
  });

  it('honours hideTimeOverride', () => {
    // The field exists to suppress this badge, which only makes sense if the
    // badge is otherwise rendered.
    expect(timeOverrideLabel(panel({ timeFrom: 'now-7d', hideTimeOverride: true }))).toBeNull();
  });
});

// ===========================================================================
// Inspector rows
// ===========================================================================

describe('inspectorRows', () => {
  it('prefers the SOURCE cells over the normalized values', () => {
    // A time field's values are a Float64Array of epoch milliseconds, so
    // exporting them hands back 1757865600000 where the query returned a
    // nanosecond ISO timestamp. The inspector is what users open when they
    // suspect the data is wrong — the worst place to show a lossy copy.
    const f = frame([['2026-01-01T00:00:00.123456789Z', 1]]);
    const out = inspectorRows(target({ frame: f }));
    expect(String(out.rows[0][0])).toContain('2026-01-01');
    expect(String(out.rows[0][0])).not.toBe('1767225600123');
  });

  it('falls back to values when there is no raw cell', () => {
    const out = inspectorRows(target({ frame: frame([['2026-01-01T00:00:00Z', 42]]) }));
    expect(out.rows[0][1]).toBe(42);
  });

  it('returns the column names', () => {
    const out = inspectorRows(target({ frame: frame([['2026-01-01T00:00:00Z', 1]]) }));
    expect(out.columns).toEqual(['time', 'v']);
  });

  it('is empty for a target that never executed', () => {
    expect(inspectorRows(target({ frame: undefined }))).toEqual({ columns: [], rows: [] });
  });
});

// ===========================================================================
// Filenames
// ===========================================================================

describe('csvFilename', () => {
  const at = new Date('2026-01-02T03:04:05Z');

  it('slugs the title', () => {
    expect(csvFilename('CPU Usage', 'A', at)).toBe('cpu-usage-A-2026-01-02-03-04-05.csv');
  });

  it.each([
    ['a/b\\c', 'a-b-c'],
    ['weird:*?"<>|name', 'weird-name'],
    ['  spaced   out  ', 'spaced-out'],
  ])('strips path and control characters from %p', (title, slug) => {
    // The title is up to 200 characters of user input heading for
    // `link.download`.
    expect(csvFilename(title, 'A', at).startsWith(slug)).toBe(true);
  });

  it('falls back when the title slugs to nothing', () => {
    expect(csvFilename('///', 'A', at).startsWith('panel-')).toBe(true);
    expect(csvFilename('', 'A', at).startsWith('panel-')).toBe(true);
  });

  it('caps the length', () => {
    expect(csvFilename('x'.repeat(200), 'A', at).length).toBeLessThan(100);
  });
});

// ===========================================================================
// Duplicate
// ===========================================================================

describe('duplicatePanel', () => {
  it('deep copies, so editing the copy does not edit the original', () => {
    // A shallow spread shares `targets`, `fieldConfig` and `options`. That bug
    // is invisible until someone changes the duplicate's query and watches the
    // original change too.
    const panels = [panel()];
    const copy = duplicatePanel(panels, 'p1')!;
    expect(copy.targets).not.toBe(panels[0].targets);
    expect(copy.fieldConfig).not.toBe(panels[0].fieldConfig);
    copy.targets[0].sql = 'SELECT changed';
    expect(panels[0].targets[0].sql).not.toBe('SELECT changed');
  });

  it('gets a fresh id', () => {
    const copy = duplicatePanel([panel()], 'p1')!;
    expect(copy.id).not.toBe('p1');
  });

  it('is placed somewhere free', () => {
    const panels = [panel()];
    const copy = duplicatePanel(panels, 'p1')!;
    const a = panels[0].gridPos;
    const b = copy.gridPos;
    const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    expect(overlap).toBe(false);
  });

  it('returns null for an unknown panel', () => {
    expect(duplicatePanel([panel()], 'nope')).toBeNull();
  });
});
