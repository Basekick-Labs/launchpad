import { describe, it, expect } from 'vitest';
import {
  applyMacros,
  computeIntervalMs,
  intervalToSeconds,
  validateTimezone,
  resolveTimezone,
  formatIntervalText,
  roundInterval,
  rfc3339,
  isSafeColumnArg,
  MAX_INTERVAL_SECONDS,
  DEFAULT_MAX_DATA_POINTS,
  __internal,
} from './macros';

const FROM = new Date('2024-01-15T10:00:00Z');
const TO = new Date('2024-01-15T16:00:00Z');

/** Default context: 6h range, 10s buckets, UTC — the Go suite's shape. */
const ctx = (over: Partial<Parameters<typeof applyMacros>[1]> = {}) => ({
  from: FROM,
  to: TO,
  intervalMs: 10_000,
  timezone: 'UTC',
  ...over,
});

const expand = (sql: string, over = {}) => applyMacros(sql, ctx(over));

// ===========================================================================
// $__timeFilter — ported from the Go suite
// ===========================================================================

describe('$__timeFilter', () => {
  it('expands to a half-open range', () => {
    // Half-open, not BETWEEN: a closed upper bound double-counts the boundary
    // row when adjacent panels tile a range.
    expect(expand('SELECT * FROM t WHERE $__timeFilter(time)')).toBe(
      "SELECT * FROM t WHERE (time) >= '2024-01-15T10:00:00Z' AND (time) < '2024-01-15T16:00:00Z'",
    );
  });

  it('takes a custom column', () => {
    expect(expand('WHERE $__timeFilter(created_at)')).toContain("(created_at) >= '2024-01-15T10:00:00Z'");
  });

  it('defaults an empty argument to `time`', () => {
    expect(expand('WHERE $__timeFilter()')).toContain("(time) >=");
    expect(expand('WHERE $__timeFilter(   )')).toContain("(time) >=");
  });

  it('expands every occurrence', () => {
    const out = expand('WHERE $__timeFilter(a) OR $__timeFilter(b)');
    expect(out).toContain('(a) >=');
    expect(out).toContain('(b) >=');
    expect(out).not.toContain('$__timeFilter');
  });

  it('handles a nested-paren argument', () => {
    expect(expand('WHERE $__timeFilter(coalesce(a, b))')).toContain('(coalesce(a, b)) >=');
  });

  it.each([
    ["time'", 'opens a literal'],
    ['time; DROP TABLE t', 'terminates the statement'],
    ['time --', 'comments out the tail'],
    ['time /*', 'opens a block comment'],
  ])('leaves the macro unexpanded for an unsafe argument (%s)', (arg) => {
    const out = expand(`WHERE $__timeFilter(${arg})`);
    // Unexpanded, so Arc surfaces a clear parse error rather than running
    // silently-mangled SQL.
    expect(out).toContain('$__timeFilter(');
    expect(out).not.toContain('>=');
  });

  it('extracts the argument at the FIRST matching paren, not the last', () => {
    // `$__timeFilter(time) OR (1=1)` extracts `time` and expands normally; the
    // `OR (1=1)` is the author's own SQL, which they are entitled to write.
    //
    // The Go comment on validateColumnArg's balance check describes this input
    // as parsing to the argument `time) OR (1=1`. It does not, with this
    // extractor — findMatchingParen stops at the first depth-0 paren, so the
    // extracted argument is ALWAYS balanced and the balance check cannot fire.
    // The check is harmless belt-and-braces against a different extractor.
    //
    // It matters for #31: the variable engine interpolates BEFORE macros run,
    // so a variable valued `time) OR (1=1` produces exactly this string and
    // yields a neutralised filter over the whole table. That guard belongs in
    // the variable engine — by the time this module sees it, it is
    // indistinguishable from SQL the author typed.
    expect(expand('WHERE $__timeFilter(time) OR (1=1)')).toBe(
      "WHERE (time) >= '2024-01-15T10:00:00Z' AND (time) < '2024-01-15T16:00:00Z' OR (1=1)",
    );
  });

  it('does not expand inside a string literal', () => {
    const sql = "SELECT * FROM t WHERE msg = 'count of $__timeFilter(time)'";
    expect(expand(sql)).toBe(sql);
  });

  it('does not expand inside a line comment', () => {
    const sql = '-- $__timeFilter(time)\nSELECT 1';
    expect(expand(sql)).toBe(sql);
  });

  it('does not expand inside a block comment', () => {
    const sql = '/* $__timeFilter(time) */ SELECT 1';
    expect(expand(sql)).toBe(sql);
  });

  it('terminates on an unclosed paren instead of looping', () => {
    const out = expand('WHERE $__timeFilter(time');
    expect(out).toContain('$__timeFilter(time');
  });

  it('stops expanding after an unclosed paren, rather than skipping past it', () => {
    // Go early-returns here: the remainder is copied verbatim and no LATER
    // occurrence expands. A port that skips and continues passes the
    // no-infinite-loop test and still diverges on exactly this input.
    const out = expand('WHERE $__timeFilter(a AND $__timeFilter(b)');
    expect(out).not.toContain(">= '2024");
  });
});

