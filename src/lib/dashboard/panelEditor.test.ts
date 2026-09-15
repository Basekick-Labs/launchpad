import { describe, it, expect } from 'vitest';
import {
  addTarget,
  applyEdit,
  beginEdit,
  canAddTarget,
  completionHints,
  draftRunId,
  duplicateTarget,
  editEffect,
  nextRefId,
  removeTarget,
  sqlByteLength,
  sqlWithinLimit,
  supportsPerValueColor,
  switchPanelType,
  visualisationChoices,
} from './panelEditor';
import { createDashboard, createPanel, LIMITS, REF_ID_PATTERN, type Dashboard, type Panel } from './model';
import { panelRequestKeys, type RunContext } from './queryRunner';

const ctx: RunContext = {
  orgId: 'org-1',
  from: Date.UTC(2026, 0, 1),
  to: Date.UTC(2026, 0, 1, 6),
  timezone: 'UTC',
};

const dash = (over: Partial<Dashboard> = {}): Dashboard => ({
  ...createDashboard({ title: 'D', instanceId: 'inst-1' }),
  ...over,
});

const panel = (over: Partial<Panel> = {}): Panel => ({
  ...createPanel({ type: 'timeseries', gridPos: { x: 0, y: 0, w: 12, h: 8 }, id: 'p1' }),
  targets: [{ refId: 'A', sql: 'SELECT time, v FROM m' }],
  ...over,
});

// ===========================================================================
// Draft lifecycle
// ===========================================================================

describe('beginEdit', () => {
  it('deep copies, so an edit cannot reach the original', () => {
    // Discard then works by dropping the draft — exact by construction rather
    // than by restoring a snapshot correctly.
    const original = panel();
    const draft = beginEdit(original);
    draft.targets[0].sql = 'SELECT changed';
    draft.fieldConfig.defaults.unit = 'bytes';
    expect(original.targets[0].sql).toBe('SELECT time, v FROM m');
    expect(original.fieldConfig.defaults.unit).toBeUndefined();
    expect(draft.targets).not.toBe(original.targets);
  });
});

describe('applyEdit', () => {
  it('replaces in place, preserving array order', () => {
    // Array order is part of the serialized bytes, so appending would produce a
    // large spurious diff and defeat the no-op-save check.
    const panels = [panel({ id: 'a' }), panel({ id: 'p1' }), panel({ id: 'z' })];
    const out = applyEdit(panels, { ...panel({ id: 'p1' }), title: 'Edited' });
    expect(out.map((p) => p.id)).toEqual(['a', 'p1', 'z']);
    expect(out[1].title).toBe('Edited');
  });

  it('leaves the array alone when the id is not present', () => {
    const panels = [panel({ id: 'a' })];
    expect(applyEdit(panels, panel({ id: 'gone' }))).toEqual(panels);
  });
});

describe('draftRunId', () => {
  it('is distinct from the panel id', () => {
    // The runner keys generations and panelControllers on the panel id, and its
    // cancelPanel would abort the preview's query every refresh tick.
    expect(draftRunId('p1')).not.toBe('p1');
  });

  it('does not change the request key, so the cache is still shared', () => {
    const d = dash();
    const real = panelRequestKeys(d, panel(), ctx);
    const draft = panelRequestKeys(d, { ...panel(), id: draftRunId('p1') }, ctx);
    expect(draft).toEqual(real);
  });
});

// ===========================================================================
// What an edit requires — the acceptance criterion
// ===========================================================================

