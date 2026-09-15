/**
 * The dashboard time range: a Grafana-compatible date-math parser, a resolver,
 * and a per-dashboard store with URL sync.
 *
 * ## The range is VIEW state, not model state
 *
 * Zooming, shifting and picking a range change what you are looking at; they do
 * not edit the dashboard. Writing them into `dashboard.time` would mark a
 * dashboard dirty the moment a URL-supplied range was applied — before any user
 * action — and the no-op-save check in `$lib/server/dashboards` would stop
 * short-circuiting, so every save would burn a version of history. That is the
 * same bug shape recorded in `gridEngine.ts` and `validate.ts`. Only an explicit
 * "save this as the default range" writes back, and that belongs to the settings
 * drawer.
 *
 * ## Relative ranges are never frozen
 *
 * `resolveRange` recomputes from `now` on every call and nothing memoises it. A
 * dashboard left open overnight still means "the last 6 hours". The corollary is
 * that a relative range's URL never changes as it re-resolves — writing the
 * resolved instants back would turn `now-6h` into two absolute timestamps and
 * silently stop it tracking.
 *
 * ## Who resolves, and how often
 *
 * The TICK SOURCE resolves once and passes the result to every panel.
 * `queryRunner`'s cache key is built from these instants, so per-panel resolution
 * would make two panels a millisecond apart key differently and dedupe would
 * never fire. See the contract on `RunContext.from`.
 *
 * ## Calendar units are calendar arithmetic
 *
 * `now-1M` is one month on the wall clock, not 30 days of milliseconds, and
 * `now-1d` across a DST boundary is 23 or 25 hours. Those cannot be built on a
 * milliseconds-per-unit table, which is why this does not reuse
 * `duration.ts` — that module deliberately rejects `M` and `y` because its values
 * become DuckDB INTERVALs, where `M` means minute. A range never becomes an
 * interval; it becomes two instants. Both files say so.
 */

import {
  addInZone,
  endOfInZone,
  startOfInZone,
  type CalendarUnit,
  type WeekStartName,
} from './zone';
import { resolveTimezone, validateTimezone } from './macros';
import { WEEK_STARTS } from './model';

/** A raw range as stored and as it appears in the URL. */
export interface RawTimeRange {
  from: string;
  to: string;
}

export interface ResolvedTimeRange {
  /** Epoch milliseconds, matching `RunContext.from`/`to`. */
  from: number;
  to: number;
  /** Non-empty when something was unparseable or inverted. Surfaced by the UI. */
  warnings: string[];
}

export const DEFAULT_RANGE: RawTimeRange = { from: 'now-6h', to: 'now' };

/** `TimeSettingsSchema` caps `from`/`to` at 64 characters. */
const MAX_RANGE_TEXT = 64;

/**
 * Units this grammar accepts. A superset of Grafana's date-math list, which
 * omits `ms`; accepting it is harmless and it is what `duration.ts` emits.
 * Fiscal units and `Q` are explicit non-goals.
 */
const UNITS: Record<string, CalendarUnit> = {
  ms: 'ms', s: 's', m: 'm', h: 'h', d: 'd', w: 'w', M: 'M', y: 'y',
};

/** Epoch milliseconds, as Grafana writes absolute ranges into the URL. */
const EPOCH_MS = /^\d{1,15}$/;

export interface ResolveOptions {
  /** A concrete IANA zone, `'utc'`, or `'browser'`. Normalised internally. */
  timezone?: string;
  /** Anchors `/w`. Defaults to Monday, matching DuckDB's date_trunc('week'). */
  weekStart?: string;
  /** Substituted for `now` BEFORE the math runs. */
  nowDelay?: string;
  /** Test seam. */
  now?: number;
}

/**
 * Parses one side of a range.
 *
 * `roundUp` decides which end of a snapped period `/unit` means: `from` takes the
 * START of the period and `to` takes the END, which is why `from: now/d,
 * to: now/d` is the whole of today rather than an empty range. It applies to
 * EVERY `/` in a chain, not just the last.
 *
 * Returns null when the input is not parseable, so the caller can fall back
 * visibly rather than throwing and blanking the dashboard.
 */
export function parseDateMath(
  input: string,
  roundUp: boolean,
  opts: { now: number; timezone: string; weekStart: WeekStartName },
): number | null {
  const text = input.trim();
  if (text.length === 0 || text.length > MAX_RANGE_TEXT) return null;

  // `<ISO>||<math>` — an explicit anchor instead of `now`.
  const pipe = text.indexOf('||');
  if (pipe >= 0) {
    const anchor = parseAbsolute(text.slice(0, pipe));
    if (anchor === null) return null;
    return applyMath(text.slice(pipe + 2), anchor, roundUp, opts);
  }

  if (text === 'now') return opts.now;
  if (text.startsWith('now')) return applyMath(text.slice(3), opts.now, roundUp, opts);

  return parseAbsolute(text);
}