// ===========================================================================
// $__timeFrom / $__timeTo
// ===========================================================================

describe('$__timeFrom and $__timeTo', () => {
  it('expand to quoted RFC3339 bounds', () => {
    expect(expand('WHERE t >= $__timeFrom() AND t < $__timeTo()')).toBe(
      "WHERE t >= '2024-01-15T10:00:00Z' AND t < '2024-01-15T16:00:00Z'",
    );
  });

  it('do not expand inside a string literal', () => {
    const sql = "SELECT 'see $__timeFrom()' AS note";
    expect(expand(sql)).toBe(sql);
  });

  it('still expand outside a literal in the same statement', () => {
    const out = expand("SELECT 'see $__timeFrom()' AS note WHERE t >= $__timeFrom()");
    expect(out).toContain("'see $__timeFrom()'");
    expect(out).toContain("t >= '2024-01-15T10:00:00Z'");
  });
});

// ===========================================================================
// $__interval — the literal-expanding family
// ===========================================================================

describe('$__interval', () => {
  it('expands INSIDE a string literal, unlike the other macros', () => {
    // Its documented use is quoted. Skipping literals leaves the token intact
    // and DuckDB fails with "Could not convert string '$__interval' to INTERVAL".
    expect(expand("SELECT time_bucket(INTERVAL '$__interval', t) FROM m")).toBe(
      "SELECT time_bucket(INTERVAL '10s', t) FROM m",
    );
  });

  it('does not expand inside a comment', () => {
    const sql = '-- bucket $__interval\nSELECT 1';
    expect(expand(sql)).toBe(sql);
  });

  it('does not match the prefix of $__interval_ms', () => {
    expect(expand('SELECT $__interval_ms, $__interval')).toBe('SELECT 10000, 10s');
  });

  it.each([['$__intervalx'], ['$__interval_foo']])('leaves %s alone', (token) => {
    expect(expand(`SELECT ${token}`)).toBe(`SELECT ${token}`);
  });

  it('keeps the text and millisecond forms in agreement', () => {
    // One value, two renderings. Grafana derives the text with secondsToHms,
    // which truncates 90000ms to "1m" — a third smaller than the _ms form.
    const out = expand('SELECT $__interval, $__interval_ms', { intervalMs: 90_000 });
    expect(out).toBe('SELECT 90s, 90000');
  });

  it('does not let a quoted comment marker swallow the query', () => {
    // The Go walker has no single-quote branch yet still tests for `--`, so a
    // quoted marker before the token ends the "comment" at EOF and leaves the
    // token unexpanded — producing the exact DuckDB failure the function exists
    // to prevent.
    const out = expand("SELECT * FROM t WHERE note = 'a--b' AND x = time_bucket(INTERVAL '$__interval', t)");
    expect(out).toContain("'a--b'");
    expect(out).toContain("INTERVAL '10s'");
    expect(out).not.toContain('$__interval');
  });

  it('does not let a quoted block-comment marker swallow the query either', () => {
    const out = expand("SELECT * FROM t WHERE note = 'a/*b' AND x = INTERVAL '$__interval'");
    expect(out).toContain("INTERVAL '10s'");
    expect(out).not.toContain('$__interval');
  });
});

