/**
 * Frame normalizer — Arc's `{ columns, rows }` into typed, column-major fields.
 *
 * Every panel needs the same question answered: which column is time, which are
 * values, which name a series. Answering it once here is what keeps seven
 * panels as thin renderers; the alternative is the shape `Monitoring.svelte` is
 * in today, with seven hand-built `[number[], number[]]` tuples.
 *
 * Pure, dependency-free, and runs in the BROWSER on every refresh tick.
 *
 * ## Invariants
 *
 * 1. **The time field is ascending and never null.** uPlot binary-searches
 *    `data[0]` for cursor and viewport clipping; unsorted x does not throw, it
 *    silently returns a wrong index, so the tooltip reads a random row and the
 *    viewport clips real data away. Checking costs ~0.65ms at 500k rows;
 *    repairing costs ~76ms, so this checks and reports rather than sorting.
 *
 * 2. **Time values are epoch MILLISECONDS.** uPlot's own default is seconds
 *    (`opts.ms || 1e-3`), and both existing charts in this repo divide by 1000.
 *    Panels built on frames must pass `ms: 1` to uPlot. Millis is still the
 *    right storage: JS-native, matches `Date.now()`, no float seconds.
 *
 * 3. **Frames are immutable.** #29 caches them, and a cached frame is shared by
 *    every panel running the same query — so a table panel sorting `values` in
 *    place would corrupt another panel's data. Transforms return new frames.
 *
 * 4. **Numeric values are `(number | null)[]`, not a typed array.** Measured, a
 *    `Float64Array` saves ~2.5x memory and buys ~9% on normalize — but uPlot's
 *    gap detection is strictly `yVal === null`, and a typed array can only
 *    carry NaN, which renders as a line through zero instead of a gap. The
 *    time field IS a `Float64Array`, since it is never null and uPlot accepts
 *    a typed array for x.
 *
 * 5. **Never `new Date(string)` or `Date.parse`.** `'2026-01-01T00:00:00'` is
 *    parsed as LOCAL by V8 and is `Invalid Date` in older WebKit; the same
 *    string with a space separator is local in V8 and unspecified elsewhere.
 *    Timestamps are parsed by explicit scan into `Date.UTC`, which is also
 *    ~3.4x faster than `Date.parse` on a large column.
 */

import { LIMITS, type FieldConfig } from './model';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FieldType = 'time' | 'number' | 'string' | 'boolean';

interface FieldBase {
  name: string;
  config: FieldConfig;
  /** Set when the field came from a long-format pivot. `name` is derived from it. */
  labels?: Record<string, string>;
  /**
   * The source cells, when they could not be represented losslessly.
   *
   * Arc emits timestamps with nanosecond precision and integers wider than
   * 2^53; both lose information on the way into a number. A panel that must
   * display the exact value — a log inspector, a table cell — reads this.
   */
  raw?: readonly unknown[];
}

/**
 * A discriminated union rather than a generic: `Field<T = unknown>` inside a
 * `Field[]` always collapses to `unknown`, so every panel casts and the generic
 * never binds. This narrows on `type` with no casts, and moves invariant 1 —
 * time is a non-nullable `Float64Array` — from a comment into the type system.
 */
export type Field =
  | (FieldBase & { type: 'time'; values: Float64Array })
  | (FieldBase & { type: 'number'; values: (number | null)[] })
  | (FieldBase & { type: 'string'; values: (string | null)[] })
  | (FieldBase & { type: 'boolean'; values: (boolean | null)[] });

export type FrameShape = 'wide' | 'long' | 'table' | 'empty';

export type FrameNoticeCode =
  | 'unparseable'
  | 'mixed-type'
  | 'numeric-strings'
  | 'truncated'
  | 'series-capped'
  | 'unsorted'
  | 'short-rows'
  | 'duplicate-timestamps';

/**
 * Carries a `code` for the same reason `ValidationWarning` does: without one a
 * consumer has to match on English that will be reworded. `level` is kept
 * alongside it because it says something a code does not — cosmetic versus
 * data loss.
 */
export interface FrameNotice {
  code: FrameNoticeCode;
  level: 'info' | 'warning';
  field?: string;
  count?: number;
  message: string;
}

