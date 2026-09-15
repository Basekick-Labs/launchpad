/**
 * Builds the uPlot configuration for a time series panel, plus the handful of
 * closures the component needs. Everything with a decision in it lives here so
 * it can be tested; the component is `new uPlot` / `setData` / `setSize` /
 * `destroy`.
 *
 * ## Colours are CLOSURES over a mutable ref, not strings
 *
 * uPlot normalises `series[i].stroke` and `.fill` with `fnOrSelf` at
 * construction and then INVOKES them on every draw
 * (`s._stroke = s.stroke(self, si)`). Assigning a colour string to restyle a
 * theme change throws `s.stroke is not a function` inside `drawSeries`, which
 * propagates out and — Svelte 4 having no error boundary — leaves a dead panel.
 *
 * So every colour reads from `ink`, the component swaps `ink` fields on a theme
 * change and calls `u.redraw(false)`, and no rebuild happens. This also fixes a
 * second-order trap: the per-series `points` bag captures the stroke FUNCTION at
 * construction, so mutating `series[i].stroke` would leave point markers on the
 * old colour even if strings worked.
 *
 * ## The x scale is PINNED to the dashboard range
 *
 * Not left on `auto`. Two reasons. `setData(d)` calls `autoScaleX()` unless
 * passed `false`, so the default throws away the viewport; and a query returning
 * 40 minutes of a 1-hour range would shrink that panel's axis so it no longer
 * lines up with its neighbours. Pinning also sidesteps uPlot's degenerate
 * single-point range, which with `ms: 1` is 86.4 seconds rather than a day.
 */

import type { Frame, Field } from './frame';
import { toWide } from './frame';
import { assignSeriesColors, chartInk, withAlpha, type ColorScheme } from './colors';
import { formatter } from './units';
import { fieldCustom, type FieldConfigSource } from './model';

/** uPlot's data shape, mutable — `frame.ts` exports a readonly tuple. */
export type UPlotData = [number[] | Float64Array, ...(number | null)[][]];

export const DRAW_STYLES = ['line', 'bars', 'points', 'stepped'] as const;
export type DrawStyle = (typeof DRAW_STYLES)[number];

export const NULL_MODES = ['gaps', 'connect', 'zero'] as const;
export type NullMode = (typeof NULL_MODES)[number];

/** The flat display bag, read from `fieldConfig.defaults.custom`. */
export interface TimeSeriesCustom extends Record<string, unknown> {
  drawStyle: DrawStyle;
  lineWidth: number;
  fillOpacity: number;
  pointSize: number;
  spanNulls: NullMode;
}

export const CUSTOM_DEFAULTS: TimeSeriesCustom = {
  drawStyle: 'line',
  lineWidth: 1,
  fillOpacity: 0,
  pointSize: 0,
  spanNulls: 'gaps',
};

/**
 * Mutable, and shared with every closure in the options. A theme change writes
 * here and redraws; it never rebuilds and never reassigns this object.
 */
export interface Ink {
  scheme: ColorScheme;
  /** One per series, index-aligned with `series[1..]`. */
  colors: string[];
  /** Series past the palette: drawn muted and dashed rather than invisibly grey. */
  overflow: boolean[];
  axis: string;
  grid: string;
  text: string;
}

export interface SeriesMeta {
  label: string;
  /** True when this series ran out of palette slots. */
  overflow: boolean;
}

export interface BuildResult {
  /** Passed to `new uPlot`. Typed loosely; uPlot's own types are structural. */
  options: Record<string, unknown>;
  data: UPlotData;
  ink: Ink;
  series: SeriesMeta[];
  /** Slot assignment to feed back as `prior` next time, so colours are stable. */
  slots: Record<string, number>;
  /** Set when the frame cannot be drawn honestly. The panel shows this instead. */
  refusal: string | null;
  /** A shape signature; when it changes the chart must be rebuilt, not setData'd. */
  shapeKey: string;
}

export interface BuildArgs {
  /** One per target. Joined when there is more than one. */
  frames: readonly Frame[];
  fieldConfig?: FieldConfigSource;
  /** The dashboard's resolved bounds. The x scale is pinned to these. */
  from: number;
  to: number;
  scheme: ColorScheme;
  /** A concrete IANA zone. Baked into `tzDate`, so changing it is a rebuild. */
  timezone: string;
  /** Previous slot assignment, so filtering a series does not repaint the rest. */
  priorSlots?: Record<string, number>;
  /** uPlot's `tzDate` helper, injected so this module imports no uPlot. */
  tzDate?: (ts: number) => Date;
}