function parseAbsolute(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // Epoch milliseconds first: Grafana writes absolute ranges this way, and
  // `new Date('1767225600000')` is an Invalid Date.
  if (EPOCH_MS.test(trimmed)) {
    const ms = Number(trimmed);
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Walks a chain of date-math operations: `-1d/d`, `/d-1d`, `-1d/d+6h`.
 *
 * Grafana's parser is a loop over operations, so chains are valid and order
 * matters. A single offset-then-snap parser silently mis-reads `now/d-1d`.
 */
function applyMath(
  expr: string,
  anchor: number,
  roundUp: boolean,
  opts: { timezone: string; weekStart: WeekStartName },
): number | null {
  let at = anchor;
  let i = 0;
  const s = expr.trim();

  while (i < s.length) {
    const op = s[i];
    if (op !== '+' && op !== '-' && op !== '/') return null;
    i++;
    if (i >= s.length) return null;

    // A missing count means one: `now-d` is minus one day.
    let digits = '';
    while (i < s.length && s[i] >= '0' && s[i] <= '9') digits += s[i++];
    const count = digits === '' ? 1 : Number(digits);
    if (!Number.isFinite(count)) return null;

    // The unit may be one or two characters (`ms`).
    let unitText = s.slice(i, i + 2);
    let unit = UNITS[unitText];
    if (unit) i += 2;
    else {
      unitText = s.slice(i, i + 1);
      unit = UNITS[unitText];
      if (!unit) return null;
      i += 1;
    }

    if (op === '/') {
      // A count with a snap is invalid — `now/2d` has no meaning.
      if (digits !== '') return null;
      at = roundUp
        ? endOfInZone(opts.timezone, at, unit, opts.weekStart)
        : startOfInZone(opts.timezone, at, unit, opts.weekStart);
    } else {
      at = addInZone(opts.timezone, at, op === '-' ? -count : count, unit);
    }
  }
  return at;
}

function normalizeWeekStart(value: string | undefined): WeekStartName {
  // DuckDB's date_trunc('week') is Monday-anchored, so Monday keeps a "this
  // week" range and a 1w bucket agreeing about where a week begins.
  if (value && (WEEK_STARTS as readonly string[]).includes(value) && value !== '') {
    if (value === 'sunday' || value === 'monday' || value === 'saturday') return value;
  }
  return 'monday';
}

/**
 * Resolves a raw range to instants.
 *
 * `nowDelay` substitutes the `now` ANCHOR before the math rather than being
 * subtracted from the result. Grafana's schema describes it as overriding the now
 * time, and it is the only placement that composes with snapping — subtracting
 * afterwards would shift a snapped day boundary. It also means an absolute range
 * is untouched by construction, which is the required behaviour.
 */
export function resolveRange(
  range: RawTimeRange,
  opts: ResolveOptions = {},
): ResolvedTimeRange {
  const warnings: string[] = [];
  // 'browser' passes the IANA name pattern and then throws inside Intl, which
  // degrades to UTC — so a browser-time dashboard would snap to UTC midnight,
  // off by up to 14 hours and invisible to a UTC test.
  const timezone = validateTimezone(resolveTimezone(opts.timezone ?? 'utc'));
  const weekStart = normalizeWeekStart(opts.weekStart);

  let now = opts.now ?? Date.now();
  if (opts.nowDelay) {
    const delay = parseDateMath(`now-${opts.nowDelay}`, false, { now, timezone, weekStart });
    if (delay !== null) now = delay;
    else warnings.push(`Ignored an unparseable nowDelay: ${opts.nowDelay}`);
  }

  const ctx = { now, timezone, weekStart };
  let from = parseDateMath(range.from, false, ctx);
  let to = parseDateMath(range.to, true, ctx);

  // Fall back per SIDE, not for the whole range: discarding a valid `from`
  // because `to` was malformed loses information the user gave us.
  if (from === null) {
    warnings.push(`Could not read the start of the range (${truncate(range.from)}).`);
    from = parseDateMath(DEFAULT_RANGE.from, false, ctx)!;
  }
  if (to === null) {
    warnings.push(`Could not read the end of the range (${truncate(range.to)}).`);
    to = parseDateMath(DEFAULT_RANGE.to, true, ctx)!;
  }

  // Inverted ranges are reported, not silently swapped: every panel would
  // otherwise say "no data" with no explanation. `to` in the FUTURE is legal —
  // `now+1h` is a real Grafana range — so only the inversion is flagged.
  if (from > to) warnings.push('The start of the range is after its end.');

  return { from, to, warnings };
}

function truncate(text: string): string {
  return text.length > 32 ? `${text.slice(0, 32)}…` : text;
}

// ---------------------------------------------------------------------------
// Range actions
// ---------------------------------------------------------------------------

/** The narrowest range zooming will produce, so zoom-out can escape zero width. */
export const MIN_SPAN_MS = 30_000;

/**
 * Doubles the span around its midpoint, returning ABSOLUTE instants.
 *
 * Absolute because "the last 12 hours centred three hours ago" cannot be written
 * relatively. That has a consequence the caller owns: once `to` is absolute,
 * auto-refresh re-runs a byte-identical query forever, so the refresh scheduler
 * should pause while the range is absolute.
 */
export function zoomOut(resolved: { from: number; to: number }, factor = 2): RawTimeRange {
  const span = Math.max(resolved.to - resolved.from, MIN_SPAN_MS);
  const mid = resolved.from + span / 2;
  const next = span * factor;
  return absolute(Math.round(mid - next / 2), Math.round(mid + next / 2));
}

/** A selection becomes the new range, floored so a stray click cannot zoom to zero. */
export function zoomTo(from: number, to: number): RawTimeRange {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const span = Math.max(hi - lo, MIN_SPAN_MS);
  return absolute(lo, lo + span);
}

/** Moves by HALF the span, as Grafana does — a full span leaves no overlap. */
export function shift(resolved: { from: number; to: number }, direction: -1 | 1): RawTimeRange {
  const span = Math.max(resolved.to - resolved.from, MIN_SPAN_MS);
  const delta = Math.round((span / 2) * direction);
  return absolute(resolved.from + delta, resolved.to + delta);
}

function absolute(from: number, to: number): RawTimeRange {
  return { from: String(from), to: String(to) };
}

/** True when neither side depends on `now`, so auto-refresh has nothing to do. */
export function isAbsolute(range: RawTimeRange): boolean {
  return !range.from.includes('now') && !range.to.includes('now');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type UrlWriteKind = 'push' | 'replace';

export interface TimeRangeStoreOptions {
  /**
   * Writes `from`/`to` into the URL. MUST merge into the existing query string:
   * `refresh`, `kiosk`, `viewPanel` and `var-*` all live there too, and
   * rebuilding the string would delete them.
   */
  writeUrl?: (params: RawTimeRange, kind: UrlWriteKind) => void;
}

/**
 * Created PER DASHBOARD, never as a module-level singleton, so two dashboards in
 * two tabs do not share a range.
 */
export function createTimeRangeStore(
  initial: RawTimeRange = DEFAULT_RANGE,
  opts: TimeRangeStoreOptions = {},
) {
  let current: RawTimeRange = clampRange(initial);
  const subscribers = new Set<(value: RawTimeRange) => void>();
  /** Suppresses the URL write while applying an inbound URL change. */
  let applying = false;

  function emit(): void {
    for (const fn of subscribers) fn(current);
  }

  function commit(next: RawTimeRange, kind: UrlWriteKind): void {
    const clamped = clampRange(next);
    if (clamped.from === current.from && clamped.to === current.to) return;
    current = clamped;
    if (!applying) opts.writeUrl?.(current, kind);
    emit();
  }

  return {
    subscribe(fn: (value: RawTimeRange) => void): () => void {
      subscribers.add(fn);
      fn(current);
      return () => subscribers.delete(fn);
    },

    get current(): RawTimeRange {
      return current;
    },

    /** Picking a range from the toolbar is a navigable step. */
    set(next: RawTimeRange): void {
      commit(next, 'push');
    },

    zoomOut(resolved: { from: number; to: number }): void {
      commit(zoomOut(resolved), 'push');
    },

    zoomTo(from: number, to: number): void {
      commit(zoomTo(from, to), 'push');
    },

    shift(resolved: { from: number; to: number }, direction: -1 | 1): void {
      commit(shift(resolved, direction), 'push');
    },

    reset(): void {
      commit(initial, 'push');
    },

    /**
     * Applies a range that arrived FROM the URL — on mount, and on every
     * back/forward. Without this the store is write-only: Back changes the URL,
     * the store keeps the old range, and no panel re-queries.
     *
     * The guard is what stops an inbound apply pushing a new history entry,
     * which would make Back navigate forward again.
     */
    applyFromUrl(params: { from?: string | null; to?: string | null }): void {
      const next = {
        from: params.from ?? current.from,
        to: params.to ?? current.to,
      };
      applying = true;
      try {
        commit(next, 'replace');
      } finally {
        applying = false;
      }
    },

    /** The initial write replaces rather than pushes, so Back leaves the page. */
    syncInitialUrl(): void {
      opts.writeUrl?.(current, 'replace');
    },
  };
}

export type TimeRangeStore = ReturnType<typeof createTimeRangeStore>;

/**
 * Caps each side at what the model can store. A longer value would resolve fine
 * and then fail validation on save with a `too_long` error on a field the user
 * never typed.
 */
function clampRange(range: RawTimeRange): RawTimeRange {
  return {
    from: range.from.slice(0, MAX_RANGE_TEXT),
    to: range.to.slice(0, MAX_RANGE_TEXT),
  };
}