describe('editEffect', () => {
  const d = dash();
  const base = panel({ targets: [{ refId: 'A', sql: "SELECT $__timeGroup(time, '$__interval'), avg(v) FROM m" }] });

  it('needs no query for a display-only change', () => {
    // "Editing options re-renders without issuing a query."
    const after = { ...base, fieldConfig: { defaults: { unit: 'bytes', decimals: 2 } } };
    expect(editEffect(d, base, after, ctx)).toBe('redraw');
  });

  it.each([
    ['the SQL', (p: Panel) => ({ ...p, targets: [{ ...p.targets[0], sql: 'SELECT 1' }] })],
    ['the database', (p: Panel) => ({ ...p, targets: [{ ...p.targets[0], database: 'other' }] })],
    ['the instance', (p: Panel) => ({ ...p, instanceId: 'inst-2' })],
    ['hiding a target', (p: Panel) => ({ ...p, targets: [{ ...p.targets[0], hide: true }] })],
  ])('refetches when %s changes', (_label, mutate) => {
    expect(editEffect(d, base, mutate(base), ctx)).toBe('refetch');
  });

  it.each([
    ['min interval', (p: Panel) => ({ ...p, interval: '5m' })],
    ['max data points', (p: Panel) => ({ ...p, maxDataPoints: 50 })],
    ['a relative time override', (p: Panel) => ({ ...p, timeFrom: 'now-7d' })],
    ['a time shift', (p: Panel) => ({ ...p, timeShift: '1d' })],
  ])('refetches when %s changes, because it moves the expanded SQL', (_label, mutate) => {
    // Keying on target.sql alone misses all four: the preview would never
    // change and then the SAVED panel would, so the preview lied about the
    // panel it was previewing.
    expect(editEffect(d, base, mutate(base), ctx)).toBe('refetch');
  });

  it('only renormalizes when the format changes', () => {
    // format is deliberately outside the request key — the cache stores raw rows
    // and each target normalizes its own frame — so this needs a re-run the
    // cache answers, not a network request.
    const after = { ...base, targets: [{ ...base.targets[0], format: 'table' as const }] };
    expect(editEffect(d, base, after, ctx)).toBe('renormalize');
  });

  it('refetches when a target is added or removed', () => {
    expect(editEffect(d, base, addTarget({ ...base, targets: [{ refId: 'A', sql: 'SELECT 1' }] }), ctx)).toBe(
      'refetch',
    );
  });

  it('does not refetch for a query with no interval macro when the interval changes', () => {
    // With no macro the expansion is byte-identical, so the rows are identical —
    // which is what makes keying on the expanded SQL correct rather than
    // conservative.
    const plain = panel({ targets: [{ refId: 'A', sql: 'SELECT count(*) FROM m' }] });
    expect(editEffect(d, plain, { ...plain, interval: '5m' }, ctx)).toBe('redraw');
  });

  it('refetches when the dashboard range moves', () => {
    const later = { ...ctx, from: ctx.from + 1000, to: ctx.to + 1000 };
    const a = panelRequestKeys(d, base, ctx);
    const b = panelRequestKeys(d, base, later);
    expect(a).not.toEqual(b);
  });
});

// ===========================================================================
// Targets
// ===========================================================================

describe('targets', () => {
  it('assigns sequential refIds', () => {
    let p = panel({ targets: [{ refId: 'A', sql: '' }] });
    p = addTarget(p);
    p = addTarget(p);
    expect(p.targets.map((t) => t.refId)).toEqual(['A', 'B', 'C']);
  });

  it('never reuses a refId, because a duplicate is silently DROPPED on save', () => {
    // normalizePanel drops the duplicate with a warning and the page adopts the
    // server's model, so the user's second query would just vanish after saving.
    const p = panel({ targets: [{ refId: 'A', sql: '' }, { refId: 'C', sql: '' }] });
    expect(nextRefId(p.targets)).toBe('B');
    const next = addTarget(p);
    expect(new Set(next.targets.map((t) => t.refId)).size).toBe(3);
  });

  it('keeps every generated refId valid for the schema', () => {
    let targets: Panel['targets'] = [];
    for (let i = 0; i < 30; i++) targets = [...targets, { refId: nextRefId(targets), sql: '' }];
    for (const t of targets) expect(REF_ID_PATTERN.test(t.refId)).toBe(true);
    expect(new Set(targets.map((t) => t.refId)).size).toBe(30);
  });

  it('stops at the limit rather than letting a save fail', () => {
    let p = panel({ targets: [{ refId: 'A', sql: '' }] });
    for (let i = 0; i < LIMITS.maxTargetsPerPanel + 5; i++) p = addTarget(p);
    expect(p.targets).toHaveLength(LIMITS.maxTargetsPerPanel);
    expect(canAddTarget(p)).toBe(false);
  });

  it('refuses to remove the last target', () => {
    // The editor would otherwise have nothing to type into.
    const p = panel({ targets: [{ refId: 'A', sql: 'SELECT 1' }] });
    expect(removeTarget(p, 'A').targets).toHaveLength(1);
  });

  it('removes a target when there is more than one', () => {
    const p = panel({ targets: [{ refId: 'A', sql: '' }, { refId: 'B', sql: '' }] });
    expect(removeTarget(p, 'A').targets.map((t) => t.refId)).toEqual(['B']);
  });

  it('duplicates deeply with a fresh refId', () => {
    const p = panel({ targets: [{ refId: 'A', sql: 'SELECT 1', database: 'db' }] });
    const out = duplicateTarget(p, 'A');
    expect(out.targets).toHaveLength(2);
    expect(out.targets[1].refId).toBe('B');
    expect(out.targets[1].sql).toBe('SELECT 1');
    out.targets[1].sql = 'changed';
    expect(out.targets[0].sql).toBe('SELECT 1');
  });
});

// ===========================================================================
// Visualisation switching
// ===========================================================================

