import { describe, it, expect } from 'vitest';
import { filterDashboards } from './filter';
import type { DashboardSummary } from './model';

function summary(over: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    uid: 'u1',
    title: 'Production Overview',
    description: 'Fleet health',
    tags: ['prod', 'fleet'],
    instanceIds: ['inst-1'],
    version: 1,
    createdBy: 'u',
    updatedBy: 'u',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('filterDashboards', () => {
  const list = [
    summary({ uid: 'a', title: 'Production Overview', tags: ['prod'] }),
    summary({ uid: 'b', title: 'Staging', tags: ['staging', 'prod'] }),
    summary({ uid: 'c', title: 'Ingest Latency', tags: [] }),
  ];

  it('returns everything for an empty query', () => {
    expect(filterDashboards(list, '')).toHaveLength(3);
  });

  it('returns everything for a whitespace-only query', () => {
    expect(filterDashboards(list, '   ')).toHaveLength(3);
  });

  it('matches the title case-insensitively', () => {
    expect(filterDashboards(list, 'PRODUCTION').map((d) => d.uid)).toEqual(['a']);
  });

  it('matches a tag', () => {
    expect(filterDashboards(list, 'staging').map((d) => d.uid)).toEqual(['b']);
  });

  it('matches title or tag, across different rows', () => {
    expect(filterDashboards(list, 'prod').map((d) => d.uid)).toEqual(['a', 'b']);
  });

  it('returns a row matching both title and tag exactly once', () => {
    const both = [summary({ uid: 'x', title: 'prod dashboard', tags: ['prod'] })];
    expect(filterDashboards(both, 'prod')).toHaveLength(1);
  });

  it('returns nothing when neither matches', () => {
    expect(filterDashboards(list, 'nonesuch')).toEqual([]);
  });

  it('handles a row with no tags', () => {
    expect(filterDashboards(list, 'latency').map((d) => d.uid)).toEqual(['c']);
  });

  it('trims the query before matching', () => {
    expect(filterDashboards(list, '  staging  ').map((d) => d.uid)).toEqual(['b']);
  });

  it('does not match on description', () => {
    // Including description would make a short query match nearly everything.
    expect(filterDashboards(list, 'Fleet health')).toEqual([]);
  });

  it('does not mutate or alias the input list', () => {
    const out = filterDashboards(list, '');
    expect(out).not.toBe(list);
    expect(list).toHaveLength(3);
  });
});