export interface Frame {
  /** The target this came from, so series from different targets stay distinct. */
  refId?: string;
  fields: Field[];
  /** Row count. Every field's `values.length` equals this. */
  length: number;
  shape: FrameShape;
  /** -1 when there is no time field. The first time column wins. */
  timeFieldIndex: number;
  numericFieldIndices: number[];
  stringFieldIndices: number[];
  notices: FrameNotice[];
}

/** What uPlot's `setData` wants, typed structurally so this module imports no uPlot. */
export type AlignedData = readonly [Float64Array, ...((number | null)[])[]];

/** Accepts Arc's JSON shape without importing arcClient. */
export interface FrameInput {
  columns: readonly string[];
  rows: readonly unknown[][];
  rowsCapped?: boolean;
  truncated?: boolean;
  truncationReason?: string;
}

export interface NormalizeOptions {
  refId?: string;
  /** Declared by the panel's target. `'auto'` infers. */
  shape?: FrameShape | 'auto';
  /** Overrides time-column detection by name. */
  timeField?: string;
  /**
   * Unit for a NUMERIC time column. Arc always emits timestamps as strings, so
   * this only matters when a user writes `SELECT epoch_ns(time)` by hand —
   * exactly the case a heuristic cannot be told about, hence the escape hatch.
   */
  timeUnit?: 's' | 'ms' | 'us' | 'ns';
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

class Notices {
  readonly items: FrameNotice[] = [];

