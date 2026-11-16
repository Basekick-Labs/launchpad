import { describe, expect, it } from 'vitest';
import { formatAge, formatBytes, formatCount, formatDurationMs, formatUptime } from './format';

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

describe('formatDurationMs', () => {
  it('keeps the precision that matters at each size', () => {
    expect([0, 850, 1500, 59_949, 125_000, 3_660_000].map(formatDurationMs)).toEqual(['0 ms', '850 ms', '1.5 s', '59.9 s', '2m 5s', '1h 1m']);
  });
  it('dashes values it cannot show', () => {
    expect([null, undefined, NaN, -1].map(formatDurationMs)).toEqual(['—', '—', '—', '—']);
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

describe('formatCount', () => {
  it('groups digits', () => {
    expect(formatCount(1234567)).toBe(new Intl.NumberFormat().format(1234567));
    expect(formatCount(undefined)).toBe('—');
  });
});
