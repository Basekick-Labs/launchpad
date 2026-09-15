/**
 * Timezone primitives: reading a zone's offset, converting a wall-clock time to
 * an instant, and calendar arithmetic in a zone.
 *
 * Extracted so there is ONE implementation. `macros.ts` needs the offset to
 * decide whether `$__timeGroup` may use epoch arithmetic, the time range store
 * needs wall-clock conversion for `now/d`, and the axis formatter (#70) needs the
 * same again. Three copies would drift, and the drift would be invisible: every
 * one of them is correct in UTC and in whole-hour zones, and wrong only on a
 * transition day in a zone nobody tests in.
 *
 * Pure, dependency-free, isomorphic.
 *
 * ## Why converting a wall clock to an instant takes two passes and a check
 *
 * The offset needed to convert "2026-03-09 00:00 in America/New_York" to an
 * instant depends on which instant it is — and that is what we are computing. One
 * pass, sampling the offset at the naive UTC guess, is off by an hour whenever
 * the conversion crosses a transition. Measured against a real DST boundary:
 *
 *     America/New_York 2026-03-08 start of day
 *       one-sample offset -> 04:00Z, which is local 23:00 on March 7
 *       correct           -> 05:00Z, local 00:00
 *
 * Two passes fix that, and are still not enough: in a zone that springs forward
 * AT midnight, local 00:00 does not exist at all, so no offset makes the
 * conversion land on the requested wall clock. Those zones are real —
 * America/Santiago, Asia/Beirut, Africa/Cairo, America/Havana,
 * America/Asuncion. There the answer is the first instant that IS on the target
 * day, which is 01:00 local.
 */

/** One formatter per zone: constructing these is the expensive part. */
const partsFormatters = new Map<string, Intl.DateTimeFormat>();
const MAX_CACHED_ZONES = 1000;

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    if (partsFormatters.size < MAX_CACHED_ZONES) partsFormatters.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

/** The wall-clock time in `timeZone` at instant `at`. */
export function zonedParts(timeZone: string, at: Date | number): ZonedParts {
  const date = typeof at === 'number' ? new Date(at) : at;
  const parts = partsFormatter(timeZone).formatToParts(date);
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // `hourCycle: 'h23'` still renders midnight as 24 in some engines.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** The zone's UTC offset in milliseconds at instant `at`. */
export function zoneOffsetMs(timeZone: string, at: Date | number): number {
  const ms = typeof at === 'number' ? at : at.getTime();
  const p = zonedParts(timeZone, ms);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Whole seconds: the formatter has no sub-second field, so the instant's own
  // milliseconds must not leak into the difference.
  return asUTC - Math.floor(ms / 1000) * 1000;
}

/** Seconds, for callers that want the coarser unit. */
export function zoneOffsetSeconds(timeZone: string, at: Date | number): number {
  return Math.round(zoneOffsetMs(timeZone, at) / 1000);
}

/**
 * The instant at which the given wall-clock time occurs in `timeZone`.
 *
 * On a spring-forward gap the requested time does not exist; this returns the
 * first instant after the gap, which is what "the start of that day" means in
 * practice. On a fall-back the same wall clock occurs twice; this returns the
 * EARLIER one.
 *
 * The earlier choice is deliberate and differs from moment/Grafana, which take
 * the later. On a 25-hour day, "start of day" should be the day's first instant;
 * taking the later one silently drops its first hour from every "today" query.
 */
export function wallClockToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);

  // Pass 1: offset at the naive guess. Pass 2: offset at pass 1's answer, which
  // is the one that matters when the conversion crosses a transition.
  const first = naive - zoneOffsetMs(timeZone, naive);
  const second_ = naive - zoneOffsetMs(timeZone, first);

  const renders = (candidate: number): boolean => {
    const p = zonedParts(timeZone, candidate);
    return (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === hour &&
      p.minute === minute &&
      p.second === second
    );
  };

  // Prefer the earliest candidate that actually renders the requested wall clock.
  const candidates = first <= second_ ? [first, second_] : [second_, first];
  for (const c of candidates) if (renders(c)) return c;

  // Neither does: the wall clock falls in a gap. Take the later candidate, which
  // is the first instant after the transition.
  return Math.max(first, second_);
}

