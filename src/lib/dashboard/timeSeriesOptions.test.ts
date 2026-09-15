import { describe, it, expect } from 'vitest';
import {
  CUSTOM_DEFAULTS,
  buildTimeSeriesOptions,
  restyle,
  type BuildArgs,
  type Ink,
} from './timeSeriesOptions';
import { hasPanelRenderer, loadPanel, renderablePanelTypes } from './panelRegistry';
import { normalizeFrame, type Frame } from './frame';
import { PALETTE_SIZE, chartInk } from './colors';
import { fieldCustom, type FieldConfigSource } from './model';

const FROM = Date.UTC(2026, 0, 1, 0, 0, 0);
const TO = Date.UTC(2026, 0, 1, 6, 0, 0);

const wide = (columns: string[], rows: unknown[][], refId?: string): Frame =>
  normalizeFrame({ columns, rows }, { refId });

const build = (over: Partial<BuildArgs> = {}) =>
  buildTimeSeriesOptions({
    frames: [wide(['time', 'cpu'], [['2026-01-01T00:00:00Z', 1], ['2026-01-01T01:00:00Z', 2]])],
    from: FROM,
    to: TO,
    scheme: 'light',
    timezone: 'UTC',
    ...over,
  });

const opts = (r: ReturnType<typeof build>) => r.options as Record<string, unknown>;

// ===========================================================================
// The uPlot traps
// ===========================================================================

describe('uPlot configuration', () => {
  it('sets ms: 1, because uPlot assumes SECONDS', () => {
    // frame.ts emits epoch milliseconds and both older charts in this repo
    // divide by 1000. Without this every tick label is wrong by 1000x.
    expect(opts(build()).ms).toBe(1);
  });

  it('PINS the x scale to the dashboard range rather than the data', () => {
    // setData() calls autoScaleX unless passed false, and a query returning 40
    // minutes of a 1-hour range would otherwise shrink that panel's axis so it
    // stops lining up with its neighbours.
    const scales = opts(build()).scales as { x: { range: () => [number, number]; time: boolean } };
    expect(scales.x.time).toBe(true);
    expect(scales.x.range()).toEqual([FROM, TO]);
  });

  it('turns uPlot own legend off', () => {
    // It is a table inside the plot root, so it cannot sit to the right; and its
    // marker colours are inline styles written once, so a theme change would
    // leave every marker stale.
    expect((opts(build()).legend as { show: boolean }).show).toBe(false);
  });

  it('does not enable drag-to-zoom or cursor sync', () => {
    // cursor.sync forwards mousedown/mouseup/dblclick as well as the cursor, so
    // one drag would zoom every synced panel and push a history entry per panel.
    const cursor = opts(build()).cursor as { drag: { x: boolean; setScale: boolean }; sync?: unknown };
    expect(cursor.drag.x).toBe(false);
    expect(cursor.drag.setScale).toBe(false);
    expect(cursor.sync).toBeUndefined();
  });

  it('passes tzDate when one is supplied', () => {
    // uPlot formats in the BROWSER's zone by default, so axis labels would read
    // hours away from the zone the data was bucketed in.
    const tzDate = (ts: number) => new Date(ts);
    expect(opts(build({ tzDate })).tzDate).toBe(tzDate);
  });
});

// ===========================================================================
// Colours as closures
// ===========================================================================

describe('colours', () => {
  it('makes every colour a FUNCTION, not a string', () => {
    // uPlot wraps stroke/fill in fnOrSelf at construction and invokes them per
    // draw. A string assigned later throws `s.stroke is not a function` inside
    // drawSeries and kills the panel.
    const series = opts(build()).series as Array<{ stroke?: unknown }>;
    expect(typeof series[1].stroke).toBe('function');
  });

  it('reads through the ink ref, so a theme change needs no rebuild', () => {
    const result = build();
    const series = opts(result).series as Array<{ stroke: () => string }>;
    const before = series[1].stroke();

    restyle(result.ink, 'dark', result.series.map((s) => s.label), result.slots);
    const after = series[1].stroke();

    expect(after).not.toBe(before);
    // The SAME closure now returns the dark colour — no new options object.
    expect(typeof series[1].stroke).toBe('function');
  });

  it('keeps a series on its colour when another is filtered out', () => {
    const three = wide(
      ['time', 'a', 'b', 'c'],
      [['2026-01-01T00:00:00Z', 1, 2, 3]],
    );
    const first = build({ frames: [three] });
    const two = wide(['time', 'a', 'c'], [['2026-01-01T00:00:00Z', 1, 3]]);
    const after = build({ frames: [two], priorSlots: first.slots });
    expect(after.slots.a).toBe(first.slots.a);
    expect(after.slots.c).toBe(first.slots.c);
  });

  it('marks series past the palette instead of drawing them invisibly grey', () => {
    // seriesColorAt returns null past slot 8 and the fallback is the axis-text
    // colour, so series 9 and 10 would both be grey on grey.
    const many = ['time', ...Array.from({ length: PALETTE_SIZE + 2 }, (_, i) => `s${i}`)];
    const row = ['2026-01-01T00:00:00Z', ...Array.from({ length: PALETTE_SIZE + 2 }, () => 1)];
    const result = build({ frames: [wide(many, [row])] });
    const over = result.series.filter((s) => s.overflow);
    expect(over.length).toBe(2);
    const series = opts(result).series as Array<{ dash?: number[] }>;
    expect(series[PALETTE_SIZE + 1].dash).toBeDefined();
  });
});

