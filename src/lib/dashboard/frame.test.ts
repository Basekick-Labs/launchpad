import { describe, it, expect } from 'vitest';
import {
  normalizeFrame,
  toWide,
  toAligned,
  parseTimestamp,
  detectEpochUnit,
  type Field,
  type Frame,
} from './frame';
import { LIMITS } from './model';

function numberValues(frame: Frame, name: string): (number | null)[] {
  const f = frame.fields.find((x) => x.name === name);
  if (!f || f.type !== 'number') throw new Error(`no numeric field "${name}"`);
  return f.values;
}

function timeValues(frame: Frame): Float64Array {
  const f = frame.fields[frame.timeFieldIndex] as Extract<Field, { type: 'time' }>;
  return f.values;
}

// ===========================================================================
// Timestamps
// ===========================================================================

describe('parseTimestamp', () => {
  it('reads a zoneless timestamp as UTC, not local', () => {
    // The single easiest thing here to get silently wrong: `Date.parse` treats
    // this as LOCAL in V8, so the chart would shift by the viewer's offset —
    // and by a different amount for two viewers.
    expect(parseTimestamp('2025-10-28T16:03:25')).toBe(Date.UTC(2025, 9, 28, 16, 3, 25));
  });

  it('reads the space-separated form as UTC too', () => {
    expect(parseTimestamp('2025-10-28 16:03:25')).toBe(Date.UTC(2025, 9, 28, 16, 3, 25));
  });

  it('parses a whole-second RFC3339 value with no fractional part', () => {
    // RFC3339Nano trims trailing zeros, so $__timeGroup output looks like this.
    // A pattern demanding six fraction digits would fail on most rows.
    expect(parseTimestamp('2025-10-28T16:00:00Z')).toBe(Date.UTC(2025, 9, 28, 16, 0, 0));
  });

  it.each([
    ['2025-10-28T16:03:25.4Z', 400],
    ['2025-10-28T16:03:25.43Z', 430],
    ['2025-10-28T16:03:25.431Z', 431],
    ['2025-10-28T16:03:25.431002Z', 431],
    ['2025-10-28T16:03:25.431002001Z', 431],
  ])('accepts %s and keeps millisecond precision', (input, ms) => {
    expect(parseTimestamp(input)).toBe(Date.UTC(2025, 9, 28, 16, 3, 25) + ms);
  });

  it('applies a numeric offset', () => {
    expect(parseTimestamp('2025-10-28T16:03:25+02:00')).toBe(
      Date.UTC(2025, 9, 28, 14, 3, 25),
    );
    expect(parseTimestamp('2025-10-28T16:03:25-0300')).toBe(Date.UTC(2025, 9, 28, 19, 3, 25));
  });

  it('accepts the date-only form CAST(date AS VARCHAR) produces', () => {
    expect(parseTimestamp('2025-10-28')).toBe(Date.UTC(2025, 9, 28));
  });

  it.each([['not a date'], [''], ['2025-13-99T99:99:99Z'], ['16:03:25']])(
    'rejects %j',
    (input) => {
      const parsed = parseTimestamp(input);
      expect(parsed === null || Number.isNaN(parsed)).toBe(true);
    },
  );
});

describe('detectEpochUnit', () => {
  it.each([
    [[1761667405], 's'],
    [[1761667405431], 'ms'],
    [[1761667405431002], 'us'],
    [[1761667405431002001], 'ns'],
  ] as const)('classifies %j as %s', (samples, unit) => {
    expect(detectEpochUnit([...samples])).toBe(unit);
  });

  it('classifies negative epochs by magnitude, not sign', () => {
    // Without Math.abs every negative epoch reads as seconds, so a millisecond
    // value lands decades away.
    expect(detectEpochUnit([-1761667405431])).toBe('ms');
  });

  it('uses the median, so one anomalous value does not flip the column', () => {
    // A gap-filled 0 or a COALESCE sentinel would otherwise land in 1970 while
    // its neighbours are in 2025, stretching the axis across 55 years.
    expect(detectEpochUnit([0, 1761667405431, 1761667405432, 1761667405433])).toBe('ms');
  });
});

