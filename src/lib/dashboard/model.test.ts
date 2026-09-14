import { describe, it, expect } from 'vitest';
import {
  GRID_COLUMNS,
  LAUNCHPAD_SCHEMA_VERSION,
  PANEL_ID_PATTERN,
  RESERVED_VARIABLE_NAMES,
  UID_PATTERN,
  VARIABLE_NAME_PATTERN,
  createDashboard,
  createPanel,
  defaultTimeSettings,
  isPanelType,
  isSafeColor,
  isVariableType,
  mergePanels,
  migrateModel,
  newDashboardUid,
  newPanelId,
  nextPanelId,
  preflightVersion,
  serializeForSave,
  type Panel,
} from './model';

describe('identifier generators satisfy their own patterns', () => {
  // The generator and the pattern live in the same file precisely so they
  // cannot drift — but nothing checks that they agree unless we check it.
  it('newDashboardUid matches UID_PATTERN', () => {
    for (let i = 0; i < 100; i++) expect(newDashboardUid()).toMatch(UID_PATTERN);
  });

  it('newPanelId matches PANEL_ID_PATTERN', () => {
    for (let i = 0; i < 100; i++) expect(newPanelId()).toMatch(PANEL_ID_PATTERN);
  });

  it('generates distinct uids', () => {
    const ids = new Set(Array.from({ length: 500 }, newDashboardUid));
    expect(ids.size).toBe(500);
  });
});

describe('nextPanelId', () => {
  it('returns the lowest unused positive integer', () => {
    expect(nextPanelId([])).toBe('1');
    expect(nextPanelId([{ id: '1' }])).toBe('2');
    expect(nextPanelId([{ id: '1' }, { id: '3' }])).toBe('2');
  });

  it('ignores non-numeric ids', () => {
    expect(nextPanelId([{ id: 'abc' }])).toBe('1');
  });

  it('is deterministic — the same input always yields the same id', () => {
    // #33 requires layout to survive save/reload byte-identically, which a
    // random generator here would break.
    const panels = [{ id: '1' }, { id: '2' }];
    expect(nextPanelId(panels)).toBe(nextPanelId(panels));
  });
});

describe('mergePanels', () => {
  const panel = (id: string): Panel =>
    createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id });

  it('appends when there is no collision', () => {
    const out = mergePanels([panel('a')], [panel('b')]);
    expect(out.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('renumbers a colliding id rather than rejecting', () => {
    // Rejecting would lose the panel the user just built, to an error naming
    // an id they never saw.
    const out = mergePanels([panel('1')], [panel('1')]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((p) => p.id)).size).toBe(2);
  });

  it('handles several collisions in one merge', () => {
    const out = mergePanels([panel('1'), panel('2')], [panel('1'), panel('2')]);
    expect(new Set(out.map((p) => p.id)).size).toBe(4);
  });

  it('does not mutate its inputs', () => {
    const existing = [panel('1')];
    const incoming = [panel('1')];
    mergePanels(existing, incoming);
    expect(existing).toHaveLength(1);
    expect(incoming[0].id).toBe('1');
  });
});

describe('factories', () => {
  it('createDashboard stamps the current schema version', () => {
    const d = createDashboard({ title: 'T', instanceId: 'i' });
    expect(d.launchpadSchemaVersion).toBe(LAUNCHPAD_SCHEMA_VERSION);
    expect(d.panels).toEqual([]);
    expect(d.variables).toEqual([]);
  });

  it('createDashboard accepts a null instance for a shared export', () => {
    expect(createDashboard({ title: 'T', instanceId: null }).instanceId).toBeNull();
  });

  it('createDashboard omits description entirely when not given', () => {
    // Absent rather than undefined, so the round trip through JSON is lossless.
    expect('description' in createDashboard({ title: 'T', instanceId: 'i' })).toBe(false);
  });

  it('createPanel produces one empty target', () => {
    const p = createPanel({ type: 'timeseries', gridPos: { x: 0, y: 0, w: 12, h: 8 } });
    expect(p.targets).toEqual([{ refId: 'A', sql: '' }]);
    expect(p.title).toBe('');
  });

  it('defaultTimeSettings returns a fresh object each call', () => {
    // A shared mutable default is process-wide state on a multi-tenant server.
    const a = defaultTimeSettings();
    const b = defaultTimeSettings();
    expect(a).not.toBe(b);
    a.from = 'mutated';
    expect(b.from).toBe('now-6h');
  });
});

describe('serializeForSave', () => {
  it('is stable regardless of key insertion order', () => {
    // The panel editor rebuilds option objects on every change; without a
    // canonical order a key-order difference reads as "everything changed".
    const a = { ...createDashboard({ title: 'T', instanceId: 'i' }), tags: ['x'] };
    // Same content, deliberately different key insertion order.
    const b = {
      tags: ['x'],
      title: a.title,
      variables: a.variables,
      panels: a.panels,
      time: { to: a.time.to, refresh: a.time.refresh, timezone: a.time.timezone, from: a.time.from },
      instanceId: a.instanceId,
      launchpadSchemaVersion: a.launchpadSchemaVersion,
    };
    expect(Object.keys(a)).not.toEqual(Object.keys(b));
    expect(serializeForSave(a)).toBe(serializeForSave(b));
  });

  it('sorts nested keys too', () => {
    const d = createDashboard({ title: 'T', instanceId: 'i' });
    d.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        options: { zebra: 1, apple: 2 },
      },
    ];
    expect(serializeForSave(d)).toContain('"options":{"apple":2,"zebra":1}');
  });

  it('preserves array order', () => {
    const d = createDashboard({ title: 'T', instanceId: 'i' });
    d.tags = ['zebra', 'apple'];
    expect(serializeForSave(d)).toContain('"tags":["zebra","apple"]');
  });
});