export type CalendarUnit = 'ms' | 's' | 'm' | 'h' | 'd' | 'w' | 'M' | 'y';

const EXACT_MS: Partial<Record<CalendarUnit, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

export const WEEK_START_INDEX = { sunday: 0, monday: 1, saturday: 6 } as const;
export type WeekStartName = keyof typeof WEEK_START_INDEX;

/**
 * Adds `amount` of `unit` to `at`, in `timeZone`.
 *
 * Days and wider are CALENDAR arithmetic, not fixed milliseconds: "a day" is 23
 * or 25 hours across a DST boundary, and "a month" is 28 to 31 days. Hours and
 * narrower are exact. This is what moment does, and what `now-1M` has to mean —
 * it cannot be built on a milliseconds-per-unit table.
 */
export function addInZone(
  timeZone: string,
  at: number,
  amount: number,
  unit: CalendarUnit,
): number {
  const exact = EXACT_MS[unit];
  if (exact !== undefined) return at + amount * exact;

  const p = zonedParts(timeZone, at);
  let { year, month, day } = p;

  if (unit === 'd') day += amount;
  else if (unit === 'w') day += amount * 7;
  else if (unit === 'M') {
    const total = (year * 12 + (month - 1)) + amount;
    year = Math.floor(total / 12);
    month = (total % 12) + 1;
    // Clamp the day: adding a month to March 31 must not roll into May.
    day = Math.min(day, daysInMonth(year, month));
  } else if (unit === 'y') {
    year += amount;
    day = Math.min(day, daysInMonth(year, month));
  }

  return wallClockToUtc(timeZone, year, month, day, p.hour, p.minute, p.second);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The first instant of the period containing `at`.
 *
 * `weekStart` anchors `'w'`. It defaults to Monday, matching DuckDB's
 * `date_trunc('week')` — so a "this week" range and a `$__timeGroup(time, '1w')`
 * bucket agree about where a week begins.
 */
export function startOfInZone(
  timeZone: string,
  at: number,
  unit: CalendarUnit,
  weekStart: WeekStartName = 'monday',
): number {
  const p = zonedParts(timeZone, at);
  switch (unit) {
    case 'y':
      return wallClockToUtc(timeZone, p.year, 1, 1);
    case 'M':
      return wallClockToUtc(timeZone, p.year, p.month, 1);
    case 'w': {
      const midnight = wallClockToUtc(timeZone, p.year, p.month, p.day);
      const dow = new Date(midnight + zoneOffsetMs(timeZone, midnight)).getUTCDay();
      const back = (dow - WEEK_START_INDEX[weekStart] + 7) % 7;
      const target = zonedParts(timeZone, addInZone(timeZone, midnight, -back, 'd'));
      return wallClockToUtc(timeZone, target.year, target.month, target.day);
    }
    case 'd':
      return wallClockToUtc(timeZone, p.year, p.month, p.day);
    case 'h':
      return wallClockToUtc(timeZone, p.year, p.month, p.day, p.hour);
    case 'm':
      return wallClockToUtc(timeZone, p.year, p.month, p.day, p.hour, p.minute);
    case 's':
      return wallClockToUtc(timeZone, p.year, p.month, p.day, p.hour, p.minute, p.second);
    default:
      return at;
  }
}

/**
 * The LAST instant of the period containing `at` — the start of the next period
 * minus one millisecond.
 *
 * Not the start of the next period: `to: now/d` would then include the next
 * day's first row, so "today" would carry a row from tomorrow.
 */
export function endOfInZone(
  timeZone: string,
  at: number,
  unit: CalendarUnit,
  weekStart: WeekStartName = 'monday',
): number {
  const start = startOfInZone(timeZone, at, unit, weekStart);
  const nextUnit: CalendarUnit = unit;
  const next = addInZone(timeZone, start, 1, nextUnit);
  // Re-align: adding a unit to a snapped start can land mid-period in a zone
  // that transitioned in between.
  return startOfInZone(timeZone, next, unit, weekStart) - 1;
}