// ===========================================================================
// Type inference
// ===========================================================================

describe('type inference', () => {
  it('detects wide shape: time plus numerics', () => {
    const frame = normalizeFrame({
      columns: ['time', 'cpu', 'mem'],
      rows: [['2025-10-28T16:00:00Z', 1, 2]],
    });
    expect(frame.shape).toBe('wide');
    expect(frame.timeFieldIndex).toBe(0);
    expect(frame.numericFieldIndices).toEqual([1, 2]);
  });

  it('detects long shape: time, label, value', () => {
    const frame = normalizeFrame({
      columns: ['time', 'host', 'value'],
      rows: [['2025-10-28T16:00:00Z', 'web-1', 1]],
    });
    expect(frame.shape).toBe('long');
    expect(frame.stringFieldIndices).toEqual([1]);
  });

  it('detects table shape when nothing is numeric', () => {
    const frame = normalizeFrame({
      columns: ['time', 'level', 'message'],
      rows: [['2025-10-28T16:00:00Z', 'ERROR', 'boom']],
    });
    expect(frame.shape).toBe('table');
  });

  it('detects empty shape but still produces typed fields', () => {
    // A fieldless empty frame would make a panel rebuild its axes and legend on
    // every empty refresh tick.
    const frame = normalizeFrame({ columns: ['time', 'cpu'], rows: [] });
    expect(frame.shape).toBe('empty');
    expect(frame.fields).toHaveLength(2);
    expect(frame.fields[0].type).toBe('time');
  });

  it('honours an explicit shape over inference', () => {
    // The panel's target already declares what it wants; guessing is the
    // fallback, not the contract.
    const frame = normalizeFrame(
      { columns: ['time', 'host', 'value'], rows: [['2025-10-28T16:00:00Z', 'a', 1]] },
      { shape: 'table' },
    );
    expect(frame.shape).toBe('table');
  });

  it('skips leading nulls when inferring', () => {
    const frame = normalizeFrame({
      columns: ['v'],
      rows: [[null], [null], [42]],
    });
    expect(frame.fields[0].type).toBe('number');
  });

  it('types an all-null column as string without scanning every row', () => {
    const rows = Array.from({ length: LIMITS.maxTypeScanRows * 3 }, () => [null]);
    const frame = normalizeFrame({ columns: ['v'], rows });
    expect(frame.fields[0].type).toBe('string');
    expect(frame.length).toBe(rows.length);
  });

  it('collapses a mixed column to string and says how many were off', () => {
    const frame = normalizeFrame({
      columns: ['v'],
      rows: [[1], [2], ['n/a']],
    });
    expect(frame.fields[0].type).toBe('string');
  });

  it('does not treat a column merely named "time" as a timestamp when it is text', () => {
    const frame = normalizeFrame({ columns: ['time'], rows: [['morning'], ['evening']] });
    expect(frame.fields[0].type).toBe('string');
  });

  it('treats a numeric column named "time" as a timestamp', () => {
    const frame = normalizeFrame({ columns: ['time'], rows: [[1761667405]] });
    expect(frame.fields[0].type).toBe('time');
    expect(timeValues(frame)[0]).toBe(1761667405000);
  });

  it('does not retype a large plain counter as a timestamp', () => {
    const frame = normalizeFrame({ columns: ['bytes_total'], rows: [[1761667405431]] });
    expect(frame.fields[0].type).toBe('number');
  });

  it('decodes msgpack Date objects', () => {
    const d = new Date('2025-10-28T16:00:00Z');
    const frame = normalizeFrame({ columns: ['time'], rows: [[d]] });
    expect(timeValues(frame)[0]).toBe(d.getTime());
  });

  it('uses only the first time column as x', () => {
    const frame = normalizeFrame({
      columns: ['time', 'updated_at', 'value'],
      rows: [['2025-10-28T16:00:00Z', '2025-10-28T17:00:00Z', 1]],
    });
    expect(frame.timeFieldIndex).toBe(0);
    expect(frame.fields[1].type).toBe('time');
    expect(frame.shape).toBe('wide');
  });
});

