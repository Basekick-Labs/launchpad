import { describe, expect, it } from 'vitest';
import { formatAge, formatBytes, formatCount, formatRate, formatUptime } from './format';

describe('formatBytes', () => {
  it('picks binary units', () => {
    expect([0, 1023, 1536, 5 * 1024 ** 2, 3 * 1024 ** 3, 2 * 1024 ** 4].map(formatBytes)).toEqual(
      ['0 B', '1023 B', '1.5 KB', '5.0 MB', '3.00 GB', '2.00 TB'],
    );
  });
  it('falls back for missing or invalid input', () => {
    expect([null, undefined, NaN, Infinity, -1].map(formatBytes)).toEqual(['—', '—', '—', '—', '—']);
  });
});

describe('formatUptime', () => {
  it('shows the two largest units', () => {
    expect([59, 3660, 90061].map(formatUptime)).toEqual(['0m', '1h 1m', '1d 1h']);
  });
  it('falls back for invalid input', () => {
    expect(formatUptime(-5)).toBe('—');
  });
});

describe('formatAge', () => {
  it('reads as elapsed time', () => {
    expect([500, 4200, 125_000, 7_200_000, 172_800_000].map(formatAge)).toEqual(
      ['just now', '4s ago', '2m ago', '2h ago', '2d ago'],
    );
    expect(formatAge(null)).toBe('—');
  });
});

describe('formatRate', () => {
  it('scales with a suffix', () => {
    expect([0, 2.25, 512.4, 1530, 2_500_000].map(formatRate)).toEqual(['0.0/s', '2.3/s', '512/s', '1.5k/s', '2.5M/s']);
    expect(formatRate(-1)).toBe('—');
  });
});

describe('formatCount', () => {
  it('groups digits', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatCount(undefined)).toBe('—');
  });
});
