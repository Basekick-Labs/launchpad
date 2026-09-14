import { describe, it, expect } from 'vitest';
import {
  PALETTE_LIGHT,
  PALETTE_DARK,
  PALETTE_SIZE,
  ALL_PAIRS_SAFE_SLOTS,
  assignSeriesColors,
  seriesColorAt,
  resolveColor,
  statusColor,
  thresholdScale,
  thresholdColorAt,
  fieldColorFn,
  sequentialRamp,
  divergingRamp,
  chartInk,
  withAlpha,
} from './colors';
import { isSafeColor, NAMED_COLORS, type FieldConfig } from './model';

/** WCAG relative luminance, for the contrast assertions below. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ===========================================================================
// The palette
// ===========================================================================

describe('palette', () => {
  it('clears 3:1 on every surface a panel can sit on', () => {
    // Four surfaces, not two: --card is #FAFAFA/#1A1A1A and a transparent panel
    // sits on --background #FFFFFF/#0F0F0F. Three light slots were stepped
    // darker than the reference palette specifically to clear #FAFAFA.
    for (const c of PALETTE_LIGHT) {
      expect(contrast(c, '#FAFAFA')).toBeGreaterThanOrEqual(3);
      expect(contrast(c, '#FFFFFF')).toBeGreaterThanOrEqual(3);
    }
    for (const c of PALETTE_DARK) {
      expect(contrast(c, '#1A1A1A')).toBeGreaterThanOrEqual(3);
      expect(contrast(c, '#0F0F0F')).toBeGreaterThanOrEqual(3);
    }
  });

  it('is accepted by the model validator', () => {
    // A stored fixedColor copied from the palette must pass isSafeColor — which
    // accepts hex/rgb/hsl but NOT oklch, so a future "modernization" of these
    // values would break saving. This catches that at build time.
    for (const c of [...PALETTE_LIGHT, ...PALETTE_DARK]) {
      expect(isSafeColor(c)).toBe(true);
    }
  });

  it('has the same number of slots in both modes', () => {
    expect(PALETTE_LIGHT).toHaveLength(PALETTE_SIZE);
    expect(PALETTE_DARK).toHaveLength(PALETTE_SIZE);
  });

  it('caps arbitrarily-juxtaposed marks at three slots', () => {
    // Small multiples and scatter are gated on all 28 pairs, not adjacent ones,
    // and only the first three clear that.
    expect(ALL_PAIRS_SAFE_SLOTS).toBe(3);
    expect(ALL_PAIRS_SAFE_SLOTS).toBeLessThan(PALETTE_SIZE);
  });
});

describe('seriesColorAt', () => {
  it('returns a color for each slot', () => {
    for (let i = 0; i < PALETTE_SIZE; i++) expect(seriesColorAt(i, 'light')).toBeTruthy();
  });

  it('returns null past the palette rather than reusing a slot', () => {
    // Reusing slot 8 would paint an ordinary 9th series in the alarm red, and
    // every series past the eighth identically. Null forces the caller to
    // decide.
    expect(seriesColorAt(PALETTE_SIZE, 'light')).toBeNull();
  });

  it.each([[-1], [1.5], [Number.NaN]])('rejects the invalid index %p', (i) => {
    expect(seriesColorAt(i, 'light')).toBeNull();
  });
});

describe('assignSeriesColors', () => {
  it('allocates a contiguous prefix of the fixed order', () => {
    // Prefix allocation is what makes the ADJACENT-pair gate the applicable
    // one. Hashing names would let any two of the eight land side by side,
    // which this palette fails (orange-green CVD 3.2).
    const r = assignSeriesColors(['a', 'b', 'c'], 'light');
    expect(r.slots).toEqual({ a: 0, b: 1, c: 2 });
    expect(r.colors.get('a')).toBe(PALETTE_LIGHT[0]);
    expect(r.colors.get('b')).toBe(PALETTE_LIGHT[1]);
  });

  it('keeps a series on its colour when another is filtered out', () => {
    // Colour follows the entity, not its rank: filtering must not repaint the
    // survivors.
    const first = assignSeriesColors(['a', 'b', 'c'], 'light');
    const after = assignSeriesColors(['a', 'c'], 'light', first.slots);
    expect(after.colors.get('a')).toBe(first.colors.get('a'));
    expect(after.colors.get('c')).toBe(first.colors.get('c'));
  });

  it('gives a new series the lowest free slot', () => {
    const first = assignSeriesColors(['a', 'b'], 'light');
    const after = assignSeriesColors(['a', 'b', 'c'], 'light', first.slots);
    expect(after.slots.c).toBe(2);
  });

  it('reports overflow past the palette instead of reusing colours', () => {
    const names = Array.from({ length: PALETTE_SIZE + 3 }, (_, i) => `s${i}`);
    const r = assignSeriesColors(names, 'light');
    expect(r.overflow).toHaveLength(3);
    expect(r.colors.size).toBe(PALETTE_SIZE);
    expect(new Set(r.colors.values()).size).toBe(PALETTE_SIZE);
  });

  it('ignores an out-of-range prior slot', () => {
    const r = assignSeriesColors(['a'], 'light', { a: 99 });
    expect(r.slots.a).toBe(0);
  });

  it('gives different colours to different series', () => {
    const r = assignSeriesColors(['a', 'b', 'c', 'd'], 'dark');
    expect(new Set(r.colors.values()).size).toBe(4);
  });
});

// ===========================================================================
// Token resolution
// ===========================================================================

describe('resolveColor', () => {
  // NAMED_COLORS is a union of two sets with different rules: Grafana's tokens,
  // which a browser cannot parse and which MUST be resolved, and the real CSS
  // keywords, which may legitimately pass through. Asserting isSafeColor over
  // the union would prove nothing either way — the token set is one of the
  // things isSafeColor accepts, so an identity resolveColor would satisfy it.
  const GRAFANA_ONLY = [
    'text',
    'panel-bg',
    ...['blue', 'green', 'red', 'orange', 'yellow', 'purple'].flatMap((h) => [
      `dark-${h}`,
      `semi-dark-${h}`,
      `light-${h}`,
      `super-light-${h}`,
    ]),
  ];
  const RENDERABLE = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|transparent$)/i;

  it('resolves every token a browser cannot parse', () => {
    // A `style:` directive drops an invalid value silently, leaving the element
    // to inherit. `green` and `red` are Grafana's defaults and happen to be real
    // keywords, so the common case appears to work while every imported variant
    // fails invisibly.
    expect(GRAFANA_ONLY).toHaveLength(26);
    for (const token of GRAFANA_ONLY) {
      for (const scheme of ['light', 'dark'] as const) {
        expect(resolveColor(token, scheme), `${token} in ${scheme}`).toMatch(RENDERABLE);
      }
    }
  });

  it('leaves no stored token unresolvable', () => {
    for (const token of NAMED_COLORS) {
      for (const scheme of ['light', 'dark'] as const) {
        const out = resolveColor(token, scheme);
        expect(out, `${token} in ${scheme}`).toBeTruthy();
        expect(RENDERABLE.test(out) || NAMED_COLORS.has(out), `${token} in ${scheme}`).toBe(true);
      }
    }
  });

  it.each([['dark-red'], ['semi-dark-orange'], ['super-light-blue'], ['light-green']])(
    'resolves the non-CSS token %s to hex',
    (token) => {
      expect(resolveColor(token, 'light')).toMatch(/^#[0-9a-f]{6}$/i);
    },
  );

  it('maps the theme-dependent tokens onto the theme', () => {
    expect(resolveColor('text', 'light')).not.toBe(resolveColor('text', 'dark'));
    expect(resolveColor('panel-bg', 'dark')).toBe(chartInk('dark').surface);
  });

  it('passes real colours through untouched', () => {
    expect(resolveColor('#ff0000', 'light')).toBe('#ff0000');
    expect(resolveColor('rgb(1, 2, 3)', 'light')).toBe('rgb(1, 2, 3)');
  });

  it('keeps transparent transparent', () => {
    expect(resolveColor('transparent', 'light')).toBe('transparent');
  });
});

// ===========================================================================
// Status
// ===========================================================================

describe('statusColor', () => {
  it('returns the icon and label alongside the fill', () => {
    // Returning a bare hex would let a contributor render a status fill with no
    // icon and no label — and on white, `warning` is 1.83:1, which fails WCAG
    // for text outright.
    const s = statusColor('warning');
    expect(s.fill).toBeTruthy();
    expect(s.icon).toBeTruthy();
    expect(s.label).toBeTruthy();
  });

  it('supplies a legal ink for text placed on the fill', () => {
    for (const role of ['good', 'warning', 'serious', 'critical'] as const) {
      const s = statusColor(role);
      expect(contrast(s.onFill, s.fill)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// ===========================================================================
// Thresholds
// ===========================================================================

describe('thresholdScale', () => {
  const ctx = { scheme: 'light' as const };

  it('activates a step at value >= its boundary', () => {
    const scale = thresholdScale(
      { mode: 'absolute', steps: [{ value: null, color: 'green' }, { value: 80, color: 'red' }] },
      ctx,
    );
    expect(thresholdColorAt(scale, 79)).toBe(resolveColor('green', 'light'));
    // Exactly on the boundary takes the higher step, matching Grafana.
    expect(thresholdColorAt(scale, 80)).toBe(resolveColor('red', 'light'));
  });

  it('converts percentage mode against the field range', () => {
    // 85 against [0,1000] is 8.5%, so an 80% threshold must NOT fire. Without
    // min/max in scope this silently returned red on every tile.
    const scale = thresholdScale(
      { mode: 'percentage', steps: [{ value: null, color: 'green' }, { value: 80, color: 'red' }] },
      { scheme: 'light', min: 0, max: 1000 },
    );
    expect(thresholdColorAt(scale, 85)).toBe(resolveColor('green', 'light'));
    expect(thresholdColorAt(scale, 850)).toBe(resolveColor('red', 'light'));
  });

  it('degrades to the base colour when percentage mode has no range', () => {
    // The validator deletes min and max when min > max, so this is reachable
    // from a valid saved dashboard.
    const scale = thresholdScale(
      { mode: 'percentage', steps: [{ value: null, color: 'green' }, { value: 80, color: 'red' }] },
      ctx,
    );
    expect(thresholdColorAt(scale, 9999)).toBe(resolveColor('green', 'light'));
  });

  it('sorts steps defensively', () => {
    const scale = thresholdScale(
      {
        mode: 'absolute',
        steps: [
          { value: 90, color: 'red' },
          { value: null, color: 'green' },
          { value: 50, color: 'orange' },
        ],
      },
      ctx,
    );
    expect(thresholdColorAt(scale, 10)).toBe(resolveColor('green', 'light'));
    expect(thresholdColorAt(scale, 60)).toBe(resolveColor('orange', 'light'));
    expect(thresholdColorAt(scale, 95)).toBe(resolveColor('red', 'light'));
  });

  it('handles a config with no steps', () => {
    const scale = thresholdScale({ mode: 'absolute', steps: [] }, ctx);
    expect(thresholdColorAt(scale, 5)).toBeTruthy();
  });

  it('handles a config with no base step', () => {
    // Nothing in the model requires a null step, so a value below the first
    // boundary must still get a colour — a neutral, not a categorical hue.
    const scale = thresholdScale({ mode: 'absolute', steps: [{ value: 10, color: 'red' }] }, ctx);
    expect(thresholdColorAt(scale, 5)).toBe(chartInk('light').textSecondary);
  });

  it.each([[null], [undefined], [Number.NaN]])(
    'gives %p the base colour deliberately, not by accident',
    (v) => {
      // `NaN >= x` is always false, so a naive scan lands on the base by
      // accident; this is explicit.
      const scale = thresholdScale(
        { mode: 'absolute', steps: [{ value: null, color: 'green' }, { value: 1, color: 'red' }] },
        ctx,
      );
      expect(thresholdColorAt(scale, v as number | null)).toBe(resolveColor('green', 'light'));
    },
  );

  it('never returns a bare Grafana token', () => {
    const scale = thresholdScale(
      { mode: 'absolute', steps: [{ value: null, color: 'semi-dark-orange' }] },
      ctx,
    );
    expect(thresholdColorAt(scale, 1)).toMatch(/^#|^rgb|^transparent$/);
  });
});

// ===========================================================================
// Field colour resolution
// ===========================================================================

describe('fieldColorFn', () => {
  const ctx = { scheme: 'light' as const };

  it('serves fixed mode', () => {
    const cfg: FieldConfig = { color: { mode: 'fixed', fixedColor: '#123456' } };
    expect(fieldColorFn(cfg, ctx)(1, 'a', 0)).toBe('#123456');
  });

  it('serves threshold mode', () => {
    const cfg: FieldConfig = {
      color: { mode: 'thresholds' },
      thresholds: { mode: 'absolute', steps: [{ value: null, color: 'green' }, { value: 5, color: 'red' }] },
    };
    const fn = fieldColorFn(cfg, ctx);
    expect(fn(1, 'a', 0)).toBe(resolveColor('green', 'light'));
    expect(fn(9, 'a', 0)).toBe(resolveColor('red', 'light'));
  });

  it('serves both palette modes from the assignment', () => {
    const cfg: FieldConfig = { color: { mode: 'palette-classic-by-name' } };
    const { slots } = assignSeriesColors(['b', 'a'], 'light');
    const fn = fieldColorFn(cfg, { ...ctx, slots });
    expect(fn(null, 'b', 0)).toBe(PALETTE_LIGHT[0]);
    expect(fn(null, 'a', 1)).toBe(PALETTE_LIGHT[1]);
  });

  it('falls back to index when a series has no assigned slot', () => {
    const cfg: FieldConfig = { color: { mode: 'palette-classic' } };
    expect(fieldColorFn(cfg, ctx)(null, 'unknown', 2)).toBe(PALETTE_LIGHT[2]);
  });

  it('serves continuous mode across the range', () => {
    const cfg: FieldConfig = { color: { mode: 'continuous' } };
    const fn = fieldColorFn(cfg, { ...ctx, min: 0, max: 100 });
    expect(fn(0, 'a', 0)).not.toBe(fn(100, 'a', 0));
  });

  it('defaults to a palette mode when no colour is configured', () => {
    expect(fieldColorFn({}, { ...ctx, slots: { a: 0 } })(null, 'a', 0)).toBe(PALETTE_LIGHT[0]);
  });
});

// ===========================================================================
// Ramps
// ===========================================================================

describe('ramps', () => {
  it('returns an array, not a per-value function', () => {
    // A per-cell colour call measured 18.66ms for a 500x50 heatmap against a
    // 16ms budget for the entire redraw; indexing a 256-entry array measured
    // 0.13ms.
    const ramp = sequentialRamp('light');
    expect(ramp).toHaveLength(256);
    expect(ramp[0]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('is monotonic in lightness', () => {
    const ramp = sequentialRamp('light');
    const first = luminance(ramp[0]);
    const last = luminance(ramp[ramp.length - 1]);
    expect(first).toBeGreaterThan(last);
  });

  it('keeps chroma through the midpoint', () => {
    // sRGB interpolation loses about half the chroma at the middle of a ramp,
    // which is exactly where a latency distribution's mass sits.
    const mid = sequentialRamp('light')[128];
    const n = parseInt(mid.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(60);
  });

  it('puts a neutral at the diverging midpoint', () => {
    const ramp = divergingRamp('light');
    const mid = ramp[Math.floor(ramp.length / 2)];
    const n = parseInt(mid.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    // A hue at the midpoint would assert a polarity that is not in the data.
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(30);
  });

  it('gives the diverging arms opposite hues', () => {
    const ramp = divergingRamp('light');
    expect(ramp[0]).not.toBe(ramp[ramp.length - 1]);
  });
});

// ===========================================================================
// Chrome
// ===========================================================================

describe('chartInk', () => {
  it('differs per theme', () => {
    expect(chartInk('light').surface).not.toBe(chartInk('dark').surface);
  });

  it('keeps primary text legible on the surface', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const ink = chartInk(scheme);
      expect(contrast(ink.textPrimary, ink.surface)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('withAlpha', () => {
  it('handles six-digit hex', () => {
    expect(withAlpha('#A855F7', 0.2)).toBe('rgba(168, 85, 247, 0.2)');
  });

  it('handles three-digit hex, which string concatenation breaks', () => {
    // `${color}20` produces "#fff20", which is not a colour.
    expect(withAlpha('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
  });

  it('handles an rgb() input', () => {
    expect(withAlpha('rgb(1, 2, 3)', 0.5)).toBe('rgba(1, 2, 3, 0.5)');
  });

  it('clamps alpha', () => {
    expect(withAlpha('#000000', 5)).toContain('1)');
    expect(withAlpha('#000000', -1)).toContain('0)');
  });
});