describe('numeric strings (Arc decimal compatibility)', () => {
  it('reads a column of numeric strings as numbers', () => {
    // Arc's JSON endpoint returns DECIMAL as strings, so avg()/sum() arrive
    // like this — see Basekick-Labs/arc#818. Without this rung the most
    // ordinary dashboard query yields no numeric column and renders nothing.
    const frame = normalizeFrame({
      columns: ['time', 'avg_cpu'],
      rows: [
        ['2025-10-28T16:00:00Z', '3.14'],
        ['2025-10-28T16:05:00Z', '2.71'],
      ],
    });
    expect(frame.shape).toBe('wide');
    expect(numberValues(frame, 'avg_cpu')).toEqual([3.14, 2.71]);
  });

  it('reports that it did so', () => {
    const frame = normalizeFrame({ columns: ['n'], rows: [['1'], ['2']] });
    expect(frame.notices.some((n) => n.code === 'numeric-strings')).toBe(true);
  });

  it('keeps the raw values when precision would be lost', () => {
    const big = '123456789012345678901';
    const frame = normalizeFrame({ columns: ['n'], rows: [[big]] });
    const field = frame.fields[0];
    expect(field.type).toBe('number');
    expect(field.raw?.[0]).toBe(big);
  });
});

// ===========================================================================
// Robustness
// ===========================================================================

describe('ragged and exotic input', () => {
  it('does not let a short row retype the column', () => {
    // A short row yields `undefined`, not `null`; a strict null check would let
    // it fall through to the string branch and retype the whole column.
    const frame = normalizeFrame({
      columns: ['time', 'v'],
      rows: [['2025-10-28T16:00:00Z', 1], ['2025-10-28T16:05:00Z']],
    });
    expect(frame.fields[1].type).toBe('number');
    expect(numberValues(frame, 'v')).toEqual([1, null]);
    expect(frame.notices.some((n) => n.code === 'short-rows')).toBe(true);
  });

  it('renders object cells as JSON, not [object Object]', () => {
    const frame = normalizeFrame({ columns: ['v'], rows: [[{ a: 1 }], ['x']] });
    expect((frame.fields[0] as Extract<Field, { type: 'string' }>).values[0]).toBe('{"a":1}');
  });

  it('nulls out non-finite numbers', () => {
    const frame = normalizeFrame({ columns: ['v'], rows: [[1], [Number.NaN], [Infinity]] });
    expect(numberValues(frame, 'v')).toEqual([1, null, null]);
  });

  it('reports an unsorted time column rather than silently sorting it', () => {
    // uPlot binary-searches x: unsorted input does not throw, it returns a
    // wrong index, so the tooltip reads a random row.
    const frame = normalizeFrame({
      columns: ['time', 'v'],
      rows: [
        ['2025-10-28T16:05:00Z', 1],
        ['2025-10-28T16:00:00Z', 2],
      ],
    });
    expect(frame.notices.some((n) => n.code === 'unsorted')).toBe(true);
    expect(timeValues(frame)[0]).toBeGreaterThan(timeValues(frame)[1]);
  });

  it('surfaces Arc-side truncation', () => {
    const frame = normalizeFrame({
      columns: ['v'],
      rows: [[1]],
      rowsCapped: true,
      truncationReason: 'row cap of 10000 reached',
    });
    expect(frame.notices.some((n) => n.code === 'truncated')).toBe(true);
  });

  it('caps very large results and says so', () => {
    const rows = Array.from({ length: LIMITS.maxFrameRows + 10 }, (_, i) => [i]);
    const frame = normalizeFrame({ columns: ['v'], rows });
    expect(frame.length).toBe(LIMITS.maxFrameRows);
    expect(frame.notices.some((n) => n.code === 'truncated')).toBe(true);
  });

  it('bounds the notice list', () => {
    const columns = Array.from({ length: 300 }, (_, i) => `c${i}`);
    const rows = [columns.map(() => 1), []];
    const frame = normalizeFrame({ columns, rows });
    expect(frame.notices.length).toBeLessThanOrEqual(LIMITS.maxWarnings);
  });

  it('keeps every field the same length as the frame', () => {
    const frame = normalizeFrame({
      columns: ['time', 'a', 'b'],
      rows: [['2025-10-28T16:00:00Z', 1, 'x'], ['2025-10-28T16:05:00Z']],
    });
    for (const f of frame.fields) expect(f.values.length).toBe(frame.length);
  });
});

