import { describe, it, expect } from 'vitest';
import {
  formatValue,
  formatter,
  formatAxisTicks,
  formatDuration,
  UNITS,
  isKnownUnit,
} from './units';

const text = (v: number | null | undefined, unit?: string, d?: number) =>
  formatValue(v, unit, d).formatted;

describe('scaling to the value', () => {
  it.each([
    [1023, '1023 B'],
    [1024, '1.0 KiB'],
    [1536, '1.5 KiB'],
    [1048576, '1.0 MiB'],
  ])('bytes %i -> %s', (v, expected) => {
    expect(text(v, 'bytes')).toBe(expected);
  });

  it('scales on magnitude, so negatives scale too', () => {
    // A `while (v >= base)` loop never fires for a negative value, which would
    // render -1536 as "-1536 B".
    expect(text(-1536, 'bytes')).toBe('-1.5 KiB');
  });

  it('steps up when rounding carries across a boundary', () => {
    // 1023.996 at 2 decimals renders "1024.00 B" without a post-rounding check.
    expect(text(1023.996, 'bytes', 2)).toBe('1.00 KiB');
    expect(text(1048575.9, 'bytes', 2)).toBe('1.00 MiB');
  });

  it('uses SI for decbytes and IEC for bytes', () => {
    expect(text(1000, 'decbytes')).toBe('1.0 KB');
    expect(text(1000, 'bytes')).toBe('1000 B');
  });
});

describe('time is one family with four entry points', () => {
  it.each([
    [0.0000005, 's', '500 ns'],
    [0.0023, 's', '2.3 ms'],
    [1.5, 's', '1.5 s'],
    [90, 's', '1.5 min'],
    [4512, 's', '1.3 h'],
  ])('seconds %p -> %s', (v, unit, expected) => {
    expect(text(v, unit)).toBe(expected);
  });

  it('does not divide every nanosecond value by 1e6', () => {
    // MetricChart's bug: `unit === 'ns'` always produced milliseconds, so 2ns
    // rendered as "0.00 ms".
    expect(text(2, 'ns')).toBe('2.0 ns');
    expect(text(2_000_000, 'ns')).toBe('2.0 ms');
  });

  it('reads each entry unit at its own scale', () => {
    expect(text(1500, 'ms')).toBe('1.5 s');
    expect(text(1500, 'us')).toBe('1.5 ms');
  });
});

describe('percent and percentunit', () => {
  it('treats percent as already 0-100', () => {
    expect(text(42, 'percent')).toBe('42%');
    expect(text(0.42, 'percent')).toBe('0.4%');
  });

  it('scales percentunit from 0-1', () => {
    expect(text(0.42, 'percentunit')).toBe('42%');
  });

  it('never applies an SI ladder to a percentage', () => {
    // 1500% is 1500%, not 1.5 K%.
    expect(text(1500, 'percent')).toBe('1500%');
  });
});

describe('automatic decimals', () => {
  it('shows one decimal below 10 and none at or above it', () => {
    // Keeps a column from jittering between 3 and 7 characters as values move.
    // Checked on a scaled unit, since `none` deliberately does not round.
    expect(text(1.5, 'short')).toBe('1.5');
    expect(text(9.94, 'short')).toBe('9.9');
    expect(text(12.4, 'short')).toBe('12');
    expect(text(500, 'short')).toBe('500');
  });

  it('leaves `none` unrounded, only grouped', () => {
    // `none` means "this number, as it is" — rounding it would be a surprise
    // for an id whose whole point is the absence of a unit.
    expect(text(9.94, 'none')).toBe('9.94');
    expect(text(1234567, 'none')).toBe('1,234,567');
  });

  it('honours an explicit decimals argument exactly', () => {
    expect(text(1.5, 'none', 3)).toBe('1.500');
    expect(text(12.4, 'none', 2)).toBe('12.40');
  });
});

