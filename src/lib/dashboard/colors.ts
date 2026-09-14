/**
 * Chart colors — the categorical palette, threshold and status colors, ramps,
 * and chart chrome.
 *
 * Pure, isomorphic, dependency-free. The theme is a PARAMETER, never read from
 * the DOM: this runs on the server too, and three components currently each run
 * their own `MutationObserver` on `documentElement.classList`, which is the
 * duplication this module exists to end.
 *
 * ## The palette is measured, not chosen
 *
 * Validated with the data-viz validator against all four surfaces a panel can
 * sit on — `--card` (#FAFAFA / #1A1A1A) and, for a transparent panel,
 * `--background` (#FFFFFF / #0F0F0F). Every hard gate passes in both modes on
 * all four, with no contrast warning:
 *
 *   light  worst adjacent CVD ΔE 9.0 (protan) · normal-vision ΔE 17.4 · contrast PASS
 *   dark   worst adjacent CVD ΔE 8.4 (protan) · normal-vision ΔE 19.3 · contrast PASS
 *
 * Three light slots (aqua, yellow, magenta) are stepped darker than the
 * reference palette specifically to clear 3:1 on #FAFAFA. That is deliberate:
 * the alternative was a standing obligation on every panel to ship direct
 * labels, which is unenforceable from a shared module and would have been
 * inherited by four good-first-issue contributors.
 *
 * ## Slot order is the CVD-safety mechanism, not decoration
 *
 * All 20,160 orderings of these eight hues were enumerated and scored on the
 * worst adjacent CVD separation across both modes. This order ranks 49th
 * overall (min ΔE 8.4) but is the **maximum achievable with blue at slot 1**
 * — every higher-scoring order opens on orange, aqua, yellow, green or red,
 * which would make every single-series chart in the product that color.
 *
 * Two constraints that fall out of that enumeration and must survive any future
 * change:
 *
 * - **Arc purple can never sit adjacent to blue.** `#A855F7` vs `#3987e5` is
 *   ΔE 2.9 under deuteranopia — effectively the same color. This is why slot 7
 *   is where the brand color goes, and why assignment must not skip slots.
 * - **Colors are assigned as a PREFIX of this order, never by hashing a name.**
 *   Hashing lets any two slots land side by side, which changes the applicable
 *   gate from adjacent pairs to all 28 pairs — and under that gate this palette
 *   fails hard (orange↔green CVD ΔE 3.2, red↔orange normal-vision ΔE 7.1). With
 *   a uniform hash over 8 slots, one in four two-series dark charts would be
 *   unreadable to a deuteranope. Stability under filtering comes from the
 *   caller passing `prior`, not from a hash.
 */

import { isSafeColor, type FieldConfig, type ThresholdsConfig } from './model';

export type ColorScheme = 'light' | 'dark';

export type StatusRole = 'good' | 'warning' | 'serious' | 'critical';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const PALETTE_LIGHT = [
  '#2a78d6', // 1 blue
  '#eb6834', // 2 orange
  '#0aa572', // 3 aqua
  '#c48403', // 4 yellow
  '#d76e96', // 5 magenta
  '#008300', // 6 green
  '#A855F7', // 7 Arc purple
  '#e34948', // 8 red
] as const;

export const PALETTE_DARK = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#A855F7',
  '#e66767',
] as const;

export const PALETTE_SIZE = PALETTE_LIGHT.length;

/**
 * Series shown together on a chart whose marks can be arbitrarily juxtaposed —
 * small multiples (#37's repeat), scatter, a table's colored cells — are gated
 * on ALL pairs rather than adjacent ones, and only the first three slots clear
 * that. Past three, fold to "Other" or facet.
 */
export const ALL_PAIRS_SAFE_SLOTS = 3;

export function palette(scheme: ColorScheme): readonly string[] {
  return scheme === 'dark' ? PALETTE_DARK : PALETTE_LIGHT;
}

/**
 * The color for a slot, or null past the end of the palette.
 *
 * Null rather than a wrapped or repeated color, so the caller is forced by the
 * type to decide what a 9th series does. Reusing slot 8 would paint an ordinary
 * series in the alarm red, and every series past the eighth identically.
 */
