/**
 * Value formatting for panels — units, scaling, and axis ticks.
 *
 * Replaces the ad-hoc formatter in `MetricChart.svelte`, which has three bugs
 * this must not inherit: `unit === 'ns'` always divides by 1e6 and calls the
 * result milliseconds (so 2ns reads `0.00 ms`), nothing scales to the value, and
 * `toLocaleString()` with no locale produces different output per machine.
 *
 * Pure, isomorphic, dependency-free.
 *
 * ## Two things that look like one
 *
 * **Per-value scaling is right for a tooltip and wrong for a set.** An axis, a
 * table column, and a bar-gauge label column must all share one scale, or ticks
 * read `900 B / 1.00 KiB / 2.00 KiB` and stop being a scale at all. #40's
 * acceptance criterion — "value labels align in a column so numbers are
 * comparable at a glance" — is unachievable if every row picks its own prefix.
 *
 * So: {@link formatter} takes an optional `range` that PINS the scale across a
 * set, and {@link formatValue} is the per-value sugar for tooltips and stat
 * tiles.
 *
 * ## Locale is pinned, deliberately
 *
 * `toLocaleString()` with no locale gives `1,234,567` on one machine and
 * `1.234.567` or `١٬٢٣٤٬٥٦٧` on another, so a test asserting exact output passes
 * on a laptop and fails in CI. Grouping is pinned to `en-US`, matching Grafana.
 * The same call this module makes for stability, `filter.ts` makes for
 * `toLowerCase`, and for the same reason.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormattedValue {
  /** Rendered before the number, e.g. a currency symbol. Usually ''. */
  prefix: string;
  /** The number itself, already scaled and rounded. */
  text: string;
  /** Rendered after the number, e.g. ' KiB' or '%'. Includes its own spacing. */
  suffix: string;
  /**
   * `prefix + text + suffix`. Not derivable by a caller, because the separator
   * rule differs per family — `1.5 KiB` has a space, `42%` does not.
   */
  formatted: string;
}

export interface ValueFormatter {
  /**
   * The fast path: one string, no object. Axis ticks and table cells use this.
   * #38 renders up to 100k cells, and an object per cell is 100k allocations
   * for a value that gets concatenated into a DOM string anyway.
   */
  text(value: number | null | undefined): string;
  /** The split form. Only a stat tile and a bar-gauge label need it. */
  parts(value: number | null | undefined): FormattedValue;
  /** The pinned unit label, for an axis title. Empty when the scale is per-value. */
  readonly suffix: string;
}