describe('preflightVersion', () => {
  it('accepts an absent version as pre-versioning', () => {
    expect(preflightVersion({})).toEqual({ ok: true, version: 0 });
  });

  it('accepts the current version', () => {
    expect(preflightVersion({ launchpadSchemaVersion: LAUNCHPAD_SCHEMA_VERSION })).toEqual({
      ok: true,
      version: LAUNCHPAD_SCHEMA_VERSION,
    });
  });

  it.each([[null], ['x'], [[]], [1]])('rejects non-object input %j', (input) => {
    const result = preflightVersion(input);
    expect(result.ok).toBe(false);
  });

  it.each([['1'], [1.5], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'rejects a malformed version %j rather than treating it as 0',
    (version) => {
      // Silently zeroing would stamp the document as current without ever
      // running a migration over it.
      const result = preflightVersion({ launchpadSchemaVersion: version });
      expect(result.ok).toBe(false);
    },
  );

  it('rejects a version newer than this build', () => {
    const result = preflightVersion({ launchpadSchemaVersion: LAUNCHPAD_SCHEMA_VERSION + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('version_too_new');
  });
});

describe('migrateModel', () => {
  it('always returns a fresh object', () => {
    // Returning the input on the happy path and a copy otherwise leaves
    // callers unable to know whether they own the result.
    const input = { launchpadSchemaVersion: LAUNCHPAD_SCHEMA_VERSION, a: 1 };
    const out = migrateModel(input, LAUNCHPAD_SCHEMA_VERSION);
    expect(out).not.toBe(input);
    expect(out).toEqual(input);
  });

  it('stamps the version when migrating up from an older document', () => {
    expect(migrateModel({ a: 1 }, 0).launchpadSchemaVersion).toBe(LAUNCHPAD_SCHEMA_VERSION);
  });

  it('keeps a __proto__ key inert rather than setting the prototype', () => {
    // Object spread defines own properties; Object.assign would trigger the
    // __proto__ setter and replace the prototype.
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
    const out = migrateModel(parsed, 0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe('type guards', () => {
  it('isPanelType accepts a plain string argument', () => {
    // PANEL_TYPES.includes(x) does not compile for x: string, which is why
    // these guards exist rather than callers reaching for `as any`.
    const value: string = 'timeseries';
    expect(isPanelType(value)).toBe(true);
    expect(isPanelType('nope')).toBe(false);
    expect(isPanelType(null)).toBe(false);
  });

  it('isVariableType works the same way', () => {
    expect(isVariableType('instance')).toBe(true);
    expect(isVariableType('adhoc')).toBe(false);
  });
});

describe('isSafeColor', () => {
  it.each([['#abc'], ['#aabbcc'], ['#aabbccdd'], ['rgb(1,2,3)'], ['rgba(1, 2, 3, 0.4)'], ['green'], ['super-light-blue']])(
    'accepts %s',
    (c) => expect(isSafeColor(c)).toBe(true),
  );

  it.each([
    ['red; position:fixed'],
    ['url(https://evil)'],
    ['\\75 rl(https://evil)'],
    ['javascript:alert(1)'],
    ['notacolor'],
    [''],
    [null],
    [123],
    ['#'.padEnd(64, 'a')],
  ])('rejects %j', (c) => expect(isSafeColor(c)).toBe(false));
});

describe('patterns', () => {
  it('VARIABLE_NAME_PATTERN reserves the __ macro namespace', () => {
    // The `__` prefix is what collides with $__interval / $__timeFrom, and
    // it also covers __proto__.
    for (const bad of ['__proto__', '__interval', '__timeFrom', '1abc', 'a-b', '', 'a'.repeat(65)]) {
      expect(VARIABLE_NAME_PATTERN.test(bad)).toBe(false);
    }
    for (const good of ['host', 'my_var', 'Region2']) {
      expect(VARIABLE_NAME_PATTERN.test(good)).toBe(true);
    }
  });

  it('RESERVED_VARIABLE_NAMES covers the pollution keys the pattern alone allows', () => {
    // `constructor` and `prototype` pass the charset rule, so the denylist is
    // load-bearing rather than belt-and-braces. Both mechanisms are applied by
    // the validator; neither is sufficient alone.
    for (const name of ['constructor', 'prototype']) {
      expect(VARIABLE_NAME_PATTERN.test(name)).toBe(true);
      expect(RESERVED_VARIABLE_NAMES.has(name)).toBe(true);
    }
  });

  it('GRID_COLUMNS is 24, matching Grafana so layouts port', () => {
    expect(GRID_COLUMNS).toBe(24);
  });
});