export function seriesColorAt(index: number, scheme: ColorScheme): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= PALETTE_SIZE) return null;
  return palette(scheme)[index];
}

export interface SeriesColorAssignment {
  /** Series name to color. Names in `overflow` are absent. */
  colors: Map<string, string>;
  /** Series name to slot index. Pass back as `prior` to keep colors stable. */
  slots: Record<string, number>;
  /** Names with no slot left. The caller folds these into "Other" or facets. */
  overflow: string[];
}

/**
 * Assign palette slots to a set of series.
 *
 * Set-based rather than per-name, because a per-name function cannot see the
 * set and therefore cannot allocate a contiguous prefix, detect a collision, or
 * report overflow.
 *
 * Pass the previous run's `slots` as `prior` to keep a series on its color when
 * another series is filtered out — colour follows the entity, not its rank.
 * Slots held by `prior` are reserved before any new name is placed.
 */
export function assignSeriesColors(
  names: readonly string[],
  scheme: ColorScheme,
  prior?: Readonly<Record<string, number>>,
): SeriesColorAssignment {
  const colors = new Map<string, string>();
  const slots: Record<string, number> = {};
  const overflow: string[] = [];
  const taken = new Set<number>();
  const ramp = palette(scheme);

  // Reserve first, so a returning series keeps its slot even if a new name
  // sorts before it.
  if (prior) {
    for (const name of names) {
      const slot = prior[name];
      if (Number.isInteger(slot) && slot >= 0 && slot < PALETTE_SIZE && !taken.has(slot)) {
        taken.add(slot);
        slots[name] = slot;
      }
    }
  }

  let next = 0;
  for (const name of names) {
    if (name in slots) {
      colors.set(name, ramp[slots[name]]);
      continue;
    }
    while (next < PALETTE_SIZE && taken.has(next)) next++;
    if (next >= PALETTE_SIZE) {
      overflow.push(name);
      continue;
    }
    taken.add(next);
    slots[name] = next;
    colors.set(name, ramp[next]);
  }

  return { colors, slots, overflow };
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/**
 * Grafana's palette tokens, as stored in imported dashboards.
 *
 * `isSafeColor` accepts these verbatim for import fidelity, but MOST OF THEM
 * ARE NOT VALID CSS: `dark-red`, `semi-dark-orange`, `super-light-blue`, `text`
 * and `panel-bg` are all dropped silently by a `style:` directive, leaving the
 * element to inherit. `green` and `red` — Grafana's threshold defaults — happen
 * to be real CSS keywords, so the common case appears to work while every
 * imported variant fails invisibly.
 *
 * Every color leaving this module goes through {@link resolveColor}.
 */
const HUE_STEPS: Record<string, Record<ColorScheme, string>> = {
  blue: { light: '#2a78d6', dark: '#3987e5' },
  green: { light: '#008300', dark: '#12a012' },
  red: { light: '#e34948', dark: '#e66767' },
  orange: { light: '#eb6834', dark: '#d95926' },
  yellow: { light: '#c48403', dark: '#c98500' },
  purple: { light: '#A855F7', dark: '#A855F7' },
};

const MODIFIERS: Record<string, number> = {
  'super-light-': 1.45,
  'light-': 1.2,
  '': 1,
  'semi-dark-': 0.82,
  'dark-': 0.66,
};

function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.max(0, Math.min(255, Math.round(c * factor))),
  );
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Turn any stored color token into something a browser will actually render.
 *
 * Passes real hex and `rgb()`/`hsl()` through untouched; maps Grafana's tokens
 * onto this palette's hues per theme; maps `text` and `panel-bg` onto the
 * theme's ink and surface.
 */