export interface UnitDef {
  id: string;
  label: string;
  group: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Enumerable so the panel options UI builds its dropdown from one place rather
 * than hardcoding a list that drifts from what the formatter understands.
 */
export const UNITS: readonly UnitDef[] = [
  // `none` groups but does not round: it means "this number, as it is".
  { id: 'none', label: 'None', group: 'Misc' },
  { id: 'short', label: 'Short (SI)', group: 'Misc' },
  { id: 'percent', label: 'Percent (0-100)', group: 'Misc' },
  { id: 'percentunit', label: 'Percent (0.0-1.0)', group: 'Misc' },

  { id: 'bytes', label: 'Bytes (IEC)', group: 'Data' },
  { id: 'decbytes', label: 'Bytes (SI)', group: 'Data' },
  { id: 'bits', label: 'Bits (IEC)', group: 'Data' },

  { id: 'Bps', label: 'Bytes/sec', group: 'Throughput' },
  { id: 'bps', label: 'Bits/sec', group: 'Throughput' },
  { id: 'ops', label: 'Ops/sec', group: 'Throughput' },
  { id: 'reqps', label: 'Requests/sec', group: 'Throughput' },

  { id: 's', label: 'Seconds', group: 'Time' },
  { id: 'ms', label: 'Milliseconds', group: 'Time' },
  { id: 'us', label: 'Microseconds', group: 'Time' },
  { id: 'ns', label: 'Nanoseconds', group: 'Time' },
] as const;

const UNIT_IDS = new Set(UNITS.map((u) => u.id));
export const isKnownUnit = (id: unknown): id is string =>
  typeof id === 'string' && UNIT_IDS.has(id);

// ---------------------------------------------------------------------------
// Ladders
// ---------------------------------------------------------------------------

interface Ladder {
  /** Multiplier between adjacent steps. */
  base: number;
  /** Suffixes from the unit's own scale upward. */
  up: readonly string[];
  /** Suffixes below the unit's own scale, nearest first. */
  down?: readonly string[];
  /** Separator between number and suffix. */
  space: boolean;
}

const SI_UP = ['', 'K', 'M', 'B', 'T', 'P', 'E'] as const;
const IEC_UP = ['', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei'] as const;

/**
 * Time is ONE family with four entry points, not four families. The unit id
 * says what scale the VALUE is in; the formatter picks the scale the OUTPUT
 * should be in. That is what fixes `MetricChart`'s `ns` case, where every value
 * was divided by 1e6 regardless of magnitude.
 */
interface TimeStep {
  suffix: string;
  scale: number;
}

const TIME_STEPS: readonly TimeStep[] = [
  { suffix: 'ns', scale: 1e-9 },
  { suffix: 'µs', scale: 1e-6 },
  { suffix: 'ms', scale: 1e-3 },
  { suffix: 's', scale: 1 },
  { suffix: 'min', scale: 60 },
  { suffix: 'h', scale: 3600 },
  { suffix: 'd', scale: 86400 },
];

const TIME_ENTRY: Record<string, number> = { ns: 1e-9, us: 1e-6, ms: 1e-3, s: 1 };

function ladderFor(unit: string): Ladder | null {
  switch (unit) {
    case 'short':
      return { base: 1000, up: SI_UP, space: false };
    case 'bytes':
      return { base: 1024, up: IEC_UP.map((p) => `${p}B`), space: true };
    case 'decbytes':
      return { base: 1000, up: SI_UP.map((p) => `${p}B`), space: true };
    case 'bits':
      return { base: 1024, up: IEC_UP.map((p) => `${p}b`), space: true };
    case 'Bps':
      return { base: 1024, up: IEC_UP.map((p) => `${p}B/s`), space: true };
    case 'bps':
      return { base: 1000, up: SI_UP.map((p) => `${p}b/s`), space: true };
    case 'ops':
      return { base: 1000, up: SI_UP.map((p) => `${p} ops/s`), space: false };
    case 'reqps':
      return { base: 1000, up: SI_UP.map((p) => `${p} req/s`), space: false };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Number rendering
// ---------------------------------------------------------------------------

const GROUPING = new Intl.NumberFormat('en-US', { useGrouping: true });

function clampDecimals(d: number | undefined): number | undefined {
  if (d === undefined) return undefined;
  if (!Number.isFinite(d)) return undefined;
  // toFixed throws a RangeError outside 0..100 and blanks the whole panel; the
  // model caps stored values at 20, but a direct caller is not bound by that.
  return Math.max(0, Math.min(20, Math.trunc(d)));
}

/** Decimals when none were declared: enough to be readable, stable in a column. */
function autoDecimals(scaled: number): number {
  const m = Math.abs(scaled);
  if (m === 0) return 0;
  if (m < 10) return 1;
  return 0;
}

function fixed(value: number, decimals: number): string {
  // toFixed switches to exponential at 1e21, which would leak `1e+21` into an
  // axis tick. Fall back to grouped integer rendering above that.
  if (Math.abs(value) >= 1e21) return GROUPING.format(value);
  const out = value.toFixed(decimals);
  // -0.001 at 2 decimals renders "-0.00"; a minus sign on a zero is noise.
  return out === `-${(0).toFixed(decimals)}` ? out.slice(1) : out;
}

// ---------------------------------------------------------------------------
// Scaling
// ---------------------------------------------------------------------------

interface Scaled {
  value: number;
  suffix: string;
}

function scaleLadder(value: number, ladder: Ladder, decimals?: number): Scaled {
  const sign = value < 0 ? -1 : 1;
  // Scale on the magnitude: a `while (v >= base)` loop never fires for negative
  // values, so -1536 bytes would render as "-1536 B".
  let m = Math.abs(value);
  let step = 0;
  while (m >= ladder.base && step < ladder.up.length - 1) {
    m /= ladder.base;
    step++;
  }

  // Re-check AFTER rounding: 1023.996 bytes at 2 decimals renders "1024.00 B",
  // which is a unit boundary the pre-rounding check could not see.
  const d = decimals ?? autoDecimals(m);
  if (Number(m.toFixed(d)) >= ladder.base && step < ladder.up.length - 1) {
    m /= ladder.base;
    step++;
  }

  const suffix = ladder.up[step];
  return {
    value: sign * m,
    suffix: suffix === '' ? '' : ladder.space ? ` ${suffix}` : suffix,
  };
}

function scaleTime(value: number, entryScale: number, decimals?: number): Scaled {
  const seconds = value * entryScale;
  const m = Math.abs(seconds);
  if (m === 0) return { value: 0, suffix: ' s' };

  let chosen: TimeStep = TIME_STEPS[0];
  for (const step of TIME_STEPS) {
    if (m >= step.scale) chosen = step;
  }
  // Below the smallest step, stay in nanoseconds rather than rendering 0.
  let out = seconds / chosen.scale;

  const d = decimals ?? autoDecimals(out);
  const nextIndex = TIME_STEPS.indexOf(chosen) + 1;
  if (nextIndex < TIME_STEPS.length) {
    const boundary = TIME_STEPS[nextIndex].scale / chosen.scale;
    if (Math.abs(Number(out.toFixed(d))) >= boundary) {
      chosen = TIME_STEPS[nextIndex];
      out = seconds / chosen.scale;
    }
  }
  return { value: out, suffix: ` ${chosen.suffix}` };
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

const EMPTY: FormattedValue = { prefix: '', text: '', suffix: '', formatted: '' };

/**
 * Build a formatter for a unit.
 *
 * `range` pins the scale across a set of values — pass the tick array's extent,
 * a table column's extent, or a bar set's extent. Without it each value scales
 * independently, which is right for a tooltip and wrong for anything rendered
 * alongside its neighbours.
 */
export function formatter(
  unit?: string,
  decimals?: number,
  range?: { min: number; max: number },
): ValueFormatter {
  const d = clampDecimals(decimals);
  const id = unit && isKnownUnit(unit) ? unit : 'none';

  // percent and percentunit never take an SI ladder: 1500 with unit `percent`
  // is 1500%, not 1.5 K%. This is the most common unit misconfiguration in real
  // dashboards, so it is handled explicitly rather than falling through.
  if (id === 'percent' || id === 'percentunit') {
    const factor = id === 'percentunit' ? 100 : 1;
    const build = (v: number): FormattedValue => {
      const scaled = v * factor;
      const text = fixed(scaled, d ?? autoDecimals(scaled));
      return { prefix: '', text, suffix: '%', formatted: `${text}%` };
    };
    return makeFormatter(build, '%');
  }

  if (id in TIME_ENTRY) {
    const entry = TIME_ENTRY[id];
    // A pinned range picks one step for the whole set.
    const pinned = range ? scaleTime(pickPin(range), entry, d) : null;
    const build = (v: number): FormattedValue => {
      const s = pinned
        ? { value: (v * entry) / secondsOf(pinned.suffix), suffix: pinned.suffix }
        : scaleTime(v, entry, d);
      const text = fixed(s.value, d ?? autoDecimals(s.value));
      return { prefix: '', text, suffix: s.suffix, formatted: text + s.suffix };
    };
    return makeFormatter(build, pinned?.suffix ?? '');
  }

  const ladder = ladderFor(id);
  if (!ladder) {
    const build = (v: number): FormattedValue => {
      const text = d === undefined ? GROUPING.format(v) : fixed(v, d);
      return { prefix: '', text, suffix: '', formatted: text };
    };
    return makeFormatter(build, '');
  }

  const pinnedStep = range ? scaleLadder(pickPin(range), ladder, d) : null;
  const pinnedDivisor = pinnedStep
    ? Math.pow(ladder.base, ladder.up.indexOf(pinnedStep.suffix.trim()))
    : 1;

  const build = (v: number): FormattedValue => {
    const s = pinnedStep
      ? { value: v / pinnedDivisor, suffix: pinnedStep.suffix }
      : scaleLadder(v, ladder, d);
    const text = fixed(s.value, d ?? autoDecimals(s.value));
    return { prefix: '', text, suffix: s.suffix, formatted: text + s.suffix };
  };
  return makeFormatter(build, pinnedStep?.suffix ?? '');
}

function secondsOf(suffix: string): number {
  const match = TIME_STEPS.find((s) => s.suffix === suffix.trim());
  return match ? match.scale : 1;
}

/** The magnitude a pinned scale is chosen from: the larger extreme. */
function pickPin(range: { min: number; max: number }): number {
  return Math.abs(range.max) >= Math.abs(range.min) ? range.max : range.min;
}

function makeFormatter(build: (v: number) => FormattedValue, suffix: string): ValueFormatter {
  const parts = (value: number | null | undefined): FormattedValue => {
    if (value == null || !Number.isFinite(value)) return EMPTY;
    return build(value);
  };
  return {
    parts,
    text: (value) => parts(value).formatted,
    suffix,
  };
}

/** Per-value sugar. Prefer {@link formatter} for anything rendered as a set. */
export function formatValue(
  value: number | null | undefined,
  unit?: string,
  decimals?: number,
): FormattedValue {
  return formatter(unit, decimals).parts(value);
}

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

/**
 * Format a whole tick array against one pinned scale.
 *
 * Shaped for uPlot's `axes[].values`, which hands over every tick at once —
 * which is also the only place the scale can be derived from the set rather
 * than guessed per value.
 */
export function formatAxisTicks(ticks: readonly number[], unit?: string, decimals?: number): string[] {
  if (ticks.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const t of ticks) {
    if (!Number.isFinite(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (!Number.isFinite(min)) return ticks.map(() => '');
  const f = formatter(unit, decimals, { min, max });
  return ticks.map((t) => f.text(t));
}

/**
 * A duration rendered for a human reading an axis: `1h 15m`, not `4512.4 s`.
 *
 * Deliberately separate from value formatting — one function doing both is how
 * axes end up unreadable.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const sign = seconds < 0 ? '-' : '';
  let s = Math.abs(seconds);
  if (s < 1) return `${sign}${formatter('s').text(Math.abs(seconds))}`;

  const days = Math.floor(s / 86400);
  s -= days * 86400;
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const minutes = Math.floor(s / 60);
  s -= minutes * 60;
  const secs = Math.floor(s);

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs && parts.length < 2) parts.push(`${secs}s`);
  return sign + (parts.slice(0, 2).join(' ') || '0s');
}
