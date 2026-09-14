import { describe, it, expect } from 'vitest';
import {
  buildLogQuery,
  createRelativeTimeRange,
  createAbsoluteTimeRange,
  TIME_RANGE_PRESETS,
  type LogQueryOptions,
} from './logQueryBuilder';
import type { LogFieldMapping } from './logFieldDetector';

const mapping = (over: Partial<LogFieldMapping> = {}): LogFieldMapping => ({
  timestamp: 'time',
  level: 'level',
  message: 'message',
  source: 'host',
  traceId: null,
  spanId: null,
  parentSpanId: null,
  ...over,
});

const opts = (over: Partial<LogQueryOptions> = {}): LogQueryOptions => ({
  measurement: 'logs',
  fieldMapping: mapping(),
  timeRange: createRelativeTimeRange(60),
  levels: [],
  searchText: '',
  limit: 1000,
  ...over,
});

describe('buildLogQuery — shape', () => {
  it('builds a bare SELECT with time filter, ordering and limit', () => {
    const sql = buildLogQuery(opts());
    expect(sql).toContain('SELECT *');
    expect(sql).toContain('FROM logs');
    expect(sql).toContain('ORDER BY time DESC');
    expect(sql).toContain('LIMIT 1000');
  });

  it('omits the WHERE clause entirely when there is nothing to filter on', () => {
    const sql = buildLogQuery(
      opts({ fieldMapping: mapping({ timestamp: null, level: null, message: null }) }),
    );
    expect(sql).not.toContain('WHERE');
  });

  it('omits ORDER BY when no timestamp column was detected', () => {
    const sql = buildLogQuery(opts({ fieldMapping: mapping({ timestamp: null }) }));
    expect(sql).not.toContain('ORDER BY');
  });
});

describe('buildLogQuery — time range', () => {
  it('emits a relative interval condition', () => {
    const sql = buildLogQuery(opts({ timeRange: createRelativeTimeRange(15) }));
    expect(sql).toContain("time >= NOW() - INTERVAL '15 minutes'");
  });

  it('emits both bounds for an absolute range', () => {
    const sql = buildLogQuery(
      opts({ timeRange: createAbsoluteTimeRange('2026-01-01 00:00:00', '2026-01-02 00:00:00') }),
    );
    expect(sql).toContain("time >= '2026-01-01 00:00:00'");
    expect(sql).toContain("time <= '2026-01-02 00:00:00'");
  });

  it('emits only the bound that is set', () => {
    const sql = buildLogQuery(opts({ timeRange: { type: 'absolute', start: '2026-01-01' } }));
    expect(sql).toContain("time >= '2026-01-01'");
    expect(sql).not.toContain('<=');
  });
});

describe('buildLogQuery — level filter', () => {
  it('uppercases both the column and the values so matching is case-insensitive', () => {
    const sql = buildLogQuery(opts({ levels: ['error', 'warn'] }));
    expect(sql).toContain("UPPER(level) IN ('ERROR', 'WARN')");
  });

  it('is skipped when no levels are selected', () => {
    expect(buildLogQuery(opts({ levels: [] }))).not.toContain('UPPER(');
  });

  it('is skipped when no level column was detected', () => {
    const sql = buildLogQuery(opts({ levels: ['error'], fieldMapping: mapping({ level: null }) }));
    expect(sql).not.toContain('UPPER(');
  });
});

describe('buildLogQuery — text search', () => {
  it('uses ILIKE with wildcards on both sides', () => {
    expect(buildLogQuery(opts({ searchText: 'timeout' }))).toContain(
      "message ILIKE '%timeout%'",
    );
  });

  it('trims the search text', () => {
    expect(buildLogQuery(opts({ searchText: '  timeout  ' }))).toContain("ILIKE '%timeout%'");
  });

  it('is skipped for whitespace-only search text', () => {
    expect(buildLogQuery(opts({ searchText: '   ' }))).not.toContain('ILIKE');
  });

  // The builder interpolates into SQL, so quote escaping is the thing that
  // keeps a search box from producing broken (or hostile) SQL.
  it("doubles single quotes so a quote in the search text cannot break out", () => {
    const sql = buildLogQuery(opts({ searchText: "it's" }));
    expect(sql).toContain("ILIKE '%it''s%'");
  });

  it('escapes a quote-and-semicolon injection attempt', () => {
    const sql = buildLogQuery(opts({ searchText: "'; DROP TABLE logs; --" }));
    expect(sql).toContain("''; DROP TABLE logs; --");
    expect(sql).not.toContain("'%'; DROP");
  });
});

describe('buildLogQuery — identifier quoting', () => {
  it('leaves a simple identifier unquoted', () => {
    expect(buildLogQuery(opts({ measurement: 'app_logs' }))).toContain('FROM app_logs');
  });

  it('quotes an identifier containing a dot', () => {
    expect(buildLogQuery(opts({ measurement: 'mydb.logs' }))).toContain('FROM "mydb.logs"');
  });

  it('quotes an identifier starting with a digit', () => {
    expect(buildLogQuery(opts({ measurement: '2026_logs' }))).toContain('FROM "2026_logs"');
  });

  it('leaves an already-quoted identifier alone', () => {
    expect(buildLogQuery(opts({ measurement: '"pre.quoted"' }))).toContain('FROM "pre.quoted"');
  });

  it('escapes an embedded double quote by doubling it', () => {
    expect(buildLogQuery(opts({ measurement: 'we"ird' }))).toContain('FROM "we""ird"');
  });
});

describe('time range helpers', () => {
  it('createRelativeTimeRange carries the minutes', () => {
    expect(createRelativeTimeRange(30)).toEqual({ type: 'relative', relativeMinutes: 30 });
  });

  it('createAbsoluteTimeRange carries both bounds', () => {
    expect(createAbsoluteTimeRange('a', 'b')).toEqual({ type: 'absolute', start: 'a', end: 'b' });
  });

  it('exposes presets in ascending order, ending with the custom sentinel', () => {
    const values = TIME_RANGE_PRESETS.map((p) => p.value);
    expect(values.at(-1)).toBe(-1);
    const real = values.slice(0, -1);
    expect(real).toEqual([...real].sort((a, b) => a - b));
  });
});
