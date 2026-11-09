import { describe, expect, it } from 'vitest';
import {
  isUnlimited,
  limitText,
  mergePolicies,
  parseLimitsInput,
  parsePolicy,
  parseUsage,
  queryFailure,
  UNLIMITED,
  usageLines,
  validateLimits,
  effectiveOn,
  type Limits,
  type NodeGovernance,
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

describe('validation', () => {
  it('accepts whole numbers from 0, rejects the rest', () => {
    expect(validateLimits(limits({ max_rows_per_query: 10_000 }))).toBeNull();
    expect(validateLimits({ ...limits(), rate_limit_per_minute: -1 })).toHaveProperty('rate_limit_per_minute');
    expect(validateLimits({ ...limits(), max_scan_duration_sec: 1.5 })).toHaveProperty('max_scan_duration_sec');
  });

  it('parses request bodies strictly', () => {
    expect(parseLimitsInput(limits({ max_queries_per_day: 500 }))).toEqual(limits({ max_queries_per_day: 500 }));
    expect(parseLimitsInput({ ...limits(), token_id: 3 })).toBeNull(); // the token comes from the path
    expect(parseLimitsInput({ rate_limit_per_minute: 5 })).toBeNull(); // every field, as Arc replaces the whole policy
  });
});

describe('mergePolicies', () => {
  const p = (tokenId: number, o: Partial<Limits>) => ({ tokenId, ...limits(o) });
  const node = (nodeId: string, policies: ReturnType<typeof p>[], extra: Partial<NodeGovernance> = {}): NodeGovernance =>
    ({ nodeId, source: null, servesQueries: true, state: 'on', reason: null, policies, defaults: null, ...extra });

  it('is in sync only when every query-serving node holds the same limits', () => {
    const same = mergePolicies([node('a', [p(5, { rate_limit_per_minute: 60 })]), node('b', [p(5, { rate_limit_per_minute: 60 })])]);
    expect(same).toEqual([{ tokenId: 5, byNode: { a: limits({ rate_limit_per_minute: 60 }), b: limits({ rate_limit_per_minute: 60 }) }, inSync: true, limits: limits({ rate_limit_per_minute: 60 }) }]);
  });

  it('shows each node\'s values when they differ or one lacks it, with no majority vote', () => {
    const [v] = mergePolicies([
      node('a', [p(5, { rate_limit_per_minute: 60 })]),
      node('b', [p(5, { rate_limit_per_minute: 60 })]),
      node('c', [p(5, { rate_limit_per_minute: 10 })]),
      node('d', []),
      node('e', [], { state: 'unreachable' }),
    ]);
    expect(v.inSync).toBe(false);
    expect(v.limits).toBeNull();
    expect(v.byNode).toEqual({ a: limits({ rate_limit_per_minute: 60 }), b: limits({ rate_limit_per_minute: 60 }), c: limits({ rate_limit_per_minute: 10 }), d: null });
  });

  it('leaves compactors out of the comparison', () => {
    const [v] = mergePolicies([node('a', [p(5, { max_rows_per_query: 100 })]), node('k', [], { servesQueries: false })]);
    expect(v.inSync).toBe(true);
  });
});

describe('effectiveOn', () => {
  const base: NodeGovernance = { nodeId: 'a', source: null, servesQueries: true, state: 'on', reason: null, policies: [], defaults: null };

  it('uses the token\'s policy, else the node\'s defaults, else nothing', () => {
    expect(effectiveOn({ ...base, policies: [{ tokenId: 5, ...limits() }] }, 5)).toEqual({ limits: UNLIMITED, from: 'policy' }); // all zeros = exempt
    expect(effectiveOn({ ...base, defaults: limits({ max_queries_per_day: 1000 }) }, 5)).toEqual({ limits: limits({ max_queries_per_day: 1000 }), from: 'defaults' });
    expect(effectiveOn(base, 5)).toEqual({ limits: UNLIMITED, from: 'none' });
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

  it('treats no policy as unlimited', () => {
    expect(usageLines(null, usage).every((l) => l.state === 'unlimited')).toBe(true);
    expect(isUnlimited(UNLIMITED)).toBe(true);
    expect(limitText('max_rows_per_query', 5000)).toBe('5,000 rows');
  });
});

describe('queryFailure', () => {
  it('names governance throttling instead of reading it as no results', () => {
    expect(queryFailure(429, '12')).toBe('Throttled by Arc query governance (retry after 12s)');
    expect(queryFailure(429, undefined)).toBe('Throttled by Arc query governance');
    expect(queryFailure(500, undefined)).toBe('Arc answered 500');
  });
});