// ===========================================================================
// $__timeGroup — ported from the Go suite
// ===========================================================================

describe('$__timeGroup', () => {
  it('buckets with integer epoch arithmetic', () => {
    // epoch_ns() with // , never epoch() with / : the DOUBLE form rounds
    // 05:59:59.999 up into the next bucket.
    expect(expand("SELECT $__timeGroup(time, '1m') FROM m")).toBe(
      'SELECT to_timestamp((epoch_ns(time) // 1000000000 // 60) * 60) FROM m',
    );
  });

  it.each([
    ["'10m'", 600],
    ["'1h'", 3600],
    ["'1d'", 86400],
    ["'30s'", 30],
    ["'2 minutes'", 120],
  ])('accepts the interval %s', (interval, secs) => {
    expect(expand(`SELECT $__timeGroup(time, ${interval})`)).toContain(`// ${secs}) * ${secs}`);
  });

  it('leaves SQL without the macro untouched', () => {
    const sql = 'SELECT count(*) FROM m';
    expect(expand(sql)).toBe(sql);
  });

  it('expands multiple occurrences', () => {
    const out = expand("SELECT $__timeGroup(a, '1m'), $__timeGroup(b, '1m')");
    expect(out).not.toContain('$__timeGroup');
  });

  it.each([
    ['$__timeGroup(time)', 'one argument'],
    ["$__timeGroup(time, 'nonsense')", 'an unknown interval'],
    ["$__timeGroup(time, '500ms')", 'a sub-second interval'],
    ["$__timeGroup(, '1h')", 'an empty column'],
  ])('leaves the macro unexpanded for %s', (sql) => {
    expect(expand(`SELECT ${sql}`)).toContain('$__timeGroup(');
  });

  it('rejects an interval wider than the cap rather than collapsing every row', () => {
    expect(expand("SELECT $__timeGroup(time, '400d')")).toContain('$__timeGroup(');
  });

  it('ignores a third fill argument instead of rejecting it', () => {
    // Postgres and Timescale dashboards carry $__timeGroup(time, '5m', 0).
    // Rejecting it left the macro unexpanded and broke every migrated panel.
    expect(expand("SELECT $__timeGroup(time, '5m', 0)")).toBe(
      'SELECT to_timestamp((epoch_ns(time) // 1000000000 // 300) * 300)',
    );
  });

  it('strips a cutset of quotes from the interval, as Go does', () => {
    // strings.Trim with a cutset removes any run of either quote character.
    expect(expand(`SELECT $__timeGroup(time, '''1h''')`)).toContain('// 3600');
    expect(expand('SELECT $__timeGroup(time, "1d")')).toContain('// 86400');
  });

  it('leaves a comma-bearing column unexpanded — the known arg-splitting wart', () => {
    // expandTimeGroup splits on every comma while findMatchingParen nests, so
    // the two macros disagree about this input. Ported verbatim: it fails
    // closed, and the paren-balance check makes the rejection safe.
    expect(expand("SELECT $__timeGroup(coalesce(a,b), '1m')")).toContain('$__timeGroup(');
    // Whereas $__timeFilter handles it fine.
    expect(expand('WHERE $__timeFilter(coalesce(a,b))')).toContain('(coalesce(a,b)) >=');
  });
});

// ===========================================================================
// Timezone bucketing — the subtle half
// ===========================================================================

