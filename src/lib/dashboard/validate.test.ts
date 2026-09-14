import { describe, it, expect } from 'vitest';
import {
  validateDashboard,
  parseAndValidate,
  maxDepthOf,
} from './validate';
import {
  LAUNCHPAD_SCHEMA_VERSION,
  LIMITS,
  createDashboard,
  createPanel,
  serializeForSave,
  type Dashboard,
} from './model';
import { fullyPopulatedDashboard } from './fixtures';

/** Narrows the result so tests can reach `.model` without repeating the guard. */
function expectOk(result: ReturnType<typeof validateDashboard>) {
  if (!result.ok) {
    throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors, null, 2)}`);
  }
  return result;
}

function expectErr(result: ReturnType<typeof validateDashboard>) {
  if (result.ok) throw new Error('expected validation to fail');
  return result;
}

/** A minimal valid dashboard, as a plain JSON-ish value. */
function minimal(): Dashboard {
  return createDashboard({ title: 'Minimal', instanceId: 'inst-1' });
}

// ===========================================================================
// The contract tests — these are what catch a downstream break
// ===========================================================================

describe('contract', () => {
  // The single highest-value test in the file. If someone adds a field to the
  // model and forgets the schema, the field is stripped here and this fails.
  it('preserves every field a fully-populated model can carry', () => {
    const input = fullyPopulatedDashboard();
    const result = expectOk(validateDashboard(structuredClone(input)));
    expect(result.model).toEqual(input);
    expect(result.warnings).toEqual([]);
  });

  it('is idempotent', () => {
    const once = expectOk(validateDashboard(fullyPopulatedDashboard())).model;
    const twice = expectOk(validateDashboard(structuredClone(once))).model;
    expect(twice).toEqual(once);
  });

  it('accepts what createDashboard produces, through a JSON round trip', () => {
    const json = JSON.parse(JSON.stringify(createDashboard({ title: 'New', instanceId: 'i' })));
    expect(expectOk(validateDashboard(json)).model.title).toBe('New');
  });

  it('accepts a dashboard containing what createPanel produces', () => {
    // Guards the empty-sql case specifically: every new panel has sql: ''.
    const model = minimal();
    model.panels = [createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 6, h: 4 }, id: 'p1' })];
    const result = expectOk(validateDashboard(JSON.parse(JSON.stringify(model))));
    expect(result.model.panels[0].targets[0].sql).toBe('');
  });

  it('survives serializeForSave and back', () => {
    const input = fullyPopulatedDashboard();
    const reparsed = JSON.parse(serializeForSave(input));
    expect(expectOk(validateDashboard(reparsed)).model).toEqual(input);
  });
});

// ===========================================================================
// Trust boundary
// ===========================================================================

describe('unknown keys', () => {
  it('strips unrecognised top-level and panel keys instead of rejecting', () => {
    const input: Record<string, unknown> = { ...minimal(), sneaky: 'value', __evil: 1 };
    const result = expectOk(validateDashboard(input));
    expect(result.model).not.toHaveProperty('sneaky');
    expect(result.model).not.toHaveProperty('__evil');
  });
});

describe('prototype pollution', () => {
  it('does not let a __proto__ key reach Object.prototype', () => {
    const json = `{"launchpadSchemaVersion":1,"title":"x","tags":[],"instanceId":"i",
      "time":{"from":"now-6h","to":"now","timezone":"utc","refresh":""},
      "variables":[],"panels":[],"__proto__":{"polluted":true}}`;
    expectOk(parseAndValidate(json));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('does not let __proto__ inside a panel options bag pollute', () => {
    const model = minimal();
    const panel = createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' });
    model.panels = [panel];
    const json = JSON.stringify(model).replace('"options":{}', '"options":{"__proto__":{"bad":1}}');
    expectOk(parseAndValidate(json));
    expect(({} as Record<string, unknown>).bad).toBeUndefined();
  });

  it('rejects a variable named __proto__ or constructor', () => {
    for (const name of ['__proto__', 'constructor', '__interval']) {
      const model = minimal();
      model.variables = [{ name, type: 'custom', query: 'a,b' }];
      const result = expectErr(validateDashboard(JSON.parse(JSON.stringify(model))));
      expect(result.errors[0].path).toBe('variables[0].name');
    }
  });
});

describe('depth limits', () => {
  it('computes depth without recursing', () => {
    // If maxDepthOf were recursive this would throw RangeError rather than
    // returning — which is the whole reason it uses an explicit stack.
    let deep: unknown = 'leaf';
    for (let i = 0; i < 100_000; i++) deep = { a: deep };
    expect(() => maxDepthOf(deep)).not.toThrow();
    expect(maxDepthOf(deep)).toBeGreaterThan(LIMITS.maxDepth);
  });

  it('rejects a document nested past the cap', () => {
    // Small in bytes, catastrophic downstream: devalue (SvelteKit's load
    // serializer) stack-overflows near depth 1560, which permanently 500s the
    // dashboard. This payload is a fraction of the byte cap.
    const model = minimal() as unknown as Record<string, unknown>;
    let deep: unknown = 1;
    for (let i = 0; i < 2000; i++) deep = { a: deep };
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        options: { nested: deep },
      },
    ];
    const json = JSON.stringify(model);
    expect(json.length).toBeLessThan(LIMITS.maxPayloadBytes);
    const result = expectErr(parseAndValidate(json));
    expect(result.errors[0].code).toBe('too_deep');
  });

  it('computes depth in bytes-independent fashion for shallow docs', () => {
    expect(maxDepthOf({ a: { b: { c: 1 } } })).toBe(3);
    expect(maxDepthOf([[[1]]])).toBe(3);
    expect(maxDepthOf('leaf')).toBe(0);
  });
});

describe('payload size', () => {
  it('rejects an oversize payload before parsing', () => {
    const json = `{"title":"${'x'.repeat(LIMITS.maxPayloadBytes)}"}`;
    const result = expectErr(parseAndValidate(json));
    expect(result.errors[0].code).toBe('too_large');
  });

  it('measures bytes, not UTF-16 code units', () => {
    // Each emoji is 2 code units but 4 UTF-8 bytes, so a string comfortably
    // under the cap by .length is over it by bytes.
    const emoji = '🙂'.repeat(Math.ceil(LIMITS.maxPayloadBytes / 3));
    const json = `{"title":"${emoji}"}`;
    expect(json.length).toBeLessThan(LIMITS.maxPayloadBytes);
    expect(expectErr(parseAndValidate(json)).errors[0].code).toBe('too_large');
  });

  it('reports malformed JSON as such', () => {
    expect(expectErr(parseAndValidate('{not json')).errors[0].code).toBe('malformed_json');
  });
});

describe('server-owned fields', () => {
  it('drops uid and version, so an import cannot overwrite or poison concurrency', () => {
    // z.object strips unknown keys, so these cannot survive into the model.
    // An explicit stripServerOwnedFields() helper was removed as dead weight:
    // it duplicated a guarantee the schema already makes, and a belt nobody
    // fastens is a trap rather than defence in depth.
    const result = expectOk(validateDashboard({ ...minimal(), uid: 'victim', version: 99 }));
    expect(result.model).not.toHaveProperty('uid');
    expect(result.model).not.toHaveProperty('version');
  });
});

// ===========================================================================
// Versioning
// ===========================================================================

describe('schema version', () => {
  it('rejects a version newer than this build, with an actionable code', () => {
    const result = expectErr(
      validateDashboard({ ...minimal(), launchpadSchemaVersion: LAUNCHPAD_SCHEMA_VERSION + 1 }),
    );
    expect(result.errors[0]).toMatchObject({
      path: 'launchpadSchemaVersion',
      code: 'version_too_new',
    });
  });

  it('does not confuse a Grafana schemaVersion for ours', () => {
    // A Grafana export carries schemaVersion 16-42. Sharing one field name
    // would make every Grafana document look like a newer Launchpad one.
    const result = expectOk(validateDashboard({ ...minimal(), schemaVersion: 42 }));
    expect(result.model.launchpadSchemaVersion).toBe(LAUNCHPAD_SCHEMA_VERSION);
  });

  it('treats an absent version as pre-versioning and stamps it', () => {
    const { launchpadSchemaVersion: _drop, ...rest } = minimal();
    expect(expectOk(validateDashboard(rest)).model.launchpadSchemaVersion).toBe(
      LAUNCHPAD_SCHEMA_VERSION,
    );
  });

  it.each([['1'], [1.5], [-1], [null], [Number.NaN]])(
    'rejects a present-but-malformed version %j rather than silently zeroing it',
    (version) => {
      const result = expectErr(validateDashboard({ ...minimal(), launchpadSchemaVersion: version }));
      expect(result.errors[0].code).toBe('wrong_type');
    },
  );

  it.each([[null], ['string'], [[]], [42]])('rejects non-object input %j', (input) => {
    expect(expectErr(validateDashboard(input)).errors[0].code).toBe('wrong_type');
  });
});

// ===========================================================================
// Error reporting is public API
// ===========================================================================

describe('errors', () => {
  it('reports the exact path, in accessor grammar', () => {
    const model = minimal() as unknown as Record<string, unknown>;
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        gridPos: { x: 0, y: 0, w: 99, h: 4 },
      },
    ];
    const result = expectErr(validateDashboard(model));
    expect(result.errors[0].path).toBe('panels[0].gridPos.w');
  });

  it('collects every error rather than stopping at the first', () => {
    const result = expectErr(
      validateDashboard({
        launchpadSchemaVersion: 1,
        title: '',
        tags: 'not-an-array',
        instanceId: 'i',
        time: { from: 'now-6h', to: 'now', timezone: 'Mars/Olympus', refresh: 'soon' },
        variables: [],
        panels: [],
      }),
    );
    const paths = result.errors.map((e) => e.path);
    expect(paths).toContain('title');
    expect(paths).toContain('tags');
    expect(paths).toContain('time.timezone');
    expect(paths).toContain('time.refresh');
  });

  it('never echoes the offending value into the message', () => {
    const model = minimal() as unknown as Record<string, unknown>;
    const hostile = '<img src=x onerror=alert(1)>';
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        fieldConfig: { defaults: { color: { mode: 'fixed', fixedColor: hostile } } },
      },
    ];
    const result = expectErr(validateDashboard(model));
    for (const err of result.errors) expect(err.message).not.toContain(hostile);
  });
});

// ===========================================================================
// Field rules
// ===========================================================================

describe('colors', () => {
  it.each([['#fff'], ['#ff0000'], ['rgb(1, 2, 3)'], ['rgba(1, 2, 3, 0.5)'], ['green'], ['semi-dark-orange']])(
    'accepts %s',
    (color) => {
      const model = minimal();
      model.panels = [
        {
          ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
          fieldConfig: { defaults: { thresholds: { mode: 'absolute', steps: [{ value: null, color }] } } },
        },
      ];
      expectOk(validateDashboard(JSON.parse(JSON.stringify(model))));
    },
  );

  it.each([
    ['red; position:fixed; top:0; width:100vw; height:100vh'],
    ['url(https://evil.example)'],
    ['\\75 rl(https://evil.example)'],
    ['expression(alert(1))'],
  ])('rejects the CSS injection %j', (color) => {
    const model = minimal() as unknown as Record<string, unknown>;
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        fieldConfig: { defaults: { thresholds: { mode: 'absolute', steps: [{ value: null, color }] } } },
      },
    ];
    expectErr(validateDashboard(model));
  });
});

describe('user-supplied regexes are not accepted in v1', () => {
  // A source-level heuristic cannot prevent catastrophic backtracking:
  // `\\s*\\s*$` is 7 characters with no nested quantifier and blocks for ~12s
  // on a 4KB value. Dashboards are shared, so that is a DoS against colleagues
  // — and against the whole control plane if evaluated server-side, since
  // better-sqlite3 is synchronous. Deferred to #38 behind RE2.
  it('drops a variable regex rather than storing a pattern it cannot bound', () => {
    const model = minimal() as unknown as Record<string, unknown>;
    model.variables = [{ name: 'v', type: 'query', query: 'SELECT 1', regex: '\\s*\\s*$' }];
    const result = expectOk(validateDashboard(model));
    expect(result.model.variables[0]).not.toHaveProperty('regex');
  });

  it('rejects a regex value mapping', () => {
    const model = minimal() as unknown as Record<string, unknown>;
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        fieldConfig: {
          defaults: { mappings: [{ type: 'regex', pattern: '(a|a)+$', result: { text: 'x' } }] },
        },
      },
    ];
    expectErr(validateDashboard(model));
  });
});

describe('numeric guards', () => {
  it.each([
    ['decimals', 500],
    ['maxDataPoints', 1e9],
  ])('rejects an out-of-range %s', (field, value) => {
    const model = minimal() as unknown as Record<string, unknown>;
    const base = createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' });
    model.panels = [
      field === 'decimals'
        ? { ...base, fieldConfig: { defaults: { decimals: value } } }
        : { ...base, maxDataPoints: value },
    ];
    expectErr(validateDashboard(model));
  });

  it('rejects NaN and Infinity', () => {
    // They survive neither JSON nor SQLite meaningfully, so they must not enter.
    const model = minimal() as unknown as Record<string, unknown>;
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        fieldConfig: { defaults: { min: Number.POSITIVE_INFINITY } },
      },
    ];
    expectErr(validateDashboard(model));
  });
});

describe('database names', () => {
  it('rejects a database name that could reach SQL unescaped', () => {
    const model = minimal();
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        targets: [{ refId: 'A', sql: 'SELECT 1', database: 'db"; DROP TABLE x; --' }],
      },
    ];
    expectErr(validateDashboard(JSON.parse(JSON.stringify(model))));
  });
});

// ===========================================================================
// Normalization
// ===========================================================================

describe('normalization', () => {
  it('sorts threshold steps base-first-then-ascending, and warns', () => {
    const model = minimal();
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        fieldConfig: {
          defaults: {
            thresholds: {
              mode: 'absolute',
              steps: [
                { value: 95, color: 'red' },
                { value: null, color: 'green' },
                { value: 80, color: 'orange' },
              ],
            },
          },
        },
      },
    ];
    const result = expectOk(validateDashboard(JSON.parse(JSON.stringify(model))));
    expect(result.model.panels[0].fieldConfig.defaults.thresholds?.steps.map((s) => s.value)).toEqual([
      null, 80, 95,
    ]);
    expect(result.warnings.some((w) => w.message.includes('reordered'))).toBe(true);
  });

  it('renumbers a duplicate panel id rather than rejecting the document', () => {
    // Rejecting would lose work the user cannot get back.
    const model = minimal();
    const base = createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'dup' });
    model.panels = [base, { ...base, title: 'second' }];
    const result = expectOk(validateDashboard(JSON.parse(JSON.stringify(model))));
    const ids = result.model.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(2);
    expect(result.warnings.some((w) => w.path === 'panels[1].id')).toBe(true);
  });

  it('clamps a panel that extends past the grid, and warns', () => {
    const model = minimal();
    model.panels = [createPanel({ type: 'stat', gridPos: { x: 20, y: 0, w: 12, h: 4 }, id: 'p' })];
    const result = expectOk(validateDashboard(JSON.parse(JSON.stringify(model))));
    expect(result.model.panels[0].gridPos.w).toBe(4);
    expect(result.warnings.some((w) => w.path === 'panels[0].gridPos')).toBe(true);
  });

  it('stamps the default refresh on a query variable that omits it', () => {
    const model = minimal();
    model.variables = [{ name: 'v', type: 'query', query: 'SELECT 1' }];
    const result = expectOk(validateDashboard(JSON.parse(JSON.stringify(model))));
    expect(result.model.variables[0].refresh).toBe('on-dashboard-load');
  });

  it('drops a duplicate variable name and warns', () => {
    const model = minimal();
    model.variables = [
      { name: 'dup', type: 'custom', query: 'a' },
      { name: 'dup', type: 'custom', query: 'b' },
    ];
    const result = expectOk(validateDashboard(JSON.parse(JSON.stringify(model))));
    expect(result.model.variables).toHaveLength(1);
    expect(result.warnings.some((w) => w.path === 'variables[1]')).toBe(true);
  });

  it('clears min/max when inverted', () => {
    const model = minimal() as unknown as Record<string, unknown>;
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        fieldConfig: { defaults: { min: 100, max: 0 } },
      },
    ];
    const result = expectOk(validateDashboard(model));
    expect(result.model.panels[0].fieldConfig.defaults.min).toBeUndefined();
    expect(result.model.panels[0].fieldConfig.defaults.max).toBeUndefined();
  });
});

// ===========================================================================
// The instanceId contract
// ===========================================================================

describe('referencedInstanceIds', () => {
  // The security review's central finding: a caller that authorizes only the
  // dashboard-level id leaves the panel and target overrides unchecked, and
  // those are the levels with no UI and therefore no reviewer intuition.
  it('reports ids from every level, not just the dashboard', () => {
    const result = expectOk(validateDashboard(fullyPopulatedDashboard()));
    expect([...result.referencedInstanceIds].sort()).toEqual([
      'inst-dashboard',
      'inst-panel',
      'inst-target',
      'inst-variable',
    ]);
  });

  it('reports a panel override even when the dashboard id is absent', () => {
    const model = minimal();
    model.instanceId = null;
    model.panels = [
      { ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }), instanceId: 'other-org-instance' },
    ];
    const result = expectOk(validateDashboard(JSON.parse(JSON.stringify(model))));
    expect([...result.referencedInstanceIds]).toEqual(['other-org-instance']);
  });

  it('accepts a null instanceId so a shared export can round-trip', () => {
    // Export-for-sharing externalizes the instance. Saving null is legal —
    // execution is what requires a resolvable instance — so a shared export
    // round-trips, and a brand-new dashboard needs no instance picker.
    const model = { ...minimal(), instanceId: null };
    expectOk(validateDashboard(model));
  });
});


// ===========================================================================
// Regressions — every test below fails against the pre-review implementation
// ===========================================================================

describe('regression: threshold ordering is a total order', () => {
  function withSteps(steps: Array<{ value: number | null; color: string }>) {
    const model = minimal() as unknown as Record<string, unknown>;
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        fieldConfig: { defaults: { thresholds: { mode: 'absolute', steps } } },
      },
    ];
    return model;
  }

  // Returning -1 for both cmp(a,b) and cmp(b,a) made V8 swap the pair on every
  // pass, so WHICH color served as the base step flipped on every save.
  it('does not reorder two base steps back and forth across repeated saves', () => {
    const input = withSteps([
      { value: null, color: 'red' },
      { value: null, color: 'green' },
      { value: 5, color: 'blue' },
    ]);
    const colorsAfter = (doc: unknown) =>
      expectOk(validateDashboard(doc)).model.panels[0].fieldConfig.defaults.thresholds!.steps.map(
        (s) => s.color,
      );

    const first = colorsAfter(structuredClone(input));
    const second = colorsAfter(structuredClone(input));
    const third = colorsAfter(structuredClone(input));
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first).toEqual(['red', 'green', 'blue']);
  });

  it('emits no warning on a second pass over an already-normalized document', () => {
    // Normalization that does not reach a fixed point is not normalization: it
    // makes dirty-tracking fire on every open and adds a version per save.
    const once = expectOk(
      validateDashboard(
        withSteps([
          { value: null, color: 'red' },
          { value: null, color: 'green' },
        ]),
      ),
    );
    const twice = expectOk(validateDashboard(structuredClone(once.model)));
    expect(twice.warnings).toEqual([]);
    expect(twice.model).toEqual(once.model);
  });
});

describe('regression: duplicate panel ids do not cascade', () => {
  it('leaves the ids of non-duplicate panels untouched', () => {
    // Probing upward from a partially-filled set handed out ids belonging to
    // panels later in the array, renaming panels that were never duplicates
    // and breaking their ?viewPanel= bookmarks.
    const model = minimal() as unknown as Record<string, unknown>;
    const base = (id: string, title: string) => ({
      ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id }),
      title,
    });
    model.panels = [
      base('1', 'first'),
      base('1', 'duplicate'),
      base('2', 'innocent'),
      base('3', 'also-innocent'),
    ];

    const result = expectOk(validateDashboard(model));
    const byTitle = Object.fromEntries(result.model.panels.map((p) => [p.title, p.id]));

    expect(byTitle.first).toBe('1');
    expect(byTitle.innocent).toBe('2');
    expect(byTitle['also-innocent']).toBe('3');
    expect(byTitle.duplicate).not.toBe('1');
    expect(new Set(Object.values(byTitle)).size).toBe(4);
    expect(result.warnings.filter((w) => w.code === 'renamed')).toHaveLength(1);
  });
});

describe('regression: instance variable references', () => {
  it('excludes a $variable reference from the literal id set', () => {
    // Emitting the literal '$instance' as an id made every templated dashboard
    // unsaveable: storage resolves ids with WHERE id = ?, which never matches.
    const model = minimal();
    model.variables = [
      { name: 'instance', type: 'instance', current: [{ text: 'a', value: 'inst-a' }] },
    ];
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        instanceId: '$instance',
      },
    ];
    const result = expectOk(validateDashboard(JSON.parse(JSON.stringify(model))));
    expect(result.referencedInstanceIds).toEqual(['inst-1']);
    expect(result.warnings).toEqual([]);
  });

  it('warns when a reference names no declared instance variable', () => {
    const model = minimal();
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        instanceId: '$nope',
      },
    ];
    const result = expectOk(validateDashboard(JSON.parse(JSON.stringify(model))));
    expect(result.warnings.map((w) => w.path)).toContain('panels[0].instanceId');
  });

  it('returns a plain array, because a Set JSON.stringifies to an empty object', () => {
    const result = expectOk(validateDashboard(fullyPopulatedDashboard()));
    expect(Array.isArray(result.referencedInstanceIds)).toBe(true);
    const roundTripped = JSON.parse(JSON.stringify({ ids: result.referencedInstanceIds }));
    expect(roundTripped.ids.length).toBeGreaterThan(0);
  });
});

describe('regression: identifiers that become object keys', () => {
  it.each([['__proto__'], ['constructor'], ['toString'], ['hasOwnProperty']])(
    'rejects panel id %j',
    (id) => {
      const model = minimal() as unknown as Record<string, unknown>;
      model.panels = [createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id })];
      expect(expectErr(validateDashboard(model)).errors[0].path).toBe('panels[0].id');
    },
  );

  it.each([['__proto__'], ['constructor'], ['toString']])('rejects refId %j', (refId) => {
    const model = minimal() as unknown as Record<string, unknown>;
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        targets: [{ refId, sql: 'SELECT 1' }],
      },
    ];
    expect(expectErr(validateDashboard(model)).errors[0].path).toBe('panels[0].targets[0].refId');
  });
});

describe('regression: instanceId is charset-validated', () => {
  const CR_LF = String.fromCharCode(13, 10);
  const NUL = String.fromCharCode(0);
  it.each([
    ['../../../etc/passwd'],
    ['a' + CR_LF + 'X-Injected: 1'],
    ['a' + NUL + 'b'],
    ['http://evil.example'],
    ["' OR 1=1 --"],
    ['..'],
  ])('rejects %j', (instanceId) => {
    const result = expectErr(validateDashboard({ ...minimal(), instanceId }));
    expect(result.errors[0].path).toBe('instanceId');
  });
});

describe('regression: refresh floor is enforced', () => {
  it.each([['0ms'], ['1ms'], ['1s'], ['4s']])('clamps %s up to the minimum', (refresh) => {
    // A shared dashboard at 0ms makes every viewer's browser poll the proxy as
    // fast as it can — and the proxy injects the admin token.
    const model = minimal();
    model.time = { ...model.time, refresh };
    const result = expectOk(validateDashboard(JSON.parse(JSON.stringify(model))));
    expect(result.model.time.refresh).toBe('5s');
    expect(result.warnings.some((w) => w.code === 'clamped')).toBe(true);
  });

  it('leaves an acceptable interval alone', () => {
    const model = minimal();
    model.time = { ...model.time, refresh: '30s' };
    const result = expectOk(validateDashboard(JSON.parse(JSON.stringify(model))));
    expect(result.model.time.refresh).toBe('30s');
    expect(result.warnings).toEqual([]);
  });

  it('rejects a duration far past any sane bound', () => {
    const model = minimal() as unknown as Record<string, unknown>;
    (model.time as Record<string, unknown>).nowDelay = '999999999999d';
    expectErr(validateDashboard(model));
  });
});

describe('regression: timezone link names are accepted', () => {
  it.each([['US/Eastern'], ['GMT'], ['Etc/GMT+5'], ['Japan'], ['Zulu']])(
    'accepts the IANA link name %s',
    (timezone) => {
      // Intl.supportedValuesOf returns canonical zones only, so treating it as
      // exhaustive rejected names Intl itself accepts and that appear
      // throughout older Grafana exports.
      const model = minimal();
      model.time = { ...model.time, timezone };
      expectOk(validateDashboard(JSON.parse(JSON.stringify(model))));
    },
  );

  it('still rejects a zone that is not real', () => {
    const model = minimal();
    model.time = { ...model.time, timezone: 'Mars/Olympus' };
    expectErr(validateDashboard(JSON.parse(JSON.stringify(model))));
  });
});

describe('regression: the structural budget applies to validateDashboard too', () => {
  it('rejects a document with too many nodes', () => {
    // Every route in this repo uses request.json(), so the idiomatic path had
    // no bound at all: a 44MB input blocked the event loop for 484ms.
    const model = minimal() as unknown as Record<string, unknown>;
    const huge = Array.from({ length: LIMITS.maxNodes + 10 }, (_, i) => i);
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        options: { huge },
      },
    ];
    expect(expectErr(validateDashboard(model)).errors[0].code).toBe('too_large');
  });
});

describe('regression: error and warning codes are usable', () => {
  it('reports a refine failure with its real code, not a generic one', () => {
    const model = minimal() as unknown as Record<string, unknown>;
    const options: Record<string, number> = {};
    for (let i = 0; i < LIMITS.maxOptionsKeys + 1; i++) options[`k${i}`] = i;
    model.panels = [
      { ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }), options },
    ];
    expect(expectErr(validateDashboard(model)).errors[0].code).toBe('too_many');
  });

  it('reports a missing required field as required, not wrong_type', () => {
    const { time: _drop, ...rest } = minimal();
    expect(expectErr(validateDashboard(rest)).errors[0].code).toBe('required');
  });

  it('gives every warning a code', () => {
    const model = minimal();
    model.panels = [createPanel({ type: 'stat', gridPos: { x: 20, y: 0, w: 12, h: 4 }, id: 'p' })];
    const result = expectOk(validateDashboard(JSON.parse(JSON.stringify(model))));
    expect(result.warnings.length).toBeGreaterThan(0);
    for (const w of result.warnings) expect(w.code).toBeTruthy();
  });
});

describe('regression: misc field rules', () => {
  it('rejects a whitespace-only title', () => {
    expect(expectErr(validateDashboard({ ...minimal(), title: '    ' })).errors[0].code).toBe(
      'required',
    );
  });

  it('measures SQL length in UTF-8 bytes, not UTF-16 code units', () => {
    const model = minimal();
    // Each emoji is 2 code units but 4 bytes: under the cap by .length, over
    // it by bytes.
    const sql = '\u{1F642}'.repeat(Math.ceil(LIMITS.maxSqlBytes / 3));
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        targets: [{ refId: 'A', sql }],
      },
    ];
    expect(sql.length).toBeLessThan(LIMITS.maxSqlBytes);
    expectErr(validateDashboard(JSON.parse(JSON.stringify(model))));
  });

  it('reports a missing fixedColor on the field, not the whole color object', () => {
    const model = minimal() as unknown as Record<string, unknown>;
    model.panels = [
      {
        ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }),
        fieldConfig: { defaults: { color: { mode: 'fixed' } } },
      },
    ];
    const result = expectErr(validateDashboard(model));
    expect(result.errors[0].path).toBe('panels[0].fieldConfig.defaults.color.fixedColor');
  });
});
