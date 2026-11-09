import { describe, expect, it } from 'vitest';
import {
  isUnlimited,
  limitText,
  mergePolicies,
  parsePolicy,
  parseUsage,
  UNLIMITED,
  usageLines,
  type Limits,
  type NodePolicies,
} from './governance';

const limits = (o: Partial<Limits> = {}): Limits => ({ ...UNLIMITED, ...o });

describe('parsing', () => {
  it('reads Arc policies and drops malformed ones', () => {
    expect(parsePolicy({ id: 1, token_id: 7, rate_limit_per_minute: 60, max_rows_per_query: -5, max_queries_per_day: 'x' }))
      .toEqual({ tokenId: 7, ...limits({ rate_limit_per_minute: 60 }) });
    expect(parsePolicy({ token_id: 0 })).toBeNull();
    expect(parsePolicy(null)).toBeNull();
  });

  it('reads usage', () => {
    expect(parseUsage({ queries_this_hour: 3, queries_this_day: 9, hour_reset_at: '2026-11-09T20:00:00Z', day_reset_at: 'bad', rate_limit_remaining_per_minute: 57, rate_limit_remaining_per_hour: 0 }))
      .toEqual({ queriesThisHour: 3, queriesThisDay: 9, hourResetAt: '2026-11-09T20:00:00Z', dayResetAt: null, remainingPerMinute: 57, remainingPerHour: 0 });
  });
});

describe('mergePolicies', () => {
  const p = (tokenId: number, o: Partial<Limits>) => ({ tokenId, ...limits(o) });
  const node = (nodeId: string, policies: ReturnType<typeof p>[], extra: Partial<NodePolicies> = {}): NodePolicies =>
    ({ nodeId, servesQueries: true, state: 'on', policies, ...extra });
  const rpm = (v: number) => limits({ rate_limit_per_minute: v });

  it('is in sync only when every query-serving node holds the same limits', () => {
    const [v] = mergePolicies([node('a', [p(5, { rate_limit_per_minute: 60 })]), node('b', [p(5, { rate_limit_per_minute: 60 })])]);
    expect(v).toMatchObject({ tokenId: 5, byNode: { a: rpm(60), b: rpm(60) }, inSync: true, unknownOn: [] });
    expect(v.shared).toEqual(rpm(60));
  });

  it('shows each node\'s values when they differ or one lacks it, with no majority vote', () => {
    const [v] = mergePolicies([
      node('a', [p(5, { rate_limit_per_minute: 60 })]),
      node('b', [p(5, { rate_limit_per_minute: 60 })]),
      node('c', [p(5, { rate_limit_per_minute: 10 })]),
      node('d', []),
    ]);
    expect(v.inSync).toBe(false);
    expect(v.shared.rate_limit_per_minute).toBeNull();
    expect(v.shared.max_rows_per_query).toBeNull(); // d has no policy at all
    expect(v.byNode).toEqual({ a: rpm(60), b: rpm(60), c: rpm(10), d: null });
  });

  it('is not in sync while a query-serving node did not answer', () => {
    const [v] = mergePolicies([node('a', [p(5, { rate_limit_per_minute: 60 })]), node('e', [], { state: 'unreachable' }), node('f', [], { state: 'off' })]);
    expect(v).toMatchObject({ inSync: false, unknownOn: ['e', 'f'] });
    expect(v.shared).toEqual(rpm(60)); // the nodes that answered agree
  });

  it('leaves compactors out of the comparison', () => {
    const [v] = mergePolicies([node('a', [p(5, { max_rows_per_query: 100 })]), node('k', [], { servesQueries: false }), node('k2', [], { servesQueries: false, state: 'unreachable' })]);
    expect(v.inSync).toBe(true);
    expect(v.byNode).toHaveProperty('k', null);
  });

  it('is not in sync when only compactors hold the policy', () => {
    const [v] = mergePolicies([node('a', []), node('k', [p(5, {})], { servesQueries: false })]);
    expect(v.inSync).toBe(false);
  });
});

describe('usageLines', () => {
  const usage = { queriesThisHour: 9, queriesThisDay: 40, hourResetAt: null, dayResetAt: null, remainingPerMinute: 0, remainingPerHour: 0 };

  it('tells an exhausted limit from an unset one, although Arc reports remaining 0 for both', () => {
    const lines = usageLines(limits({ rate_limit_per_minute: 30, max_queries_per_hour: 10 }), usage);
    expect(lines.map((l) => [l.field, l.state, l.used])).toEqual([
      ['rate_limit_per_minute', 'exhausted', 30],
      ['rate_limit_per_hour', 'unlimited', null],
      ['max_queries_per_hour', 'near', 9],
      ['max_queries_per_day', 'unlimited', null], // not tracked without a daily quota
    ]);
  });

  it('never reports negative use when the limit changed between reads', () => {
    const [line] = usageLines(limits({ rate_limit_per_minute: 10 }), { ...usage, remainingPerMinute: 30 });
    expect(line).toMatchObject({ used: 0, state: 'ok' });
  });

  it('treats no policy as unlimited', () => {
    expect(usageLines(null, usage).every((l) => l.state === 'unlimited')).toBe(true);
    expect(isUnlimited(UNLIMITED)).toBe(true);
    expect(limitText('max_rows_per_query', 5000)).toBe('5,000 rows');
  });
});