  add(notice: FrameNotice): void {
    // Bounded for the same reason the validator's warning sink is: 200 columns
    // times several notice kinds is hundreds of strings built per refresh tick.
    if (this.items.length >= LIMITS.maxWarnings) return;
    this.items.push(notice);
  }
}

// ---------------------------------------------------------------------------
// Timestamp parsing
// ---------------------------------------------------------------------------

/**
 * The formats Arc actually emits.
 *
 * Both JSON writers use Go's `RFC3339Nano`, which TRIMS trailing zeros — so a
 * `$__timeGroup` result, being whole seconds, is `2025-10-28T16:00:00Z` with no
 * fractional part at all. A pattern requiring six fraction digits (the shape of
 * the Go layout constant) would fail to parse the majority of dashboard rows.
 *
 * The date-only form is included because `CAST(date AS VARCHAR)` produces it.
 */
const ISO_LIKE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Parse one timestamp string to epoch millis, or null.
 *
 * A value with no zone is UTC: DuckDB `TIMESTAMP` is timezone-naive wall clock
 * and Arc normalizes to UTC before rendering, so a naive string out of Arc is a
 * UTC wall clock. Reading it as local would shift every chart by the viewer's
 * offset — and by a different amount for two viewers.
 */
export function parseTimestamp(value: string): number | null {
  const fast = parseTimestampFast(value);
  if (fast !== undefined) return fast;

  const m = ISO_LIKE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;

  // Date.UTC ROLLS OVER out-of-range parts rather than failing: month 13
  // becomes January of the next year, hour 99 becomes four days later. So a
  // nonsense timestamp would parse to a plausible-looking instant and plot
  // silently in the wrong place. Range-check before converting.
  const month = Number(mo);
  const day = Number(d);
  const hour = h ? Number(h) : 0;
  const minute = mi ? Number(mi) : 0;
  const second = s ? Number(s) : 0;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  // 60 is legal: a leap second, which JS folds into the next minute.
  if (hour > 23 || minute > 59 || second > 60) return null;

  let ms = Date.UTC(
    Number(y),
    month - 1,
    day,
    hour,
    minute,
    second,
    0,
  );
  if (Number.isNaN(ms)) return null;

  if (frac) {
    // Sub-millisecond precision is dropped here; `Field.raw` keeps the source
    // string for anything that must show the exact value.
    ms += Number(frac.slice(0, 3).padEnd(3, '0'));
  }
  if (zone && zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    const zh = Number(digits.slice(0, 2));
    const zm = Number(digits.slice(2, 4));
    ms += (zone[0] === '-' ? 1 : -1) * (zh * 60 + zm) * 60_000;
  }
  return ms;
}

/**
 * Character-scanning parser for the shapes Arc actually emits.
 *
 * `exec` with capture groups allocates a match array per row, which at 100k
 * rows x 8 columns is the single largest cost in normalization — measured 25ms
 * versus 8ms for this. The regex above stays as the fallback for anything this
 * does not recognise, so correctness never depends on the fast path.
 *
 * Returns `undefined` (not null) when the shape is unfamiliar, so the caller
 * can tell "not my format" from "definitely invalid".
 */
function parseTimestampFast(v: string): number | null | undefined {
  const n = v.length;
  // Shortest accepted form is a bare date.
  if (n < 10) return undefined;
  if (v.charCodeAt(4) !== 45 || v.charCodeAt(7) !== 45) return undefined; // '-'

  const year = d4(v, 0);
  const month = d2(v, 5);
  const day = d2(v, 8);
  if (year < 0 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  if (n === 10) return Date.UTC(year, month - 1, day);

  const sep = v.charCodeAt(10);
  if (sep !== 84 && sep !== 32) return undefined; // 'T' or ' '
  if (n < 19 || v.charCodeAt(13) !== 58 || v.charCodeAt(16) !== 58) return undefined;

  const hour = d2(v, 11);
  const minute = d2(v, 14);
  const second = d2(v, 17);
  if (hour < 0 || minute < 0 || second < 0) return undefined;
  if (hour > 23 || minute > 59 || second > 60) return null;

  let i = 19;
  let millis = 0;
  if (i < n && v.charCodeAt(i) === 46) {
    i++;
    let digits = 0;
    while (i < n) {
      const c = v.charCodeAt(i) - 48;
      if (c < 0 || c > 9) break;
      // Only the first three digits survive into millis; the rest are consumed
      // so the offset parse below starts in the right place.
      if (digits < 3) millis = millis * 10 + c;
      digits++;
      i++;
    }
    if (digits === 0) return undefined;
    for (let k = digits; k < 3; k++) millis *= 10;
  }

  let offsetMinutes = 0;
  if (i < n) {
    const c = v.charCodeAt(i);
    if (c === 90) {
      // 'Z'
      if (i + 1 !== n) return undefined;
    } else if (c === 43 || c === 45) {
      const sign = c === 45 ? 1 : -1;
      const zh = d2(v, i + 1);
      if (zh < 0) return undefined;
      const colon = v.charCodeAt(i + 3) === 58 ? 1 : 0;
      const zm = d2(v, i + 3 + colon);
      if (zm < 0) return undefined;
      if (i + 3 + colon + 2 !== n) return undefined;
      offsetMinutes = sign * (zh * 60 + zm);
    } else {
      return undefined;
    }
  }

  return (
    Date.UTC(year, month - 1, day, hour, minute, second, millis) + offsetMinutes * 60_000
  );
}

/** Two digits at `i`, or -1. */
function d2(s: string, i: number): number {
  const a = s.charCodeAt(i) - 48;
  const b = s.charCodeAt(i + 1) - 48;
  if (a < 0 || a > 9 || b < 0 || b > 9) return -1;
  return a * 10 + b;
}

/** Four digits at `i`, or -1. */
function d4(s: string, i: number): number {
  const a = d2(s, i);
  const b = d2(s, i + 2);
  if (a < 0 || b < 0) return -1;
  return a * 100 + b;
}

/**
 * Epoch unit for a numeric timestamp column, decided ONCE per column from the
 * median magnitude.
 *
 * Per-value classification breaks on a single anomalous row — a gap-filled 0, a
 * `COALESCE(..., 0)`, a sentinel from a UNION — which lands in 1970 while its
 * neighbours are in 2025, stretching the axis across 55 years and collapsing
 * the real data into one pixel.
 *
 * `Math.abs` matters: without it every negative epoch classifies as seconds.
 */
export function detectEpochUnit(samples: readonly number[]): 's' | 'ms' | 'us' | 'ns' {
  if (samples.length === 0) return 'ms';
  const sorted = samples.map(Math.abs).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median < 1e12) return 's';
  if (median < 1e15) return 'ms';
  if (median < 1e18) return 'us';
  return 'ns';
}

function epochToMillis(value: number, unit: 's' | 'ms' | 'us' | 'ns'): number {
  switch (unit) {
    case 's':
      return value * 1000;
    case 'ms':
      return value;
    case 'us':
      return value / 1000;
    case 'ns':
      return value / 1_000_000;
  }
}

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

/**
 * Shared with `logFieldDetector`'s notion of a timestamp column. Kept in sync
 * deliberately: two name heuristics that disagree is the drift `LIMITS` exists
 * to prevent.
 */
const TIME_COLUMN_NAMES = new Set([
  'time',
  'timestamp',
  '_time',
  'ts',
  'datetime',
  '@timestamp',
  'created_at',
  'logged_at',
]);

/**
 * A string that is entirely a number.
 *
 * Needed because Arc's JSON endpoint returns DECIMAL columns as strings —
 * DuckDB types `SUM(integer)` as decimal(38,0) and `AVG` as decimal(x,y), and
 * the JSON writer is the one of three that does not normalize them (filed as
 * Basekick-Labs/arc#818). Without this rung, `SELECT $__timeGroup(...), avg(x)`
 * — the most ordinary dashboard query there is — yields no numeric column, and
 * every chart renders nothing, silently.
 *
 * This is a COMPATIBILITY layer for deployments on an unfixed Arc, not the
 * answer. It is safe regardless: a column of numeric strings is numeric.
 */
const NUMERIC_STRING = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

interface ColumnScan {
  samples: unknown[];
  scanned: number;
  shortRows: number;
}

/**
 * Collect up to `typeSampleSize` non-null values, scanning at most
 * `maxTypeScanRows` rows.
 *
 * Capping the SCAN and not only the sample is the difference between 0.10ms and
 * 14.5ms on an all-null column at 500k rows — 21% of the whole normalize, on a
 * case the issue lists as an explicit acceptance criterion.
 */
function scanColumn(rows: readonly unknown[][], colIdx: number): ColumnScan {
  const scan: ColumnScan = { samples: [], scanned: 0, shortRows: 0 };
  const limit = Math.min(rows.length, LIMITS.maxTypeScanRows);
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (colIdx >= row.length) {
      scan.shortRows++;
      continue;
    }
    scan.scanned++;
    const v = row[colIdx];
    // Loose `==`: a short row yields `undefined`, not `null`, and a strict
    // check would let it fall through to the string branch and retype the
    // whole column on one ragged row.
    if (v == null) continue;
    if (scan.samples.length < LIMITS.typeSampleSize) scan.samples.push(v);
    else if (scan.samples.length >= LIMITS.typeSampleSize) break;
  }
  return scan;
}