// ===========================================================================
// Pivot
// ===========================================================================

describe('toWide', () => {
  const longFrame = () =>
    normalizeFrame({
      columns: ['time', 'host', 'value'],
      rows: [
        ['2025-10-28T16:00:00Z', 'web-1', 1],
        ['2025-10-28T16:00:00Z', 'web-2', 10],
        ['2025-10-28T16:05:00Z', 'web-1', 2],
        ['2025-10-28T16:05:00Z', 'web-2', 20],
      ],
    });

  it('pivots one series per label', () => {
    const wide = toWide(longFrame());
    expect(wide.shape).toBe('wide');
    expect(wide.fields.map((f) => f.name)).toEqual(['time', 'web-1', 'web-2']);
    expect(numberValues(wide, 'web-1')).toEqual([1, 2]);
    expect(numberValues(wide, 'web-2')).toEqual([10, 20]);
  });

  it('fills gaps with null so uPlot draws a gap, not a line through zero', () => {
    const frame = normalizeFrame({
      columns: ['time', 'host', 'value'],
      rows: [
        ['2025-10-28T16:00:00Z', 'a', 1],
        ['2025-10-28T16:05:00Z', 'b', 2],
      ],
    });
    const wide = toWide(frame);
    expect(numberValues(wide, 'a')).toEqual([1, null]);
    expect(numberValues(wide, 'b')).toEqual([null, 2]);
  });

  it('sorts the timestamp axis numerically', () => {
    // A default .sort() compares as strings, which reorders epoch millis.
    const frame = normalizeFrame({
      columns: ['time', 'host', 'value'],
      rows: [
        ['2025-10-28T16:05:00Z', 'a', 2],
        ['2025-10-28T16:00:00Z', 'a', 1],
      ],
    });
    const axis = timeValues(toWide(frame));
    expect(axis[0]).toBeLessThan(axis[1]);
  });

  it('produces the same field order regardless of row order', () => {
    // #30 assigns palette colours by field index, so an unstable order
    // re-colours the whole chart on every refresh tick.
    const a = toWide(
      normalizeFrame({
        columns: ['time', 'host', 'value'],
        rows: [
          ['2025-10-28T16:00:00Z', 'zulu', 1],
          ['2025-10-28T16:00:00Z', 'alpha', 2],
        ],
      }),
    );
    const b = toWide(
      normalizeFrame({
        columns: ['time', 'host', 'value'],
        rows: [
          ['2025-10-28T16:00:00Z', 'alpha', 2],
          ['2025-10-28T16:00:00Z', 'zulu', 1],
        ],
      }),
    );
    expect(a.fields.map((f) => f.name)).toEqual(b.fields.map((f) => f.name));
  });

  it('appends the value-field name only when there is more than one', () => {
    const single = toWide(longFrame());
    expect(single.fields[1].name).toBe('web-1');

    const multi = toWide(
      normalizeFrame({
        columns: ['time', 'host', 'cpu', 'mem'],
        rows: [['2025-10-28T16:00:00Z', 'web-1', 1, 2]],
      }),
    );
    expect(multi.fields.map((f) => f.name)).toEqual(['time', 'web-1 cpu', 'web-1 mem']);
  });

  it('carries labels through', () => {
    expect(toWide(longFrame()).fields[1].labels).toEqual({ host: 'web-1' });
  });

  it('reports duplicate timestamps within a series instead of losing them silently', () => {
    const frame = normalizeFrame({
      columns: ['time', 'host', 'value'],
      rows: [
        ['2025-10-28T16:00:00Z', 'a', 1],
        ['2025-10-28T16:00:00Z', 'a', 2],
      ],
    });
    const wide = toWide(frame);
    expect(wide.notices.some((n) => n.code === 'duplicate-timestamps')).toBe(true);
    expect(numberValues(wide, 'a')).toEqual([2]);
  });

  it('refuses a pivot that would allocate too many cells', () => {
    // Capping series alone is the wrong axis: 256 series x 100k timestamps is
    // 25.6M slots, allocated before any cap notice could be written.
    // Few rows, many cells: each row adds one distinct timestamp AND cycles
    // through the series, so 3000 rows yields 400 x 3000 = 1.2M cells.
    const series = 400;
    const rowCount = 3000;
    const rows: unknown[][] = Array.from({ length: rowCount }, (_, r) => [
      Date.UTC(2025, 0, 1) + r * 1000,
      `s${r % series}`,
      1,
    ]);
    const frame = normalizeFrame({ columns: ['time', 'host', 'value'], rows });
    const wide = toWide(frame);
    expect(wide.notices.some((n) => n.code === 'series-capped')).toBe(true);
    expect(wide.shape).toBe('long');
  });

  it('returns the identical object when already wide', () => {
    // A fresh object would re-trigger every `$:` in the panel and defeat #29's
    // frame cache.
    const wide = normalizeFrame({
      columns: ['time', 'cpu'],
      rows: [['2025-10-28T16:00:00Z', 1]],
    });
    expect(toWide(wide)).toBe(wide);
    expect(toWide(toWide(wide))).toBe(wide);
  });
});