describe('numeric edge cases', () => {
  it.each([[null], [undefined], [Number.NaN], [Infinity], [-Infinity]])(
    'renders %p as empty rather than a broken string',
    (v) => {
      expect(text(v as number | null | undefined, 'bytes')).toBe('');
    },
  );

  it('renders zero without a sign or a prefix', () => {
    expect(text(0, 'bytes')).toBe('0 B');
    expect(text(0, 's')).toBe('0 s');
  });

  it('does not render a negative zero', () => {
    expect(text(-0.001, 'none', 2)).toBe('0.00');
  });

  it('does not leak exponential notation past 1e21', () => {
    // toFixed switches to exponential at 1e21 and would put "1e+21" in an axis.
    expect(text(1e21, 'none', 2)).not.toContain('e+');
    expect(text(1.23e22, 'none', 2)).not.toContain('e+');
  });

  it('clamps decimals rather than throwing', () => {
    // toFixed throws a RangeError past 100, which blanks the whole panel.
    expect(() => text(1.5, 'none', 500)).not.toThrow();
    expect(() => text(1.5, 'none', -5)).not.toThrow();
  });

  it('groups large plain numbers with a pinned locale', () => {
    // Unpinned toLocaleString differs per machine, so a test asserting exact
    // output passes locally and fails in CI.
    expect(text(1234567, 'none')).toBe('1,234,567');
  });
});

describe('pinned scale across a set', () => {
  it('formats every tick in one unit', () => {
    // Per-tick scaling gives "900 B / 1.0 KiB / 2.0 KiB", which stops reading
    // as a scale. #40 cannot align a value column without this.
    const ticks = [900, 1024, 2048, 3072];
    const out = formatAxisTicks(ticks, 'bytes');
    const suffixes = new Set(out.map((s) => s.replace(/^[\d.,-]+/, '')));
    expect(suffixes.size).toBe(1);
  });

  it('exposes the pinned suffix for an axis title', () => {
    const f = formatter('bytes', undefined, { min: 0, max: 5_000_000 });
    expect(f.suffix.trim()).toBe('MiB');
  });

  it('is per-value when no range is given', () => {
    const f = formatter('bytes');
    expect(f.text(900)).toBe('900 B');
    expect(f.text(1048576)).toBe('1.0 MiB');
  });

  it('handles an empty tick array', () => {
    expect(formatAxisTicks([], 'bytes')).toEqual([]);
  });
});

describe('formatDuration', () => {
  it.each([
    [4512, '1h 15m'],
    [90, '1m 30s'],
    [86400 * 2 + 3600, '2d 1h'],
  ])('%i seconds -> %s', (v, expected) => {
    expect(formatDuration(v)).toBe(expected);
  });

  it('falls back to value formatting below a second', () => {
    expect(formatDuration(0.25)).toBe('250 ms');
  });

  it('handles nothing', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });
});

describe('the registry', () => {
  it('has unique ids and a group for each', () => {
    const ids = UNITS.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const u of UNITS) expect(u.group).toBeTruthy();
  });

  it('recognises exactly what it lists', () => {
    for (const u of UNITS) expect(isKnownUnit(u.id)).toBe(true);
    expect(isKnownUnit('nonsense')).toBe(false);
    expect(isKnownUnit(null)).toBe(false);
  });

  it('falls back to plain formatting for an unknown unit', () => {
    expect(text(1234, 'nonsense')).toBe('1,234');
  });
});

describe('the split return', () => {
  it('separates the number from its suffix', () => {
    const p = formatValue(1536, 'bytes');
    expect(p.text).toBe('1.5');
    expect(p.suffix).toBe(' KiB');
    expect(p.formatted).toBe('1.5 KiB');
  });

  it('keeps percent tight against its number', () => {
    // The separator rule differs per family, which is why `formatted` is not
    // derivable from text + suffix by the caller.
    const p = formatValue(42, 'percent');
    expect(p.suffix).toBe('%');
    expect(p.formatted).toBe('42%');
  });
});