// ===========================================================================
// Refusals — drawing nothing beats drawing a confident lie
// ===========================================================================

describe('refusals', () => {
  it('refuses a frame with no time column', () => {
    const r = build({ frames: [wide(['a', 'b'], [[1, 2]])] });
    expect(r.refusal).toContain('no time column');
    expect(r.series).toEqual([]);
  });

  it('refuses a capped pivot rather than drawing interleaved rows', () => {
    // toWide returns the UNPIVOTED frame with shape 'long' when it hits the
    // pivot cap, so toAligned would produce one series of interleaved rows with
    // a non-monotonic x — which breaks uPlot's cursor binary search and draws a
    // confidently wrong chart.
    // This is exactly the frame toWide returns when it hits the pivot cap: the
    // un-pivoted frame plus the notice. Building a genuinely over-cap frame
    // would need a million cells.
    const base = wide(['time', 'v'], [['2026-01-01T00:00:00Z', 1]]);
    const cappedFrame: Frame = {
      ...base,
      shape: 'long',
      notices: [{ code: 'series-capped', level: 'warning', message: 'too many series' }],
    };
    expect(build({ frames: [cappedFrame] }).refusal).toContain('Too many series');
  });

  it('handles no frames without throwing', () => {
    const r = build({ frames: [] });
    expect(r.refusal).toBeNull();
    expect(r.series).toEqual([]);
  });

  it('says so when the colour mode is per-value', () => {
    // thresholds and continuous colour a VALUE, not a series — colouring a whole
    // line by whatever single value was passed would be silently wrong.
    const fc = { defaults: { color: { mode: 'thresholds' } } } as unknown as FieldConfigSource;
    expect(build({ fieldConfig: fc }).refusal).toContain('per-value colour mode');
  });
});

// ===========================================================================
// Nulls
// ===========================================================================

describe('null handling', () => {
  const gappy = () =>
    wide(['time', 'v'], [
      ['2026-01-01T00:00:00Z', 1],
      ['2026-01-01T01:00:00Z', null],
      ['2026-01-01T02:00:00Z', 3],
    ]);

  it('keeps nulls as null, which is what makes a gap a gap', () => {
    // A typed array can only carry NaN, which uPlot draws as a line through
    // zero rather than a gap.
    const data = build({ frames: [gappy()] }).data;
    expect(data[1][1]).toBeNull();
  });

  it('spans gaps only in connect mode', () => {
    const fc = (spanNulls: string) =>
      ({ defaults: { custom: { spanNulls } } }) as unknown as FieldConfigSource;
    const gaps = opts(build({ frames: [gappy()], fieldConfig: fc('gaps') })).series as Array<{ spanGaps: boolean }>;
    const connect = opts(build({ frames: [gappy()], fieldConfig: fc('connect') })).series as Array<{ spanGaps: boolean }>;
    expect(gaps[1].spanGaps).toBe(false);
    expect(connect[1].spanGaps).toBe(true);
  });

  it('zero mode produces a NEW array, leaving the frame untouched', () => {
    // Frames are immutable and shared between panels by the query cache, so
    // writing zeros in place would corrupt another panel's data.
    const frame = gappy();
    const before = [...(frame.fields[1].values as (number | null)[])];
    const fc = { defaults: { custom: { spanNulls: 'zero' } } } as unknown as FieldConfigSource;
    const data = build({ frames: [frame], fieldConfig: fc }).data;
    expect(data[1][1]).toBe(0);
    expect(frame.fields[1].values).toEqual(before);
  });
});

// ===========================================================================
// Multiple targets
// ===========================================================================

describe('multiple targets', () => {
  const a = () => wide(['time', 'value'], [['2026-01-01T00:00:00Z', 1]], 'A');
  const b = () => wide(['time', 'value'], [['2026-01-01T00:00:00Z', 2]], 'B');

  it('prefixes series with refId so identical names do not collide', () => {
    // assignSeriesColors is keyed by name, so two targets each returning
    // `value` would silently share one colour and one slot.
    const r = build({ frames: [a(), b()] });
    expect(r.series.map((s) => s.label)).toEqual(['A: value', 'B: value']);
    expect(Object.keys(r.slots)).toHaveLength(2);
  });

  it('does not prefix a single target', () => {
    expect(build({ frames: [a()] }).series[0].label).toBe('value');
  });

  it('concatenates directly when the x columns match', () => {
    const r = build({ frames: [a(), b()] });
    expect(r.data).toHaveLength(3); // x + 2 series
    expect(r.data[0]).toHaveLength(1);
  });

  it('unions x when the frames disagree, padding with null not zero', () => {
    const later = wide(['time', 'value'], [['2026-01-01T02:00:00Z', 9]], 'B');
    const r = build({ frames: [a(), later] });
    expect(r.data[0]).toHaveLength(2);
    // B has no reading at A's timestamp: that is a gap, not a zero.
    expect(r.data[2][0]).toBeNull();
    expect(r.data[2][1]).toBe(9);
  });

  it('keeps the unioned x sorted, which uPlot requires', () => {
    const later = wide(['time', 'value'], [['2026-01-01T02:00:00Z', 9]], 'B');
    const earlier = wide(['time', 'value'], [['2025-12-31T00:00:00Z', 1]], 'C');
    const x = build({ frames: [later, earlier] }).data[0];
    for (let i = 1; i < x.length; i++) expect(x[i]).toBeGreaterThan(x[i - 1]);
  });
});