function isTimeName(name: string, opts: NormalizeOptions): boolean {
  return opts.timeField === name || TIME_COLUMN_NAMES.has(name.toLowerCase());
}

function inferType(
  name: string,
  scan: ColumnScan,
  opts: NormalizeOptions,
): { type: FieldType; numericStrings: boolean } {
  const samples = scan.samples;

  // Nothing to go on. A column named like a time column stays one, so an empty
  // result still yields a chart-shaped frame rather than a fieldless one that
  // makes the panel rebuild its axes on every empty tick.
  if (samples.length === 0) {
    return { type: isTimeName(name, opts) ? 'time' : 'string', numericStrings: false };
  }

  if (samples.every((v) => typeof v === 'boolean')) {
    return { type: 'boolean', numericStrings: false };
  }

  // msgpack decodes Arc's timestamps to Date objects.
  if (samples.every((v) => v instanceof Date)) {
    return { type: 'time', numericStrings: false };
  }

  if (samples.every((v) => typeof v === 'number' || typeof v === 'bigint')) {
    // A numeric column is a time column only when named like one, or declared.
    // Guessing from magnitude would retype every large counter.
    return {
      type: isTimeName(name, opts) || opts.timeUnit ? 'time' : 'number',
      numericStrings: false,
    };
  }

  if (samples.every((v) => typeof v === 'string')) {
    const strings = samples as string[];
    if (strings.every((v) => parseTimestamp(v) !== null)) {
      return { type: 'time', numericStrings: false };
    }
    if (strings.every((v) => NUMERIC_STRING.test(v))) {
      return { type: 'number', numericStrings: true };
    }
    return { type: 'string', numericStrings: false };
  }

  // Mixed. A column of 99 numbers and one 'n/a' reads as a table, not as a
  // chart with a silent hole where the outlier was.
  return { type: 'string', numericStrings: false };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function toCellString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  // Arc can emit LIST/STRUCT/MAP cells, and an un-normalized decimal arrives as
  // `{Width, Scale, Value}`. `String()` would render those "[object Object]".
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return '';
    }
  }
  return String(v);
}

