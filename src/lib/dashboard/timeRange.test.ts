import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RANGE,
  MIN_SPAN_MS,
  createTimeRangeStore,
  isAbsolute,
  parseDateMath,
  resolveRange,
  shift,
  zoomOut,
  zoomTo,
  type RawTimeRange,
  type UrlWriteKind,
} from './timeRange';
import { startOfInZone, endOfInZone, addInZone, wallClockToUtc, zonedParts } from './zone';

/** A fixed instant: 2026-06-15 13:00 UTC, a Monday. */
const NOW = Date.UTC(2026, 5, 15, 13, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const local = (tz: string, ms: number) => {
  const p = zonedParts(tz, ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
};

const R = (from: string, to: string): RawTimeRange => ({ from, to });
const resolve = (from: string, to: string, opts = {}) =>
  resolveRange(R(from, to), { now: NOW, timezone: 'utc', ...opts });

// ===========================================================================
// Grammar
// ===========================================================================

describe('parseDateMath', () => {
  const ctx = { now: NOW, timezone: 'UTC', weekStart: 'monday' as const };

  it('reads bare now', () => {
    expect(parseDateMath('now', false, ctx)).toBe(NOW);
  });

  it.each([
    ['now-15m', -15 * 60_000],
    ['now-1h', -3_600_000],
    ['now+1h', 3_600_000],
    ['now-500ms', -500],
  ])('reads the offset %s', (text, delta) => {
    expect(parseDateMath(text, false, ctx)).toBe(NOW + delta);
  });

  it('treats a missing count as one', () => {
    // Grafana's parser defaults the count, so `now-d` is minus one day.
    expect(parseDateMath('now-d', false, ctx)).toBe(parseDateMath('now-1d', false, ctx));
  });

  it('walks a CHAIN of operations, not just offset-then-snap', () => {
    // `now/d-1d` is yesterday's start; a single offset-then-snap parser
    // mis-reads it.
    const yesterdayStart = parseDateMath('now/d-1d', false, ctx);
    const expected = addInZone('UTC', startOfInZone('UTC', NOW, 'd'), -1, 'd');
    expect(yesterdayStart).toBe(expected);

    const sixAm = parseDateMath('now-1d/d+6h', false, ctx);
    expect(iso(sixAm!)).toBe('2026-06-14T06:00:00.000Z');
  });

  it('rejects a snap with a count', () => {
    // `now/2d` has no meaning; Grafana rejects it outright.
    expect(parseDateMath('now/2d', false, ctx)).toBeNull();
  });

  it('reads an explicit anchor with ||', () => {
    const out = parseDateMath('2026-01-01T00:00:00Z||+1d', false, ctx);
    expect(iso(out!)).toBe('2026-01-02T00:00:00.000Z');
  });

  it('reads epoch milliseconds, which is how Grafana writes absolute ranges', () => {
    // `new Date('1767225600000')` is an Invalid Date, so a digits-only value has
    // to be handled before falling through to Date.parse.
    expect(parseDateMath('1767225600000', false, ctx)).toBe(1767225600000);
  });

  it('reads an ISO instant', () => {
    expect(parseDateMath('2026-03-01T10:30:00Z', false, ctx)).toBe(Date.UTC(2026, 2, 1, 10, 30));
  });

  it.each([['nonsense'], ['now-'], ['now-1'], ['now-1x'], ['now/'], [''], ['now-1Q']])(
    'returns null for %p rather than throwing',
    (text) => {
      expect(parseDateMath(text, false, ctx)).toBeNull();
    },
  );

  it('rejects input longer than the model can store', () => {
    expect(parseDateMath(`now-${'1'.repeat(80)}d`, false, ctx)).toBeNull();
  });
});

// ===========================================================================
// Snapping — the asymmetry and the timezones
// ===========================================================================

describe('snapping', () => {
  it('makes now/d on both sides mean the whole day', () => {
    // from takes the START of the period and to takes the END. One snap function
    // used by both sides gives from === to and every panel renders nothing.
    const out = resolve('now/d', 'now/d');
    expect(iso(out.from)).toBe('2026-06-15T00:00:00.000Z');
    expect(iso(out.to)).toBe('2026-06-15T23:59:59.999Z');
  });

  it('ends a period one millisecond before the next begins', () => {
    // Not the next period's start: `to: now/d` would then include tomorrow's
    // first row inside "today".
    expect(endOfInZone('UTC', NOW, 'd')).toBe(startOfInZone('UTC', NOW, 'd') + 86_400_000 - 1);
  });

  it('snaps in the DASHBOARD zone, not UTC', () => {
    const out = resolve('now/d', 'now', { timezone: 'Asia/Kolkata' });
    // Kolkata is +05:30, so local midnight is 18:30Z the previous day.
    expect(iso(out.from)).toBe('2026-06-14T18:30:00.000Z');
  });

  it.each([
    // The naive one-sample-offset implementation is off by an hour on both of
    // these, and on the spring one it lands on the PREVIOUS day.
    ['America/New_York', Date.UTC(2026, 2, 8, 18), '2026-03-08 00:00'],
    ['America/New_York', Date.UTC(2026, 10, 1, 18), '2026-11-01 00:00'],
  ])('handles the %s DST transition on %s', (tz, at, expected) => {
    expect(local(tz, startOfInZone(tz, at, 'd'))).toBe(expected);
  });

  it.each([
    ['America/Santiago', Date.UTC(2026, 8, 6, 15)],
    ['Asia/Beirut', Date.UTC(2026, 2, 29, 10)],
  ])('gives the first real instant of the day in %s, where local midnight does not exist', (tz, at) => {
    const start = startOfInZone(tz, at, 'd');
    const p = zonedParts(tz, start);
    // 01:00, because 00:00 was skipped by the transition.
    expect(p.hour).toBe(1);
    // And it is still on the right day, and not after the instant.
    expect(p.day).toBe(zonedParts(tz, at).day);
    expect(start).toBeLessThanOrEqual(at);
  });

  it('anchors a week on Monday by default, matching DuckDB', () => {
    // date_trunc('week') is Monday-anchored, so a "this week" range and a 1w
    // bucket must agree about where a week begins.
    const wed = Date.UTC(2026, 5, 17, 12);
    expect(local('UTC', startOfInZone('UTC', wed, 'w'))).toBe('2026-06-15 00:00');
  });

  it('honours weekStart when it is set', () => {
    const wed = Date.UTC(2026, 5, 17, 12);
    expect(local('UTC', startOfInZone('UTC', wed, 'w', 'sunday'))).toBe('2026-06-14 00:00');
    expect(local('UTC', startOfInZone('UTC', wed, 'w', 'saturday'))).toBe('2026-06-13 00:00');
  });

  it('resolves now/w through the range API', () => {
    const out = resolve('now/w', 'now/w', { weekStart: 'sunday' });
    expect(local('UTC', out.from)).toBe('2026-06-14 00:00');
  });

  it('snaps months and years', () => {
    expect(iso(resolve('now/M', 'now').from)).toBe('2026-06-01T00:00:00.000Z');
    expect(iso(resolve('now/y', 'now').from)).toBe('2026-01-01T00:00:00.000Z');
  });
});

// ===========================================================================
// Calendar arithmetic
// ===========================================================================

describe('calendar units', () => {
  it('supports M and y, which duration.ts deliberately rejects', () => {
    // Nineteen of Grafana's thirty-six quick ranges need these. duration.ts
    // rejects them because its values become DuckDB INTERVALs, where M is a
    // minute; a range never becomes an interval.
    expect(iso(resolve('now-1M', 'now').from)).toBe('2026-05-15T13:00:00.000Z');
    expect(iso(resolve('now-1y', 'now').from)).toBe('2025-06-15T13:00:00.000Z');
    expect(iso(resolve('now-6M', 'now').from)).toBe('2025-12-15T13:00:00.000Z');
  });

  it('treats a month as a calendar month, not 30 days', () => {
    const jan31 = Date.UTC(2026, 0, 31, 12);
    // Adding a month to Jan 31 clamps to Feb 28, it does not roll into March.
    expect(local('UTC', addInZone('UTC', jan31, 1, 'M'))).toBe('2026-02-28 12:00');
  });

  it('treats a day across DST as 23 or 25 hours, not 86400000ms', () => {
    const tz = 'America/New_York';
    // Spring forward: the wall clock is preserved, the elapsed time is 23h.
    const before = wallClockToUtc(tz, 2026, 3, 7, 12, 0, 0);
    const after = addInZone(tz, before, 1, 'd');
    expect(local(tz, after)).toBe('2026-03-08 12:00');
    expect(after - before).toBe(23 * 3_600_000);
  });

  it('parses every one of Grafana quick ranges it should', () => {
    const grafana = [
      'now-5m', 'now-15m', 'now-30m', 'now-1h', 'now-3h', 'now-6h', 'now-12h',
      'now-24h', 'now-2d', 'now-7d', 'now-30d', 'now-90d', 'now-6M', 'now-1y',
      'now-2y', 'now-5y', 'now/d', 'now/w', 'now/M', 'now/y',
      'now-1d/d', 'now-1w/w', 'now-1M/M', 'now-1y/y',
    ];
    for (const text of grafana) {
      const out = resolveRange(R(text, 'now'), { now: NOW, timezone: 'utc' });
      expect(out.warnings, text).toEqual([]);
    }
  });
});

// ===========================================================================
// nowDelay
// ===========================================================================

describe('nowDelay', () => {
  it('substitutes the now anchor before the math', () => {
    const out = resolve('now-1h', 'now', { nowDelay: '1m' });
    expect(iso(out.to)).toBe('2026-06-15T12:59:00.000Z');
    expect(iso(out.from)).toBe('2026-06-15T11:59:00.000Z');
  });

  it('shifts a snapped boundary through the anchor, not after it', () => {
    // Just after local midnight with a delay, "today" is still yesterday — which
    // is the correct reading of "override the now time".
    const justAfterMidnight = Date.UTC(2026, 5, 15, 0, 0, 10);
    const out = resolveRange(R('now/d', 'now'), {
      now: justAfterMidnight,
      timezone: 'utc',
      nowDelay: '1m',
    });
    expect(iso(out.from)).toBe('2026-06-14T00:00:00.000Z');
  });

  it('leaves an absolute range completely untouched', () => {
    // Falls out of anchor substitution for free — subtracting from the resolved
    // bounds instead would corrupt absolute ranges.
    const out = resolveRange(R('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'), {
      now: NOW,
      timezone: 'utc',
      nowDelay: '1h',
    });
    expect(iso(out.from)).toBe('2026-01-01T00:00:00.000Z');
    expect(iso(out.to)).toBe('2026-01-02T00:00:00.000Z');
  });

  it('warns rather than silently ignoring an unparseable delay', () => {
    const out = resolve('now-1h', 'now', { nowDelay: 'garbage' });
    expect(out.warnings.some((w) => w.includes('nowDelay'))).toBe(true);
  });
});

// ===========================================================================
// Timezone normalisation
// ===========================================================================

describe('timezone handling', () => {
  it("resolves 'browser' rather than snapping in UTC", () => {
    // 'browser' passes the IANA name pattern and then throws inside Intl, which
    // degrades to UTC — so a browser-time dashboard would snap to UTC midnight,
    // off by up to 14 hours and invisible to a UTC test.
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const viaBrowser = resolve('now/d', 'now', { timezone: 'browser' });
    const viaHost = resolve('now/d', 'now', { timezone: host });
    expect(viaBrowser.from).toBe(viaHost.from);
  });

  it.each([['utc'], ['UTC'], [''], [undefined]])('treats %p as UTC', (tz) => {
    expect(iso(resolve('now/d', 'now', { timezone: tz as string }).from)).toBe(
      '2026-06-15T00:00:00.000Z',
    );
  });

  it('degrades an unknown zone instead of throwing', () => {
    expect(() => resolve('now/d', 'now', { timezone: 'Nope/Nowhere' })).not.toThrow();
  });
});

// ===========================================================================
// Resolution behaviour
// ===========================================================================

describe('resolveRange', () => {
  it('never freezes a relative range', () => {
    const a = resolveRange(R('now-6h', 'now'), { now: NOW, timezone: 'utc' });
    const b = resolveRange(R('now-6h', 'now'), { now: NOW + 60_000, timezone: 'utc' });
    expect(b.to - a.to).toBe(60_000);
  });

  it('round-trips an absolute range through epoch milliseconds', () => {
    const range = zoomTo(NOW - 3_600_000, NOW);
    const out = resolveRange(range, { now: NOW, timezone: 'utc' });
    expect(out.from).toBe(NOW - 3_600_000);
    expect(out.to).toBe(NOW);
    expect(out.warnings).toEqual([]);
  });

  it('allows a range that ends in the future', () => {
    // `now → now+1h` is a real Grafana range; the resolver must not clamp it.
    const out = resolve('now', 'now+1h');
    expect(out.to).toBe(NOW + 3_600_000);
    expect(out.warnings).toEqual([]);
  });

  it('falls back per SIDE, keeping the side that parsed', () => {
    const out = resolve('now-2h', 'garbage');
    expect(out.from).toBe(NOW - 7_200_000);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('end of the range');
  });

  it('reports an inverted range instead of silently returning nothing', () => {
    // Every panel would otherwise say "no data" with no explanation.
    const out = resolve('now', 'now-1h');
    expect(out.warnings.some((w) => w.includes('after its end'))).toBe(true);
  });

  it('falls back to the default when both sides are unreadable', () => {
    const out = resolve('!!', '??');
    expect(out.to - out.from).toBe(6 * 3_600_000);
    expect(out.warnings).toHaveLength(2);
  });
});

// ===========================================================================
// Actions
// ===========================================================================

describe('zoomOut', () => {
  it('doubles the span around the midpoint', () => {
    const out = zoomOut({ from: NOW - 3_600_000, to: NOW });
    const r = resolveRange(out, { now: NOW, timezone: 'utc' });
    expect(r.to - r.from).toBe(7_200_000);
    expect((r.from + r.to) / 2).toBe(NOW - 1_800_000);
  });

  it('escapes a zero-width range instead of staying zero forever', () => {
    const r = resolveRange(zoomOut({ from: NOW, to: NOW }), { now: NOW, timezone: 'utc' });
    expect(r.to - r.from).toBeGreaterThanOrEqual(MIN_SPAN_MS);
  });

  it('returns absolute instants', () => {
    // "The last 12 hours centred three hours ago" is not expressible relatively.
    expect(isAbsolute(zoomOut({ from: NOW - 1000, to: NOW }))).toBe(true);
  });
});

describe('zoomTo', () => {
  it('takes the selection', () => {
    const r = resolveRange(zoomTo(NOW - 600_000, NOW), { now: NOW, timezone: 'utc' });
    expect(r.from).toBe(NOW - 600_000);
    expect(r.to).toBe(NOW);
  });

  it('normalises a backwards selection', () => {
    const r = resolveRange(zoomTo(NOW, NOW - 600_000), { now: NOW, timezone: 'utc' });
    expect(r.from).toBeLessThan(r.to);
  });

  it('floors a stray click so it cannot zoom to zero', () => {
    const r = resolveRange(zoomTo(NOW, NOW), { now: NOW, timezone: 'utc' });
    expect(r.to - r.from).toBe(MIN_SPAN_MS);
  });
});

describe('shift', () => {
  it('moves by HALF the span, so the views overlap', () => {
    const span = 3_600_000;
    const r = resolveRange(shift({ from: NOW - span, to: NOW }, -1), { now: NOW, timezone: 'utc' });
    expect(r.to).toBe(NOW - span / 2);
    expect(r.to - r.from).toBe(span);
  });

  it('moves forward too', () => {
    const r = resolveRange(shift({ from: NOW - 1000, to: NOW }, 1), { now: NOW, timezone: 'utc' });
    expect(r.to).toBeGreaterThan(NOW);
  });
});

describe('isAbsolute', () => {
  it.each([
    [R('now-6h', 'now'), false],
    [R('now/d', 'now/d'), false],
    [R('1767225600000', '1767229200000'), true],
  ])('classifies %o', (range, expected) => {
    // The refresh scheduler pauses on an absolute range: re-running a query whose
    // bounds cannot change is pure load.
    expect(isAbsolute(range)).toBe(expected);
  });
});

// ===========================================================================
// Store
// ===========================================================================

describe('createTimeRangeStore', () => {
  const track = () => {
    const writes: Array<{ params: RawTimeRange; kind: UrlWriteKind }> = [];
    const store = createTimeRangeStore(DEFAULT_RANGE, {
      writeUrl: (params, kind) => writes.push({ params, kind }),
    });
    return { store, writes };
  };

  it('publishes the current range to subscribers', () => {
    const { store } = track();
    const seen: RawTimeRange[] = [];
    const off = store.subscribe((v) => seen.push(v));
    store.set(R('now-1h', 'now'));
    off();
    expect(seen).toEqual([DEFAULT_RANGE, R('now-1h', 'now')]);
  });

  it('PUSHES history for a user action, so Back steps through zoom levels', () => {
    // The issue specifies replaceState here, which overwrites the current entry
    // and creates no history — Back would skip the whole zoom sequence.
    const { store, writes } = track();
    store.zoomOut({ from: NOW - 3_600_000, to: NOW });
    store.zoomOut({ from: NOW - 7_200_000, to: NOW });
    expect(writes.map((w) => w.kind)).toEqual(['push', 'push']);
  });

  it('REPLACES on the initial sync, so Back leaves the page', () => {
    const { store, writes } = track();
    store.syncInitialUrl();
    expect(writes).toHaveLength(1);
    expect(writes[0].kind).toBe('replace');
  });

  it('applies an inbound URL change without pushing a new entry', () => {
    // Otherwise Back changes the URL, the store pushes, and Back navigates
    // forward again.
    const { store, writes } = track();
    store.applyFromUrl({ from: 'now-24h', to: 'now' });
    expect(store.current).toEqual(R('now-24h', 'now'));
    expect(writes).toHaveLength(0);
  });

  it('keeps the current side when the URL omits one', () => {
    const { store } = track();
    store.set(R('now-3h', 'now'));
    store.applyFromUrl({ from: null, to: null });
    expect(store.current).toEqual(R('now-3h', 'now'));
  });

  it('writes nothing when the range did not actually change', () => {
    const { store, writes } = track();
    store.set(DEFAULT_RANGE);
    expect(writes).toHaveLength(0);
  });

  it('caps each side at what the model can store', () => {
    // A longer value resolves fine and then fails validation on save with a
    // too_long error on a field the user never typed.
    const { store } = track();
    store.set(R('x'.repeat(200), 'now'));
    expect(store.current.from.length).toBe(64);
  });

  it('is per dashboard, not a shared singleton', () => {
    const a = createTimeRangeStore(DEFAULT_RANGE);
    const b = createTimeRangeStore(DEFAULT_RANGE);
    a.set(R('now-1h', 'now'));
    expect(b.current).toEqual(DEFAULT_RANGE);
  });

  it('unsubscribes cleanly', () => {
    const { store } = track();
    let count = 0;
    const off = store.subscribe(() => count++);
    off();
    store.set(R('now-1h', 'now'));
    expect(count).toBe(1);
  });
});