/** Recomputes `ink.colors` in place for a new scheme. Never reassigns `ink`. */
export function restyle(ink: Ink, scheme: ColorScheme, labels: readonly string[], prior: Record<string, number>): void {
  const assigned = assignSeriesColors([...labels], scheme, prior);
  ink.scheme = scheme;
  ink.colors = labels.map((l) => assigned.colors.get(l) ?? chartInk(scheme).textSecondary);
  ink.overflow = labels.map((l) => !assigned.colors.has(l));
  const chrome = chartInk(scheme);
  ink.axis = chrome.axis;
  ink.grid = chrome.gridline;
  ink.text = chrome.textSecondary;
}

export function buildTimeSeriesOptions(args: BuildArgs): BuildResult {
  const chrome = chartInk(args.scheme);
  const ink: Ink = {
    scheme: args.scheme,
    colors: [],
    overflow: [],
    axis: chrome.axis,
    grid: chrome.gridline,
    text: chrome.textSecondary,
  };
  const empty = (refusal: string | null): BuildResult => ({
    options: {},
    data: [new Float64Array(0)] as UPlotData,
    ink,
    series: [],
    slots: {},
    refusal,
    shapeKey: `refused:${refusal ?? ''}`,
  });

  const usable = args.frames.filter((f) => f.length >= 0 && f.fields.length > 0);
  if (usable.length === 0) return empty(null);

  const wides = usable.map((f) => toWide(f));

  // Order matters: a table result has no time column AND is not 'wide', and the
  // useful message is the one about the time column.
  if (wides.every((w) => w.timeFieldIndex === -1)) {
    return empty('This query returned no time column, so it cannot be drawn as a time series.');
  }

  // A capped pivot returns the UNPIVOTED frame — `shape: 'long'` with the
  // original field indices — plus a `series-capped` notice. `toAligned` would
  // then produce ONE series built from interleaved rows of every series, with a
  // non-monotonic x, which breaks uPlot's cursor binary search and draws a
  // confidently wrong chart.
  //
  // Detected by the NOTICE rather than inferred from the shape: the notice is
  // what `toWide` actually promises, and a long frame small enough to pivot is
  // perfectly drawable.
  const capped = wides.find((w) => w.notices.some((n) => n.code === 'series-capped'));
  if (capped) {
    return empty('Too many series to chart. Narrow the query or add a LIMIT.');
  }
  const unwide = wides.find((w) => w.shape !== 'wide' && w.shape !== 'empty');
  if (unwide) {
    return empty('This result cannot be drawn as a time series.');
  }

  // `color.mode` thresholds and continuous colour a value, not a series. Calling
  // fieldColorFn per series would paint the whole line by whatever single value
  // happened to be passed. Refusing is honest; guessing is not.
  const mode = args.fieldConfig?.defaults?.color?.mode;
  const perValue = mode === 'thresholds' || mode === 'continuous';

  const joined = joinFrames(wides);
  const labels = joined.labels;
  const assigned = assignSeriesColors([...labels], args.scheme, args.priorSlots);
  restyle(ink, args.scheme, labels, assigned.slots);

  const custom = fieldCustom(args.fieldConfig, CUSTOM_DEFAULTS);
  const defaults = args.fieldConfig?.defaults;
  const unit = typeof defaults?.unit === 'string' ? defaults.unit : undefined;
  const decimals = typeof defaults?.decimals === 'number' ? defaults.decimals : undefined;
  const fmt = formatter(unit, decimals);

  const data = applyNullMode(joined.data, custom.spanNulls);

  const series = [
    { label: 'Time' },
    ...labels.map((label, i) => seriesConfig(label, i, ink, custom)),
  ];

  const options: Record<string, unknown> = {
    // uPlot's x unit is SECONDS unless told otherwise, and frames are epoch
    // milliseconds. Without this every tick label is wrong by 1000x.
    ms: 1,
    // Baked at construction — a timezone change is a rebuild.
    ...(args.tzDate ? { tzDate: args.tzDate } : {}),
    legend: { show: false }, // ours: uPlot's cannot sit to the right, and its
    // markers are inline styles written once, so a theme change would leave them stale.
    cursor: {
      // Drag-to-zoom and the shared crosshair are deliberately NOT here — see
      // the module header of the panel component and the follow-up issue.
      drag: { x: false, y: false, setScale: false },
      points: { show: custom.pointSize > 0 },
    },
    scales: {
      x: { time: true, range: () => [args.from, args.to] as [number, number] },
      y: { range: yRange(defaults) },
    },
    axes: [
      {
        stroke: () => ink.text,
        grid: { stroke: () => ink.grid, width: 1 },
        ticks: { stroke: () => ink.axis },
        border: { stroke: () => ink.axis },
      },
      {
        stroke: () => ink.text,
        grid: { stroke: () => ink.grid, width: 1 },
        ticks: { stroke: () => ink.axis },
        border: { stroke: () => ink.axis },
        values: (_u: unknown, splits: number[]) => splits.map((v) => fmt.text(v)),
      },
    ],
    series,
    padding: [8, 8, 0, 0],
  };

  return {
    options,
    data,
    ink,
    series: labels.map((label, i) => ({ label, overflow: ink.overflow[i] })),
    slots: assigned.slots,
    refusal: perValue
      ? 'This panel uses a per-value colour mode, which a time series cannot show. Showing palette colours instead.'
      : null,
    shapeKey: `${labels.join(' ')}|${custom.drawStyle}|${custom.spanNulls}|${args.timezone}`,
  };
}