export function resolveColor(token: string, scheme: ColorScheme): string {
  if (token.startsWith('#') || /^(rgba?|hsla?)\(/i.test(token)) return token;

  const lower = token.toLowerCase();
  if (lower === 'text') return chartInk(scheme).textPrimary;
  if (lower === 'panel-bg') return chartInk(scheme).surface;
  if (lower === 'transparent') return 'transparent';

  for (const [prefix, factor] of Object.entries(MODIFIERS)) {
    if (!lower.startsWith(prefix)) continue;
    const hue = prefix === '' ? lower : lower.slice(prefix.length);
    const base = HUE_STEPS[hue];
    if (base) return factor === 1 ? base[scheme] : shade(base[scheme], factor);
  }

  // A real CSS keyword we do not model (`white`, `teal`, …) is safe to emit;
  // isSafeColor already allowlisted it.
  return isSafeColor(token) ? token : chartInk(scheme).textSecondary;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface StatusStyle {
  /** The fill or mark color. */
  fill: string;
  /** A legal text color to place ON `fill`. */
  onFill: string;
  /** Icon name, so the status never rides on color alone. */
  icon: string;
  /** Human label, for the same reason. */
  label: string;
}

const STATUS: Record<StatusRole, { fill: string; icon: string; label: string }> = {
  good: { fill: '#0ca30c', icon: 'check-circle', label: 'OK' },
  warning: { fill: '#fab219', icon: 'alert-triangle', label: 'Warning' },
  serious: { fill: '#ec835a', icon: 'alert-octagon', label: 'Serious' },
  critical: { fill: '#d03b3b', icon: 'x-octagon', label: 'Critical' },
};

/**
 * A status color together with the things that must accompany it.
 *
 * Returns the icon and label rather than just a hex so a panel physically
 * cannot render the fill without them: on a light surface `warning` is 1.83:1,
 * which fails WCAG for text outright, and white on `#fab219` in a stat tile's
 * background mode is the same failure. `onFill` is the legal ink for that fill.
 *
 * Status colors are reserved. They are never "series 4" — several sit within
 * ΔE 15 of a categorical slot, so a chart using both leans on the icon and
 * label, never on hue.
 *
 * Not themed: the same four steps clear 3:1 on both dark surfaces, and on light
 * `warning` and `serious` are sub-3:1 by design, with the icon-and-label
 * pairing as the mitigation.
 */
export function statusColor(role: StatusRole): StatusStyle {
  const s = STATUS[role];
  return { fill: s.fill, onFill: onFillInk(s.fill), icon: s.icon, label: s.label };
}

/** Black or white, whichever has more contrast against `fill`. */
function onFillInk(fill: string): string {
  const n = parseInt(fill.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const onWhite = 1.05 / (lum + 0.05);
  const onBlack = (lum + 0.05) / 0.05;
  return onBlack >= onWhite ? '#0F0F0F' : '#FFFFFF';
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export interface ThresholdContext {
  scheme: ColorScheme;
  /** Required for `percentage` mode: the field's declared or data range. */
  min?: number;
  max?: number;
}

/**
 * A threshold config flattened for fast repeated lookup.
 *
 * Built once per field rather than resolved per value: #41 colors 25,000
 * heatmap cells against an acceptance criterion of 16ms for the whole redraw,
 * and #38 colors up to 100k table cells. Sorting and resolving tokens per cell
 * would exceed that budget before a single fill.
 */
export interface ThresholdScale {
  /** Ascending. `boundaries[i]` is the lower bound of `colors[i + 1]`. */
  readonly boundaries: Float64Array;
  /** One longer than `boundaries`; `colors[0]` is the base. */
  readonly colors: readonly string[];
}

export function thresholdScale(
  config: ThresholdsConfig | undefined,
  ctx: ThresholdContext,
): ThresholdScale {
  const fallback = chartInk(ctx.scheme).textSecondary;
  if (!config || config.steps.length === 0) {
    return { boundaries: new Float64Array(0), colors: [fallback] };
  }

  const percentage = config.mode === 'percentage';
  const hasRange = Number.isFinite(ctx.min) && Number.isFinite(ctx.max);
  // Percentage without a range cannot be converted; degrade to the base color
  // rather than silently comparing a percent against an absolute value.
  const usable = !percentage || hasRange;

  const steps = config.steps
    .map((s) => ({
      value:
        s.value === null
          ? null
          : percentage && hasRange
            ? ctx.min! + (ctx.max! - ctx.min!) * (s.value / 100)
            : s.value,
      color: resolveColor(s.color, ctx.scheme),
    }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return 0;
      if (a.value === null) return -1;
      if (b.value === null) return 1;
      return a.value - b.value;
    });

  if (!usable) return { boundaries: new Float64Array(0), colors: [steps[0]?.color ?? fallback] };

  // A config with no base step is legal; the neutral ink stands in below the
  // first boundary rather than borrowing a categorical hue.
  const base = steps[0]?.value === null ? steps[0].color : fallback;
  const rest = steps.filter((s) => s.value !== null) as Array<{ value: number; color: string }>;

  const boundaries = new Float64Array(rest.length);
  const colors: string[] = [base];
  for (let i = 0; i < rest.length; i++) {
    boundaries[i] = rest[i].value;
    colors.push(rest[i].color);
  }
  return { boundaries, colors };
}

/**
 * The color for a value. A step activates at `value >= step.value`, matching
 * Grafana, so a value exactly on a boundary takes the higher step.
 *
 * `null` and non-finite values take the base color — deliberately, not by the
 * accident that `NaN >= x` is always false.
 */
export function thresholdColorAt(scale: ThresholdScale, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return scale.colors[0];
  const b = scale.boundaries;
  let lo = 0;
  let hi = b.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (value >= b[mid]) lo = mid + 1;
    else hi = mid;
  }
  return scale.colors[lo];
}

// ---------------------------------------------------------------------------
// Field colour resolution
// ---------------------------------------------------------------------------

export interface FieldColorContext extends ThresholdContext {
  /** Slot assignment for the chart's series, from {@link assignSeriesColors}. */
  slots?: Readonly<Record<string, number>>;
}

/**
 * One closure per field, resolving `FieldConfig.color.mode` to a color.
 *
 * The single entry point panels use. Without it, each of the seven panels
 * writes the same five-way switch and #37's acceptance criterion — "threshold
 * coloring matches the shared threshold evaluator, not a local
 * reimplementation" — is unverifiable.
 */
export function fieldColorFn(
  config: FieldConfig,
  ctx: FieldColorContext,
): (value: number | null, seriesName: string, seriesIndex: number) => string {
  const mode = config.color?.mode ?? 'palette-classic-by-name';
  const ramp = palette(ctx.scheme);
  const fallback = chartInk(ctx.scheme).textSecondary;

  if (mode === 'fixed') {
    const fixedColor = resolveColor(
      (config.color as { mode: 'fixed'; fixedColor: string }).fixedColor,
      ctx.scheme,
    );
    return () => fixedColor;
  }

  if (mode === 'thresholds') {
    const scale = thresholdScale(config.thresholds, ctx);
    return (value) => thresholdColorAt(scale, value);
  }

  if (mode === 'continuous') {
    const ramp256 = sequentialRamp(ctx.scheme);
    const min = ctx.min ?? 0;
    const max = ctx.max ?? 1;
    return (value) => {
      if (value == null || !Number.isFinite(value) || max === min) return fallback;
      const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
      return ramp256[Math.round(t * (ramp256.length - 1))];
    };
  }

  // Both palette modes read the assignment; `palette-classic-by-name` differs
  // only in that the caller built `slots` from names rather than order.
  return (_value, seriesName, seriesIndex) => {
    const slot = ctx.slots?.[seriesName];
    if (Number.isInteger(slot)) return ramp[slot as number];
    return seriesColorAt(seriesIndex, ctx.scheme) ?? fallback;
  };
}

// ---------------------------------------------------------------------------
// Ramps
// ---------------------------------------------------------------------------

/**
 * The documented blue ramp, 100 to 700. Already perceptually uniform — adjacent
 * steps differ by OKLCH ΔL 0.046 to 0.049.
 */
const BLUE_RAMP = [
  '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec',
  '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab',
  '#184f95', '#104281', '#0d366b',
] as const;

const RED_RAMP = [
  '#fbd5d5', '#f6b8b8', '#f09a9a', '#ea7d7d', '#e46060',
  '#e34948', '#d03b3b', '#b83333', '#9f2c2c', '#872525',
] as const;

const NEUTRAL: Record<ColorScheme, string> = { light: '#f0efec', dark: '#383835' };

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function hexToOklab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = srgbToLinear(((n >> 16) & 255) / 255);
  const g = srgbToLinear(((n >> 8) & 255) / 255);
  const b = srgbToLinear((n & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToHex(L: number, a: number, bb: number): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  const r = linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const b = linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  const to = (c: number) =>
    Math.max(0, Math.min(255, Math.round(c * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Interpolate between adjacent documented steps, in OKLab. */
function rampFrom(steps: readonly string[], count: number): string[] {
  const labs = steps.map(hexToOklab);
  const out = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * (labs.length - 1);
    const lo = Math.min(Math.floor(t), labs.length - 2);
    const f = t - lo;
    const a = labs[lo];
    const b = labs[lo + 1];
    out[i] = oklabToHex(
      a[0] + (b[0] - a[0]) * f,
      a[1] + (b[1] - a[1]) * f,
      a[2] + (b[2] - a[2]) * f,
    );
  }
  return out;
}

/**
 * A precomputed sequential ramp, light to dark.
 *
 * Returns an ARRAY, not a function of `t`. Calling a per-value color function
 * for a 500x50 heatmap measured 18.66ms against a 16ms budget for the entire
 * redraw; indexing a 256-entry lookup measured 0.13ms. A panel builds this once
 * per theme.
 *
 * Interpolated in OKLab between the documented steps: sRGB interpolation loses
 * about half the chroma at the midpoint, which is exactly where a latency
 * distribution's mass sits.
 */
export function sequentialRamp(scheme: ColorScheme, steps = 256): string[] {
  const base = scheme === 'dark' ? [...BLUE_RAMP].reverse() : [...BLUE_RAMP];
  return rampFrom(base, steps);
}

/**
 * A diverging ramp, blue to neutral to red, anchored so the midpoint is the
 * zero of the caller's domain.
 *
 * The caller must normalize so that index `steps/2` means "no change" — a
 * linear map of an asymmetric `[min, max]` onto the ramp puts the neutral
 * midpoint somewhere that is not zero and asserts a polarity flip that the data
 * does not contain.
 */
export function divergingRamp(scheme: ColorScheme, steps = 256): string[] {
  const half = Math.floor(steps / 2);
  const cool = rampFrom([...BLUE_RAMP].reverse().slice(0, 7), half).reverse();
  const warm = rampFrom([...RED_RAMP].slice(0, 7), steps - half);
  return [...cool, NEUTRAL[scheme], ...warm].slice(0, steps);
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

export interface ChartInk {
  surface: string;
  gridline: string;
  axis: string;
  muted: string;
  textPrimary: string;
  textSecondary: string;
}

/**
 * Chart chrome, so panels stop hardcoding gridline and axis colors — which
 * `MetricChart` and `LogHistogram` each do today, differently.
 */
export function chartInk(scheme: ColorScheme): ChartInk {
  return scheme === 'dark'
    ? {
        surface: '#1A1A1A',
        gridline: '#262626',
        axis: '#525252',
        muted: '#737373',
        textPrimary: '#FAFAFA',
        textSecondary: '#a3a3a3',
      }
    : {
        surface: '#FAFAFA',
        gridline: '#f0f0f0',
        axis: '#d4d4d4',
        muted: '#a3a3a3',
        textPrimary: '#0F0F0F',
        textSecondary: '#525252',
      };
}

/**
 * A color with alpha applied, for fills under a line.
 *
 * `${color}20` string concatenation — what `MetricChart` does today — breaks for
 * three-digit hex, named colors, and `rgb()`.
 */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const full =
      hex.length === 3 || hex.length === 4
        ? hex
            .slice(0, 3)
            .split('')
            .map((c) => c + c)
            .join('')
        : hex.slice(0, 6);
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (m) {
    const parts = m[1].split(/[,/]/).map((p) => p.trim()).slice(0, 3);
    return `rgba(${parts.join(', ')}, ${a})`;
  }
  return color;
}