// ===========================================================================
// Shape key
// ===========================================================================

describe('shapeKey', () => {
  it('is stable for the same series across ticks', () => {
    // The query cache returns a new frame object every tick, so identity is not
    // a usable rebuild signal — only the shape is.
    expect(build().shapeKey).toBe(build().shapeKey);
  });

  it.each([
    ['series count', () => build({ frames: [wide(['time', 'a', 'b'], [['2026-01-01T00:00:00Z', 1, 2]])] })],
    ['draw style', () => build({ fieldConfig: { defaults: { custom: { drawStyle: 'bars' } } } as never })],
    ['null mode', () => build({ fieldConfig: { defaults: { custom: { spanNulls: 'connect' } } } as never })],
    ['timezone', () => build({ timezone: 'Asia/Kolkata' })],
  ])('changes when the %s changes', (_label, make) => {
    expect(make().shapeKey).not.toBe(build().shapeKey);
  });
});

// ===========================================================================
// Display options
// ===========================================================================

describe('fieldCustom', () => {
  it('applies defaults when nothing is stored', () => {
    expect(fieldCustom(undefined, CUSTOM_DEFAULTS)).toEqual(CUSTOM_DEFAULTS);
  });

  it('lets a stored value win', () => {
    const fc = { defaults: { custom: { lineWidth: 3 } } } as unknown as FieldConfigSource;
    expect(fieldCustom(fc, CUSTOM_DEFAULTS).lineWidth).toBe(3);
  });

  it('keeps the other defaults, which a nested bag would not', () => {
    const fc = { defaults: { custom: { lineWidth: 3 } } } as unknown as FieldConfigSource;
    expect(fieldCustom(fc, CUSTOM_DEFAULTS).drawStyle).toBe('line');
  });

  it('ignores a non-object custom bag', () => {
    const fc = { defaults: { custom: 'nope' } } as unknown as FieldConfigSource;
    expect(fieldCustom(fc, CUSTOM_DEFAULTS)).toEqual(CUSTOM_DEFAULTS);
  });
});

describe('axis range', () => {
  it('is automatic when neither bound is set', () => {
    expect((opts(build()).scales as { y: { range?: unknown } }).y.range).toBeUndefined();
  });

  it('honours an explicit min and max', () => {
    const fc = { defaults: { min: 0, max: 100 } } as unknown as FieldConfigSource;
    const range = (opts(build({ fieldConfig: fc })).scales as { y: { range: (u: unknown, a: number, b: number) => [number, number] } }).y.range;
    expect(range(null, -5, 5)).toEqual([0, 100]);
  });

  it('leaves one end automatic when only the other is set', () => {
    const fc = { defaults: { min: 0 } } as unknown as FieldConfigSource;
    const range = (opts(build({ fieldConfig: fc })).scales as { y: { range: (u: unknown, a: number, b: number) => [number, number] } }).y.range;
    expect(range(null, -5, 42)).toEqual([0, 42]);
  });
});

// ===========================================================================
// Registry
// ===========================================================================

describe('panelRegistry', () => {
  it('knows the time series panel', () => {
    expect(hasPanelRenderer('timeseries')).toBe(true);
    expect(renderablePanelTypes()).toContain('timeseries');
  });

  it('returns null for a type with no renderer yet, rather than throwing', () => {
    // Six of the seven types do not exist; the page renders "unsupported" from
    // this rather than blanking the dashboard.
    expect(hasPanelRenderer('heatmap')).toBe(false);
    return expect(loadPanel('heatmap')).resolves.toBeNull();
  });
});

describe('restyle', () => {
  const ink = (): Ink => ({
    scheme: 'light',
    colors: [],
    overflow: [],
    axis: '',
    grid: '',
    text: '',
  });

  it('swaps the chrome colours for the scheme', () => {
    const i = ink();
    restyle(i, 'dark', ['a'], {});
    expect(i.scheme).toBe('dark');
    expect(i.axis).toBe(chartInk('dark').axis);
  });

  it('mutates in place, so existing closures see the change', () => {
    const i = ink();
    const before = i;
    restyle(i, 'dark', ['a'], {});
    expect(i).toBe(before);
  });
});