describe('$__timeGroup timezone handling', () => {
  it.each([['UTC'], ['utc'], [''], ['Etc/UTC'], ['Atlantic/Reykjavik']])(
    'keeps %p on the byte-identical epoch path',
    (tz) => {
      // The model's own default is lowercase 'utc'. Comparing case-sensitively
      // would send every default dashboard down the calendar branch emitting
      // timezone('utc', ...) — and date_trunc on a TIMESTAMPTZ truncates in the
      // DuckDB session's zone, so it would follow Arc's setting, not UTC.
      expect(expand("SELECT $__timeGroup(time, '1d')", { timezone: tz })).toBe(
        'SELECT to_timestamp((epoch_ns(time) // 1000000000 // 86400) * 86400)',
      );
    },
  );

  it('uses local calendar boundaries for a day bucket in a non-UTC zone', () => {
    // With epoch arithmetic a "day" starts at 00:00 UTC, which in UTC-6 is 18:00
    // the previous evening, so every bar mixes two local days.
    expect(expand("SELECT $__timeGroup(time, '1d')", { timezone: 'America/Costa_Rica' })).toBe(
      "SELECT timezone('America/Costa_Rica', date_trunc('day', timezone('America/Costa_Rica', time)))",
    );
  });

  it('keeps an hour bucket on epoch arithmetic in a WHOLE-hour zone', () => {
    // A local hour boundary IS a UTC hour boundary there, so the buckets are
    // identical — and the calendar path would merge the two local 01:30s at a
    // DST fall-back, putting 120 minutes in one bucket and emptying its
    // neighbour. Verified on DuckDB 1.5.5.
    expect(expand("SELECT $__timeGroup(time, '1h')", { timezone: 'America/New_York' })).toBe(
      'SELECT to_timestamp((epoch_ns(time) // 1000000000 // 3600) * 3600)',
    );
  });

  it.each([['Asia/Kolkata'], ['Pacific/Chatham'], ['Australia/Eucla'], ['Asia/Kathmandu']])(
    'takes the calendar path for an hour bucket in the sub-hour zone %s',
    (tz) => {
      // These need it to get :30/:45 boundaries at all.
      expect(expand("SELECT $__timeGroup(time, '1h')", { timezone: tz })).toContain("date_trunc('hour'");
    },
  );

  it('only uses date_trunc week when a week unit was actually written', () => {
    // date_trunc('week') anchors on Monday (verified), so turning "7d" — seven
    // days wide, starting wherever the range does — into weeks re-buckets it.
    const tzOpt = { timezone: 'America/Costa_Rica' };
    expect(expand("SELECT $__timeGroup(time, '7d')", tzOpt)).toContain('epoch_ns');
    expect(expand("SELECT $__timeGroup(time, '1w')", tzOpt)).toContain("date_trunc('week'");
    expect(expand("SELECT $__timeGroup(time, '1 week')", tzOpt)).toContain("date_trunc('week'");
  });

  it.each([["'6h'"], ["'3d'"], ["'30m'"]])(
    'keeps the non-calendar interval %s on epoch arithmetic',
    (interval) => {
      expect(expand(`SELECT $__timeGroup(time, ${interval})`, { timezone: 'Asia/Kolkata' })).toContain(
        'epoch_ns',
      );
    },
  );
});

describe('validateTimezone', () => {
  it.each([['UTC'], ['utc'], ['UtC'], [''], [null], [undefined]])('maps %p to UTC', (tz) => {
    expect(validateTimezone(tz)).toBe('UTC');
  });

  it.each([['Local'], ['Factory'], ['posixrules']])('rejects the non-IANA Go name %s', (tz) => {
    expect(validateTimezone(tz)).toBe('UTC');
  });

  it.each([['./Asia/Tokyo'], ['../etc/passwd'], ['/Asia/Tokyo'], ['a/b/c/d'], ["Asia/Tokyo'"]])(
    'rejects %p before it can reach SQL',
    (tz) => {
      expect(validateTimezone(tz)).toBe('UTC');
    },
  );

  it('degrades an unknown zone rather than throwing', () => {
    // A bad timezone must not black out a panel.
    expect(validateTimezone('Nope/Nowhere')).toBe('UTC');
  });

  it('canonicalises an always-zero-offset zone to UTC', () => {
    // So it takes the byte-identical epoch path.
    expect(validateTimezone('Etc/UTC')).toBe('UTC');
    expect(validateTimezone('Atlantic/Reykjavik')).toBe('UTC');
  });

  it('preserves a real zone, including the POSIX-inverted Etc form', () => {
    expect(validateTimezone('Europe/Madrid')).toBe('Europe/Madrid');
    // Etc/GMT+5 reports GMT-05:00 — the sign is inverted by design, and it is
    // NOT a zero-offset zone, so it must survive.
    expect(validateTimezone('Etc/GMT+5')).toBe('Etc/GMT+5');
  });
});