function cellAt(rows: readonly unknown[][], row: number, col: number): unknown {
  const r = rows[row];
  return col < r.length ? r[col] : undefined;
}

function extractRaw(rows: readonly unknown[][], colIdx: number): readonly unknown[] {
  const out = new Array(rows.length);
  for (let r = 0; r < rows.length; r++) out[r] = cellAt(rows, r, colIdx);
  return out;
}

export function normalizeFrame(input: FrameInput, opts: NormalizeOptions = {}): Frame {
  const notices = new Notices();
  const columns = input.columns;
  let rows = input.rows;

  if (rows.length > LIMITS.maxFrameRows) {
    notices.add({
      code: 'truncated',
      level: 'warning',
      count: rows.length - LIMITS.maxFrameRows,
      message: `Showing the first ${LIMITS.maxFrameRows} of ${rows.length} rows`,
    });
    rows = rows.slice(0, LIMITS.maxFrameRows);
  }
  if (input.rowsCapped || input.truncated) {
    notices.add({
      code: 'truncated',
      level: 'warning',
      message: input.truncationReason || 'Arc capped this result set',
    });
  }

  const length = rows.length;
  const fields: Field[] = [];
  let timeFieldIndex = -1;
  const numericFieldIndices: number[] = [];
  const stringFieldIndices: number[] = [];

  for (let c = 0; c < columns.length; c++) {
    const name = columns[c];
    const scan = scanColumn(rows, c);

    if (scan.shortRows > 0) {
      notices.add({
        code: 'short-rows',
        level: 'warning',
        field: name,
        count: scan.shortRows,
        message: `${scan.shortRows} rows had fewer columns than the header`,
      });
    }

    const { type, numericStrings } = inferType(name, scan, opts);

    if (type === 'time') {
      // Only the FIRST time column becomes x; later ones stay time-typed data,
      // so `SELECT time, updated_at, value` still charts.
      const isX = timeFieldIndex === -1;
      const unit =
        opts.timeUnit ??
        detectEpochUnit(scan.samples.filter((v): v is number => typeof v === 'number'));

      const values = new Float64Array(length);
      let unparseable = 0;
      let previous = -Infinity;
      let ascending = true;

      for (let r = 0; r < length; r++) {
        const v = cellAt(rows, r, c);
        let ms: number;
        if (v == null) ms = Number.NaN;
        else if (typeof v === 'string') ms = parseTimestamp(v) ?? Number.NaN;
        else if (typeof v === 'number') ms = epochToMillis(v, unit);
        else if (typeof v === 'bigint') ms = epochToMillis(Number(v), unit);
        else if (v instanceof Date) ms = v.getTime();
        else ms = Number.NaN;

        if (Number.isNaN(ms)) unparseable++;
        else {
          if (ms < previous) ascending = false;
          previous = ms;
        }
        values[r] = ms;
      }

      if (unparseable > 0) {
        notices.add({
          code: 'unparseable',
          level: 'warning',
          field: name,
          count: unparseable,
          message: `${unparseable} values in "${name}" could not be read as timestamps`,
        });
      }
      if (!ascending && isX) {
        // Reported, not repaired: checking is ~0.65ms at 500k rows, sorting is
        // ~76ms. uPlot binary-searches x, so the panel decides what to do.
        notices.add({
          code: 'unsorted',
          level: 'warning',
          field: name,
          message: `"${name}" is not ascending; add ORDER BY ${name} ASC to the query`,
        });
      }

      if (isX) timeFieldIndex = fields.length;
      fields.push({ name, type: 'time', values, config: {}, raw: extractRaw(rows, c) });
      continue;
    }

    if (type === 'number') {
      const values: (number | null)[] = new Array(length);
      let mismatched = 0;
      let lossy = false;

      for (let r = 0; r < length; r++) {
        const v = cellAt(rows, r, c);
        if (v == null) {
          values[r] = null;
        } else if (typeof v === 'number') {
          values[r] = Number.isFinite(v) ? v : null;
        } else if (typeof v === 'bigint') {
          values[r] = Number(v);
        } else if (typeof v === 'string') {
          const n = Number(v);
          if (Number.isFinite(n)) {
            values[r] = n;
            if (!lossy && String(n) !== v.trim()) lossy = true;
          } else {
            values[r] = null;
            mismatched++;
          }
        } else {
          values[r] = null;
          mismatched++;
        }
      }

      if (mismatched > 0) {
        notices.add({
          code: 'mixed-type',
          level: 'warning',
          field: name,
          count: mismatched,
          message: `${mismatched} values in "${name}" were not numeric`,
        });
      }
      if (numericStrings) {
        notices.add({
          code: 'numeric-strings',
          level: 'info',
          field: name,
          message: lossy
            ? `"${name}" arrived as strings and exceeds exact integer precision; the raw values are retained`
            : `"${name}" arrived as strings and was read as numbers`,
        });
      }

      numericFieldIndices.push(fields.length);
      fields.push({
        name,
        type: 'number',
        values,
        config: {},
        ...(numericStrings && lossy ? { raw: extractRaw(rows, c) } : {}),
      });
      continue;
    }

    if (type === 'boolean') {
      const values: (boolean | null)[] = new Array(length);
      for (let r = 0; r < length; r++) {
        const v = cellAt(rows, r, c);
        values[r] = typeof v === 'boolean' ? v : null;
      }
      fields.push({ name, type: 'boolean', values, config: {} });
      continue;
    }

    const values: (string | null)[] = new Array(length);
    for (let r = 0; r < length; r++) {
      const v = cellAt(rows, r, c);
      values[r] = v == null ? null : toCellString(v);
    }
    stringFieldIndices.push(fields.length);
    fields.push({ name, type: 'string', values, config: {} });
  }

  const shape =
    opts.shape && opts.shape !== 'auto'
      ? opts.shape
      : inferShape(length, timeFieldIndex, numericFieldIndices, stringFieldIndices);

  return {
    ...(opts.refId !== undefined ? { refId: opts.refId } : {}),
    fields,
    length,
    shape,
    timeFieldIndex,
    numericFieldIndices,
    stringFieldIndices,
    notices: notices.items,
  };
}