describe('switchPanelType', () => {
  const withEverything = () =>
    panel({
      title: 'Kept',
      description: 'Kept too',
      interval: '1m',
      maxDataPoints: 500,
      timeFrom: 'now-7d',
      timeShift: '1d',
      transparent: true,
      hideTimeOverride: true,
      instanceId: 'inst-9',
      options: { legendPlacement: 'right' },
      fieldConfig: {
        defaults: {
          unit: 'bytes',
          decimals: 2,
          min: 0,
          max: 100,
          displayName: 'Nice name',
          custom: { drawStyle: 'bars' },
        },
      },
    });

  it('keeps the type-neutral field config', () => {
    const out = switchPanelType(withEverything(), 'stat');
    expect(out.fieldConfig.defaults).toMatchObject({
      unit: 'bytes',
      decimals: 2,
      min: 0,
      max: 100,
      displayName: 'Nice name',
    });
  });

  it('resets the type-specific bags', () => {
    // `drawStyle` is a timeseries word, and a stale key would SHADOW the new
    // type's default rather than being ignored.
    const out = switchPanelType(withEverything(), 'stat');
    expect(out.fieldConfig.defaults.custom).toBeUndefined();
    expect(out.options).toEqual({});
  });

  it.each([
    'title', 'description', 'interval', 'maxDataPoints', 'timeFrom', 'timeShift',
    'transparent', 'hideTimeOverride', 'instanceId', 'id',
  ])('preserves %s', (key) => {
    const before = withEverything();
    const after = switchPanelType(before, 'stat');
    expect(after[key as keyof Panel]).toEqual(before[key as keyof Panel]);
  });

  it('preserves the targets and the layout', () => {
    const before = withEverything();
    const after = switchPanelType(before, 'stat');
    expect(after.targets).toEqual(before.targets);
    expect(after.gridPos).toEqual(before.gridPos);
  });

  it('drops a per-value colour mode when the new type cannot show it', () => {
    // A stat panel's natural mode is thresholds; a time series REFUSES it, so
    // carrying it across would make the switch show only a warning banner —
    // which reads as a bug.
    const stat = panel({
      type: 'stat',
      fieldConfig: { defaults: { color: { mode: 'thresholds' } } },
    });
    expect(switchPanelType(stat, 'timeseries').fieldConfig.defaults.color).toBeUndefined();
  });

  it('keeps a per-value colour mode between types that both support it', () => {
    const stat = panel({
      type: 'stat',
      fieldConfig: { defaults: { color: { mode: 'thresholds' } } },
    });
    expect(switchPanelType(stat, 'bargauge').fieldConfig.defaults.color).toEqual({
      mode: 'thresholds',
    });
  });

  it('keeps a series colour mode anywhere', () => {
    const p = panel({ fieldConfig: { defaults: { color: { mode: 'palette-classic' } } } });
    expect(switchPanelType(p, 'stat').fieldConfig.defaults.color).toEqual({
      mode: 'palette-classic',
    });
  });

  it('is a no-op for the same type', () => {
    const p = withEverything();
    expect(switchPanelType(p, 'timeseries')).toBe(p);
  });
});

describe('supportsPerValueColor', () => {
  it.each([
    ['stat', true],
    ['table', true],
    ['bargauge', true],
    ['timeseries', false],
    ['barchart', false],
    ['heatmap', false],
    ['logs', false],
  ] as const)('%s -> %s', (type, expected) => {
    expect(supportsPerValueColor(type)).toBe(expected);
  });
});

describe('visualisationChoices', () => {
  it('lists every type and marks the ones that cannot draw yet', () => {
    // Six of seven have no renderer; silently switching into a blank panel would
    // lose the user's custom bag with no explanation.
    const choices = visualisationChoices();
    expect(choices).toHaveLength(7);
    expect(choices.find((c) => c.type === 'timeseries')!.available).toBe(true);
    expect(choices.filter((c) => !c.available).length).toBe(6);
  });
});

// ===========================================================================
// SQL limits
// ===========================================================================

describe('sqlByteLength', () => {
  it('counts UTF-8 BYTES, not characters', () => {
    // boundedSql caps bytes, so a query full of non-ASCII passes a .length check
    // and fails on save with a field-path error after the panel is built.
    expect(sqlByteLength('abc')).toBe(3);
    expect(sqlByteLength('é')).toBe(2);
    expect(sqlByteLength('中')).toBe(3);
    expect(sqlByteLength('😀')).toBe(4);
  });

  it('agrees with the validator at the boundary', () => {
    expect(sqlWithinLimit('x'.repeat(LIMITS.maxSqlBytes))).toBe(true);
    expect(sqlWithinLimit('x'.repeat(LIMITS.maxSqlBytes + 1))).toBe(false);
    // Half as many multi-byte characters is the same number of bytes.
    expect(sqlWithinLimit('中'.repeat(LIMITS.maxSqlBytes / 3 + 1))).toBe(false);
  });
});

// ===========================================================================
// Completion
// ===========================================================================

describe('completionHints', () => {
  it('offers the macros without needing a network call', () => {
    // The expensive half of autocomplete is columns, which needs a metadata
    // endpoint that does not exist. Macros are a fixed list.
    const labels = completionHints(dash()).map((h) => h.label);
    expect(labels).toContain('$__interval');
    expect(labels.some((l) => l.startsWith('$__timeFilter'))).toBe(true);
  });

  it('offers the dashboard variables', () => {
    const d = dash({
      variables: [{ name: 'host', type: 'query', label: '', hide: 'none' } as never],
    });
    expect(completionHints(d).map((h) => h.label)).toContain('$host');
  });

  it('has no duplicates', () => {
    const labels = completionHints(dash()).map((h) => h.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