// ===========================================================================
// uPlot handoff
// ===========================================================================

describe('toAligned', () => {
  it('returns x first, then each numeric field in order', () => {
    const frame = normalizeFrame({
      columns: ['time', 'cpu', 'mem'],
      rows: [
        ['2025-10-28T16:00:00Z', 1, 2],
        ['2025-10-28T16:05:00Z', 3, 4],
      ],
    });
    const [x, ...ys] = toAligned(frame);
    expect(Array.from(x)).toEqual([
      Date.UTC(2025, 9, 28, 16, 0, 0),
      Date.UTC(2025, 9, 28, 16, 5, 0),
    ]);
    expect(ys).toEqual([
      [1, 3],
      [2, 4],
    ]);
  });

  it('gives x as a Float64Array and y as plain arrays', () => {
    // uPlot accepts a typed array for x, but its gap detection is strictly
    // `=== null`, which a typed array cannot carry.
    // The column needs at least one real value, or it infers as a string
    // column and there is no numeric field to hand uPlot at all.
    const frame = normalizeFrame({
      columns: ['time', 'cpu'],
      rows: [
        ['2025-10-28T16:00:00Z', null],
        ['2025-10-28T16:05:00Z', 1],
      ],
    });
    const [x, y] = toAligned(frame);
    expect(x).toBeInstanceOf(Float64Array);
    expect(Array.isArray(y)).toBe(true);
    expect(y[0]).toBeNull();
  });

  it('pivots a long frame on the way through', () => {
    const frame = normalizeFrame({
      columns: ['time', 'host', 'value'],
      rows: [['2025-10-28T16:00:00Z', 'web-1', 1]],
    });
    expect(toAligned(frame)).toHaveLength(2);
  });
});