function seriesConfig(label: string, i: number, ink: Ink, custom: TimeSeriesCustom) {
  const stroke = () => ink.colors[i] ?? ink.text;
  return {
    label,
    // Every colour is a closure over `ink` — see the module header.
    stroke,
    width: custom.lineWidth,
    fill: custom.fillOpacity > 0 ? () => withAlpha(ink.colors[i] ?? ink.text, custom.fillOpacity) : undefined,
    // A series past the palette is dashed as well as muted, so it is
    // distinguishable rather than silently the same grey as its neighbour.
    dash: ink.overflow[i] ? [6, 4] : undefined,
    points: {
      show: custom.pointSize > 0,
      size: custom.pointSize,
      stroke,
      fill: stroke,
    },
    // `spanGaps` is read inside the path builders at draw time, so it is a
    // restyle rather than a rebuild.
    spanGaps: custom.spanNulls === 'connect',
  };
}

/** Explicit min/max; `null` on either side leaves that end automatic. */
function yRange(defaults: FieldConfigSource['defaults'] | undefined) {
  const min = typeof defaults?.min === 'number' ? defaults.min : null;
  const max = typeof defaults?.max === 'number' ? defaults.max : null;
  if (min === null && max === null) return undefined;
  return (_u: unknown, dataMin: number, dataMax: number): [number, number] => [
    min ?? dataMin,
    max ?? dataMax,
  ];
}

/**
 * "Treat nulls as zero" produces a NEW array. Frames are immutable and shared
 * between panels by the query cache, so writing zeros into one would corrupt
 * another panel's data.
 */
function applyNullMode(data: UPlotData, mode: NullMode): UPlotData {
  if (mode !== 'zero') return data;
  const [x, ...ys] = data;
  return [x, ...ys.map((col) => col.map((v) => (v === null ? 0 : v)))] as UPlotData;
}

/**
 * One chart from up to ten targets.
 *
 * When every frame shares an x column — the common case, since every target
 * expands the same `$__timeGroup` against the same range — the columns are
 * concatenated directly. Otherwise the x values are unioned, which is the
 * expensive path and worth avoiding.
 *
 * Series names are prefixed with their `refId` when there is more than one
 * frame. `toWide` does not put `refId` in the field name, and
 * `assignSeriesColors` is keyed by name — so two targets returning a series
 * called `value` would silently share one colour and one slot.
 */
function joinFrames(frames: readonly Frame[]): { data: UPlotData; labels: string[] } {
  const usable = frames.filter((f) => f.timeFieldIndex !== -1 && f.length > 0);
  if (usable.length === 0) return { data: [new Float64Array(0)] as UPlotData, labels: [] };

  const prefix = frames.length > 1;
  const nameOf = (f: Frame, field: Field): string =>
    prefix && f.refId ? `${f.refId}: ${field.name}` : field.name;

  const xOf = (f: Frame) =>
    (f.fields[f.timeFieldIndex] as Extract<Field, { type: 'time' }>).values;

  const first = xOf(usable[0]);
  const sameX = usable.every((f) => {
    const x = xOf(f);
    if (x.length !== first.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== first[i]) return false;
    return true;
  });

  const labels: string[] = [];
  if (sameX) {
    const ys: (number | null)[][] = [];
    for (const f of usable) {
      for (const idx of f.numericFieldIndices) {
        const field = f.fields[idx] as Extract<Field, { type: 'number' }>;
        labels.push(nameOf(f, field));
        ys.push(field.values as (number | null)[]);
      }
    }
    return { data: [first, ...ys] as UPlotData, labels };
  }

  // Union of x values, sorted. Each series is then indexed into it.
  const all = new Set<number>();
  for (const f of usable) for (const v of xOf(f)) all.add(v);
  const x = Float64Array.from([...all].sort((a, b) => a - b));
  const position = new Map<number, number>();
  for (let i = 0; i < x.length; i++) position.set(x[i], i);

  const ys: (number | null)[][] = [];
  for (const f of usable) {
    const fx = xOf(f);
    for (const idx of f.numericFieldIndices) {
      const field = f.fields[idx] as Extract<Field, { type: 'number' }>;
      labels.push(nameOf(f, field));
      const col = new Array<number | null>(x.length).fill(null);
      for (let i = 0; i < fx.length; i++) {
        const at = position.get(fx[i]);
        if (at !== undefined) col[at] = field.values[i];
      }
      ys.push(col);
    }
  }
  return { data: [x, ...ys] as UPlotData, labels };
}