function inferShape(
  length: number,
  timeFieldIndex: number,
  numeric: readonly number[],
  strings: readonly number[],
): FrameShape {
  if (length === 0) return 'empty';
  if (timeFieldIndex === -1 || numeric.length === 0) return 'table';
  return strings.length > 0 ? 'long' : 'wide';
}

// ---------------------------------------------------------------------------
// Pivot
// ---------------------------------------------------------------------------

/**
 * Pivot a long frame into one field per (label combination x numeric field).
 *
 * Returns the SAME object when the frame is already wide. #29 caches frames and
 * Svelte 4 re-runs every `$:` on a new object reference, so handing back a
 * fresh frame per call would re-render every panel on every tick for nothing.
 */
export function toWide(frame: Frame): Frame {
  if (frame.shape !== 'long' || frame.timeFieldIndex === -1) return frame;

  const timeField = frame.fields[frame.timeFieldIndex] as Extract<Field, { type: 'time' }>;
  const labelFields = frame.stringFieldIndices.map(
    (i) => frame.fields[i] as Extract<Field, { type: 'string' }>,
  );
  const valueFields = frame.numericFieldIndices.map(
    (i) => frame.fields[i] as Extract<Field, { type: 'number' }>,
  );

  const seriesKeyAt = (row: number): string =>
    labelFields.map((f) => f.values[row] ?? '').join(' / ');

  // Timestamp union, numerically sorted. A default `.sort()` compares as
  // strings, which reorders epoch millis wrongly and silently.
  const stamps = new Set<number>();
  for (let r = 0; r < frame.length; r++) {
    const t = timeField.values[r];
    if (!Number.isNaN(t)) stamps.add(t);
  }
  const axis = Float64Array.from([...stamps].sort((a, b) => a - b));

  const seriesKeys = new Set<string>();
  for (let r = 0; r < frame.length; r++) seriesKeys.add(seriesKeyAt(r));

  // Checked BEFORE allocating: capping series alone is the wrong axis, since
  // 256 series x 100k timestamps is 25.6M slots that would be allocated before
  // any cap notice could be written.
  const cells = seriesKeys.size * valueFields.length * axis.length;
  if (cells > LIMITS.maxPivotCells) {
    return {
      ...frame,
      notices: [
        ...frame.notices,
        {
          code: 'series-capped',
          level: 'warning',
          count: seriesKeys.size,
          message: `${seriesKeys.size} series is too many to plot; narrow the query`,
        },
      ],
    };
  }

  const rowOf = new Map<number, number>();
  for (let i = 0; i < axis.length; i++) rowOf.set(axis[i], i);

  // Deterministic order. Insertion order follows row order, which follows Arc's
  // output order, which is not stable for a GROUP BY without an ORDER BY — and
  // #30 assigns palette colours by field index, so an unstable order re-colours
  // the whole chart on every refresh tick.
  const sortedKeys = [...seriesKeys].sort();
  const multiValue = valueFields.length > 1;

  // series key -> value-field name -> column
  const buckets = new Map<string, Map<string, (number | null)[]>>();
  for (const key of sortedKeys) {
    const byField = new Map<string, (number | null)[]>();
    for (const vf of valueFields) byField.set(vf.name, new Array(axis.length).fill(null));
    buckets.set(key, byField);
  }

  let collisions = 0;
  for (let r = 0; r < frame.length; r++) {
    const t = timeField.values[r];
    if (Number.isNaN(t)) continue;
    const idx = rowOf.get(t)!;
    const byField = buckets.get(seriesKeyAt(r))!;
    for (const vf of valueFields) {
      const column = byField.get(vf.name)!;
      if (column[idx] !== null) collisions++;
      column[idx] = vf.values[r];
    }
  }

  const out: Field[] = [{ ...timeField, values: axis }];
  const numericIndices: number[] = [];
  for (const key of sortedKeys) {
    const parts = key.split(' / ');
    for (const vf of valueFields) {
      numericIndices.push(out.length);
      out.push({
        name: multiValue ? `${key} ${vf.name}` : key,
        type: 'number',
        values: buckets.get(key)!.get(vf.name)!,
        config: vf.config,
        labels: Object.fromEntries(labelFields.map((f, i) => [f.name, parts[i] ?? ''])),
      });
    }
  }

  const notices = [...frame.notices];
  if (collisions > 0) {
    notices.push({
      code: 'duplicate-timestamps',
      level: 'warning',
      count: collisions,
      message: `${collisions} rows shared a timestamp within one series; the last value won`,
    });
  }

  return {
    ...(frame.refId !== undefined ? { refId: frame.refId } : {}),
    fields: out,
    length: axis.length,
    shape: 'wide',
    timeFieldIndex: 0,
    numericFieldIndices: numericIndices,
    stringFieldIndices: [],
    notices,
  };
}

// ---------------------------------------------------------------------------
// uPlot handoff
// ---------------------------------------------------------------------------

/**
 * The frame as uPlot's `AlignedData`: x first, then every numeric field in
 * field order.
 *
 * Exists so the ordering rule lives in one place rather than being reinvented
 * per panel, and so a panel does zero work per render — measured at ~1.2ms per
 * panel per frame against rebuilding the arrays each time.
 *
 * Remember `ms: 1` in the uPlot options; its default x unit is seconds.
 */
export function toAligned(frame: Frame): AlignedData {
  const wide = toWide(frame);
  if (wide.timeFieldIndex === -1) {
    return [new Float64Array(0)] as unknown as AlignedData;
  }
  const x = (wide.fields[wide.timeFieldIndex] as Extract<Field, { type: 'time' }>).values;
  const ys = wide.numericFieldIndices.map(
    (i) => (wide.fields[i] as Extract<Field, { type: 'number' }>).values,
  );
  return [x, ...ys] as unknown as AlignedData;
}