describe('resolveTimezone', () => {
  it("turns 'browser' into a concrete zone", () => {
    const out = resolveTimezone('browser');
    expect(out).not.toBe('browser');
    expect(out.length).toBeGreaterThan(0);
  });

  it('passes everything else through untouched', () => {
    expect(resolveTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(resolveTimezone('')).toBe('UTC');
  });
});

describe('zone offset arithmetic', () => {
  const jan = new Date(Date.UTC(2026, 0, 1));
  it.each([
    ['Asia/Kolkata', 19800],
    ['Australia/Eucla', 31500],
    ['Asia/Kathmandu', 20700],
    ['Etc/GMT+5', -18000],
    ['UTC', 0],
  ])('reads %s as %i seconds', (tz, secs) => {
    expect(__internal.zoneOffsetSeconds(tz, jan)).toBe(secs);
  });

  it.each([['Asia/Kolkata'], ['Pacific/Chatham'], ['Australia/Eucla']])(
    '%s is not a whole-hour zone',
    (tz) => {
      expect(__internal.zoneOffsetIsWholeHour(tz)).toBe(false);
    },
  );

  it.each([['America/New_York'], ['Europe/Madrid'], ['UTC']])('%s is a whole-hour zone', (tz) => {
    expect(__internal.zoneOffsetIsWholeHour(tz)).toBe(true);
  });
});

// ===========================================================================
// Intervals
// ===========================================================================

describe('intervalToSeconds', () => {
  it.each([
    ['1s', 1], ['30s', 30], ['1m', 60], ['5m', 300], ['1h', 3600], ['1d', 86400],
    ['1w', 604800], ['2 minutes', 120], ['10 seconds', 10], ['1 hour', 3600],
  ])('parses %s', (s, secs) => {
    expect(intervalToSeconds(s)).toBe(secs);
  });

  it.each([['500ms'], ['nonsense'], ['1x'], [''], ['0s'], ['-5m'], ['1h extra'], ['1y']])(
    'rejects %p',
    (s) => {
      expect(intervalToSeconds(s)).toBeNull();
    },
  );

  it('caps at 31 days so an absurd bucket cannot collapse the chart', () => {
    expect(intervalToSeconds('31d')).toBe(MAX_INTERVAL_SECONDS);
    expect(intervalToSeconds('32d')).toBeNull();
    expect(intervalToSeconds('9223372036854775807s')).toBeNull();
  });

  it('reads 1M as a minute, matching DuckDB rather than Grafana', () => {
    // DuckDB's INTERVAL '1M' is one minute (verified on 1.5.5); Grafana's M is
    // a month. This path feeds DuckDB, so DuckDB's reading is the right one.
    // The Grafana meaning is handled where it arises, in the low-limit parser.
    expect(intervalToSeconds('1M')).toBe(60);
  });
});

describe('formatIntervalText', () => {
  it.each([
    [1000, '1s'], [10_000, '10s'], [90_000, '90s'], [60_000, '1m'],
    [900_000, '15m'], [3_600_000, '1h'], [43_200_000, '12h'], [86_400_000, '1d'],
  ])('renders %i as %s', (ms, text) => {
    expect(formatIntervalText(ms)).toBe(text);
  });

  it('caps at days and never emits a week', () => {
    // '1w' would flip truncUnitForSeconds's week gate to Monday-anchored
    // date_trunc, re-bucketing a request that only meant "seven days wide".
    expect(formatIntervalText(604_800_000)).toBe('7d');
  });

  it('round-trips losslessly through intervalToSeconds', () => {
    // This is what keeps $__interval and $__interval_ms in agreement.
    for (const ms of [1000, 10_000, 90_000, 100_000, 3_600_000, 86_400_000, 604_800_000]) {
      expect(intervalToSeconds(formatIntervalText(ms))).toBe(ms / 1000);
    }
  });

  it('round-trips every value the ladder can produce, within the clamp', () => {
    const outs = new Set<number>();
    for (let e = 0; e < 12; e++) for (let m = 1; m < 100; m++) outs.add(roundInterval(m * 10 ** e));
    for (const ms of outs) {
      if (ms < 1000 || ms > MAX_INTERVAL_SECONDS * 1000) continue;
      expect(intervalToSeconds(formatIntervalText(ms))).toBe(ms / 1000);
    }
  });
});

describe('computeIntervalMs', () => {
  it('divides the range by the point budget and rounds to a nice value', () => {
    // 6h over 1000 points is 21.6s, which rounds to 20s.
    expect(computeIntervalMs(6 * 3_600_000, { maxDataPoints: 1000 })).toBe(20_000);
  });

  it('treats panel.interval as a LOWER BOUND, never an override', () => {
    // Grafana's semantics. As an override, a panel with interval '1m' viewed
    // over 30 days would ask Arc for 43,200 one-minute buckets.
    const thirtyDays = 30 * 86_400_000;
    const asFloor = computeIntervalMs(thirtyDays, { maxDataPoints: 1000, panelInterval: '1m' });
    expect(asFloor).toBeGreaterThan(60_000);
  });

  it('applies the floor when it exceeds the computed value', () => {
    expect(computeIntervalMs(60_000, { maxDataPoints: 1000, panelInterval: '5m' })).toBe(300_000);
  });

  it('prefers the panel floor over the dashboard floor', () => {
    expect(
      computeIntervalMs(60_000, { maxDataPoints: 1000, panelInterval: '5m', minInterval: '1h' }),
    ).toBe(300_000);
  });

  it('falls back to the dashboard floor when the panel sets none', () => {
    expect(computeIntervalMs(60_000, { maxDataPoints: 1000, minInterval: '5m' })).toBe(300_000);
  });

  it('floors at one second', () => {
    // roundInterval returns 1ms for a narrow range; intervalToSeconds rejects
    // sub-second, which would leave $__timeGroup unexpanded and ship a literal
    // `$` to Arc.
    expect(computeIntervalMs(1000, { maxDataPoints: 100_000 })).toBe(1000);
  });

  it('caps at the widest bucket the engine can express', () => {
    // The ladder's top entry is 365 days, which exceeds MAX_INTERVAL_SECONDS in
    // every text form — the same unexpanded-`$` bug at the other end. Reachable
    // from a stat panel (maxDataPoints: 1) over a 45-day range.
    expect(computeIntervalMs(45 * 86_400_000, { maxDataPoints: 1 })).toBe(
      MAX_INTERVAL_SECONDS * 1000,
    );
  });

  it('always produces a value intervalToSeconds accepts', () => {
    for (const days of [0.001, 0.1, 1, 7, 45, 365]) {
      for (const mdp of [1, 10, 1000, 100_000]) {
        const ms = computeIntervalMs(days * 86_400_000, { maxDataPoints: mdp });
        expect(intervalToSeconds(formatIntervalText(ms)), `${days}d @ ${mdp}`).not.toBeNull();
      }
    }
  });

  it('uses one ladder, not a second table, when maxDataPoints is absent', () => {
    expect(computeIntervalMs(6 * 3_600_000)).toBe(
      computeIntervalMs(6 * 3_600_000, { maxDataPoints: DEFAULT_MAX_DATA_POINTS }),
    );
  });

  it.each([['1M'], ['1y'], ['nonsense'], ['']])('ignores the unparseable floor %p', (v) => {
    // DURATION_PATTERN rejects M and y outright. An unparseable floor means NO
    // floor rather than a wrong one — a Grafana '1M' (month) read as a minute
    // would be wrong by a factor of 43,200.
    expect(computeIntervalMs(6 * 3_600_000, { maxDataPoints: 1000, minInterval: v })).toBe(20_000);
  });

  it('accepts a millisecond floor, which the model allows to be stored', () => {
    expect(__internal.parseLowLimitMs('500ms')).toBe(500);
  });

  it.each([[0], [-1], [Number.NaN], [Infinity]])('survives the degenerate range %p', (r) => {
    expect(computeIntervalMs(r, { maxDataPoints: 1000 })).toBe(1000);
  });
});

// ===========================================================================
// Composition and ordering
// ===========================================================================

describe('the expansion pipeline', () => {
  it('substitutes $__interval before $__timeGroup reads it', () => {
    // The documented composition. It works only because the interval macros run
    // first — reorder them and $__timeGroup sees a literal token and rejects it.
    expect(expand("SELECT $__timeGroup(time, '$__interval') FROM m")).toBe(
      'SELECT to_timestamp((epoch_ns(time) // 1000000000 // 10) * 10) FROM m',
    );
  });

  it('expands a realistic panel query end to end', () => {
    const out = expand(
      "SELECT $__timeGroup(time, '$__interval') AS t, avg(cpu) FROM m WHERE $__timeFilter(time) GROUP BY t ORDER BY t",
    );
    expect(out).toBe(
      'SELECT to_timestamp((epoch_ns(time) // 1000000000 // 10) * 10) AS t, avg(cpu) FROM m ' +
        "WHERE (time) >= '2024-01-15T10:00:00Z' AND (time) < '2024-01-15T16:00:00Z' GROUP BY t ORDER BY t",
    );
  });

  it('re-floors a bad interval instead of shipping a literal $ to Arc', () => {
    // The caller is expected to have used computeIntervalMs. An invariant whose
    // violation breaks the panel does not belong in a doc comment.
    expect(expand("SELECT $__timeGroup(time, '$__interval')", { intervalMs: 5 })).toContain(
      '// 1) * 1',
    );
  });
});

// ===========================================================================
// Timestamps and guards
// ===========================================================================

describe('rfc3339', () => {
  it('emits second precision with no fraction, as Go does', () => {
    expect(rfc3339(new Date('2024-01-15T10:00:00.123Z'))).toBe('2024-01-15T10:00:00Z');
  });

  it('does not truncate an expanded year', () => {
    // `.slice(0, 19) + 'Z'` cuts the seconds off a +NNNNNN year.
    expect(rfc3339(new Date(Date.UTC(10000, 0, 1)))).toBe('+010000-01-01T00:00:00Z');
  });

  it('handles a pre-epoch date', () => {
    expect(rfc3339(new Date('1969-07-20T20:17:00Z'))).toBe('1969-07-20T20:17:00Z');
  });
});

describe('guards', () => {
  it.each([['from'], ['to']])('rejects an invalid %s date rather than throwing from a draw path', (k) => {
    expect(() => applyMacros('SELECT $__timeFrom()', ctx({ [k]: new Date(NaN) }))).toThrow(RangeError);
  });

  it('leaves SQL with no macros byte-identical', () => {
    const sql = "SELECT a, b FROM m WHERE x = 'y' -- note\n/* block */ ORDER BY a";
    expect(expand(sql)).toBe(sql);
  });

  it('handles an empty statement', () => {
    expect(expand('')).toBe('');
  });
});

describe('isSafeColumnArg', () => {
  it.each([['time'], ['"time"'], ['t."time"'], ['time::TIMESTAMP'], ['coalesce(a, b)'], ['créé']])(
    'accepts the ordinary expression %s',
    (arg) => {
      expect(isSafeColumnArg(arg)).toBe(true);
    },
  );

  it.each([[''], ['   '], ["a'b"], ['a;b'], ['a--b'], ['a/*b'], ['a)'], ['(a'], ['a) OR (1=1']])(
    'rejects %p',
    (arg) => {
      expect(isSafeColumnArg(arg)).toBe(false);
    },
  );

  it('rejects a legal-but-odd identifier, failing closed', () => {
    // A known false positive. It fails to an unexpanded macro and a clear Arc
    // error, which is the right direction — do not loosen the pattern.
    expect(isSafeColumnArg('t."a--b"')).toBe(false);
  });
});
