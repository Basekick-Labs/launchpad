import { describe, it, expect } from 'vitest';
import {
  GRID_COLS,
  MIN_PANEL,
  applyItems,
  cellWidth,
  clampForDrag,
  clampForLoad,
  compact,
  findSlot,
  moveItem,
  overlaps,
  pointerToDelta,
  projectSingleColumn,
  removeItem,
  resizeItem,
  toItems,
  totalHeight,
  type GridItem,
} from './gridEngine';
import { LIMITS, createPanel, type Panel } from './model';

const it_ = (id: string, x: number, y: number, w: number, h: number): GridItem => ({ id, x, y, w, h });
const sig = (items: readonly GridItem[]) =>
  [...items]
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
    .map((i) => `${i.id}@${i.x},${i.y},${i.w}x${i.h}`)
    .join(' ');
const anyOverlap = (items: readonly GridItem[]) =>
  items.some((a) => items.some((b) => overlaps(a, b)));
const ok = (r: ReturnType<typeof moveItem>) => {
  expect(r.ok).toBe(true);
  return r.items;
};

// ===========================================================================
// Compaction
// ===========================================================================

describe('compact', () => {
  it('floats up from where a panel is, never through a panel', () => {
    // The issue's `firstFreeRow` sketch means "smallest free y", which moves Z
    // from y=4 to y=0 straight THROUGH the full-width Y. Gravity has to stop at
    // the first obstruction.
    const layout = [it_('X', 0, 0, 4, 2), it_('Y', 0, 2, 24, 2), it_('Z', 4, 4, 4, 2)];
    expect(sig(compact(layout))).toBe(sig(layout));
  });

  it('leaves a legal stored layout byte-identical', () => {
    // If this fails, opening a dashboard and saving it rewrites the layout, the
    // no-op-save check stops short-circuiting, and every save burns a version.
    const layout = [it_('A', 0, 0, 12, 4), it_('B', 12, 0, 12, 4), it_('C', 0, 4, 24, 6)];
    expect(compact(layout)).toEqual(layout);
  });

  it('pulls panels up into a gap above them', () => {
    const out = compact([it_('A', 0, 0, 12, 2), it_('B', 0, 9, 12, 2)]);
    expect(out.find((i) => i.id === 'B')!.y).toBe(2);
  });

  it('is idempotent', () => {
    const layout = [
      it_('A', 0, 3, 8, 2),
      it_('B', 8, 1, 8, 4),
      it_('C', 16, 7, 8, 2),
      it_('D', 0, 9, 24, 3),
    ];
    const once = compact(layout);
    expect(compact(once)).toEqual(once);
  });

  it('is idempotent across many random layouts, including overlapping input', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    for (let t = 0; t < 500; t++) {
      const items: GridItem[] = [];
      for (let i = 0; i < 1 + rnd(7); i++) {
        const w = 1 + rnd(GRID_COLS);
        items.push(it_(`p${i}`, rnd(GRID_COLS - w + 1), rnd(16), w, 1 + rnd(6)));
      }
      const once = compact(items);
      expect(compact(once), `trial ${t}`).toEqual(once);
      expect(anyOverlap(once), `trial ${t}`).toBe(false);
    }
  });

  it('does not depend on input array order', () => {
    // Array order is part of the serialized bytes, so an order-dependent layout
    // makes the same edit produce different saves.
    const a = [it_('A', 0, 0, 12, 2), it_('B', 12, 0, 12, 2), it_('C', 0, 2, 24, 2)];
    expect(sig(compact(a))).toBe(sig(compact([...a].reverse())));
  });

  it('never mutates its input', () => {
    const items = [it_('A', 0, 5, 12, 2), it_('B', 0, 9, 12, 2)];
    const before = structuredClone(items);
    compact(items);
    expect(items).toEqual(before);
  });
});

// ===========================================================================
// Moving — the directional half
// ===========================================================================

describe('moveItem', () => {
  const column = () => [it_('A', 0, 0, 12, 2), it_('B', 0, 2, 12, 2), it_('C', 12, 0, 12, 4)];

  it.each([2, 3])('swaps with the panel below when dropped on it (y=%i)', (dropY) => {
    // Push-every-collider-down then compact makes this a NO-OP: the dragged
    // panel sorts first, floats back to 0, and the pushed panel falls under it.
    // Drops at y=1, 2 and 3 all returned A to y=0 — the user had to overshoot a
    // full panel height, and only downwards.
    const out = ok(moveItem(column(), 'A', { x: 0, y: dropY }, 0));
    expect(out.find((i) => i.id === 'A')!.y).toBe(2);
    expect(out.find((i) => i.id === 'B')!.y).toBe(0);
    expect(anyOverlap(out)).toBe(false);
  });

  it('leaves the result a fixed point of plain compaction', () => {
    // Otherwise the swap survives until the next reload and then snaps back.
    const out = ok(moveItem(column(), 'A', { x: 0, y: 2 }, 0));
    expect(compact(out)).toEqual(out);
  });

  it('does not swap on a shallow overlap', () => {
    // Dropping one row down is not a request to reorder.
    const out = ok(moveItem(column(), 'A', { x: 0, y: 1 }, 0));
    expect(out.find((i) => i.id === 'A')!.y).toBe(0);
  });

  it('pushes the occupant down when dragging upward onto it', () => {
    const out = ok(moveItem(column(), 'B', { x: 0, y: 0 }, 2));
    expect(out.find((i) => i.id === 'B')!.y).toBe(0);
    expect(out.find((i) => i.id === 'A')!.y).toBe(2);
    expect(anyOverlap(out)).toBe(false);
  });

  it('pushes transitively through a stack', () => {
    const stack = [
      it_('A', 0, 0, 24, 2),
      it_('B', 0, 2, 24, 2),
      it_('C', 0, 4, 24, 2),
      it_('D', 0, 6, 24, 2),
    ];
    const out = ok(moveItem(stack, 'D', { x: 0, y: 0 }, 6));
    expect(sig(out)).toBe('D@0,0,24x2 A@0,2,24x2 B@0,4,24x2 C@0,6,24x2');
  });

  it('never overlaps, across many random moves', () => {
    let seed = 99;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    for (let t = 0; t < 500; t++) {
      const items: GridItem[] = [];
      for (let i = 0; i < 2 + rnd(6); i++) {
        const w = 1 + rnd(GRID_COLS);
        items.push(it_(`p${i}`, rnd(GRID_COLS - w + 1), i * 3, w, 1 + rnd(4)));
      }
      const t0 = items[rnd(items.length)];
      const r = moveItem(compact(items), t0.id, { x: rnd(GRID_COLS), y: rnd(20) }, t0.y);
      expect(anyOverlap(r.items), `trial ${t}`).toBe(false);
    }
  });

  it('clamps x so a panel cannot hang off the right edge', () => {
    // Drag policy clamps x and keeps w — clamping w would shrink the panel as
    // the user dragged it rightward.
    const out = ok(moveItem([it_('A', 0, 0, 8, 2)], 'A', { x: 20, y: 0 }, 0));
    expect(out[0]).toMatchObject({ x: GRID_COLS - 8, w: 8 });
  });

  it('refuses a move that would make the layout unsaveable', () => {
    // maxGridY is a hard schema bound, so a layout past it 400s on save with an
    // error the user cannot act on. Refusing the move is the lesser evil.
    //
    // The scenario has to be one gravity cannot absorb: a full left column plus
    // one panel on the right, dragged into that column so it must stack past the
    // limit. A shallower case just compacts away and legitimately succeeds.
    const H = LIMITS.maxPanelHeight;
    const tall: GridItem[] = [];
    for (let i = 0; i <= LIMITS.maxGridY / H; i++) tall.push(it_(`L${i}`, 0, i * H, 12, H));
    tall.push(it_('R', 12, 0, 12, H));

    const r = moveItem(tall, 'R', { x: 0, y: (LIMITS.maxGridY / H + 1) * H }, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_room');
    // And the layout comes back untouched.
    expect(sig(r.items)).toBe(sig(tall));
  });

  it('is a no-op for an unknown id', () => {
    const items = [it_('A', 0, 0, 12, 2)];
    expect(ok(moveItem(items, 'nope', { x: 5, y: 5 }, 0))).toEqual(items);
  });

  it('leaves an empty column after a horizontal swap, and that is the model', () => {
    // Gravity is vertical only, so dragging A onto B stacks them and column 0
    // stays empty. react-grid-layout behaves the same way. Asserted so nobody
    // "fixes" it into horizontal gravity, which would move panels the user never
    // touched.
    const side = [it_('A', 0, 0, 12, 8), it_('B', 12, 0, 12, 8)];
    const out = ok(moveItem(side, 'A', { x: 12, y: 0 }, 0));
    expect(out.every((i) => i.x === 12)).toBe(true);
    expect(totalHeight(out)).toBe(16);
  });
});

// ===========================================================================
// Resizing
// ===========================================================================

describe('resizeItem', () => {
  it('pushes the panel below out of the way', () => {
    const out = ok(resizeItem([it_('A', 0, 0, 12, 3), it_('B', 0, 3, 12, 3)], 'A', { w: 12, h: 6 }));
    expect(out.find((i) => i.id === 'A')!.h).toBe(6);
    expect(out.find((i) => i.id === 'B')!.y).toBe(6);
  });

  it('enforces a minimum size', () => {
    // w:1,h:1 is ~42x30px — narrower than a chart's axis labels.
    const out = ok(resizeItem([it_('A', 0, 0, 12, 6)], 'A', { w: 1, h: 1 }));
    expect(out[0]).toMatchObject({ w: MIN_PANEL.w, h: MIN_PANEL.h });
  });

  it('clamps width to the space right of x rather than overflowing', () => {
    const out = ok(resizeItem([it_('A', 20, 0, 4, 4)], 'A', { w: 12, h: 4 }));
    expect(out[0].x + out[0].w).toBe(GRID_COLS);
  });

  it('clamps height to maxPanelHeight', () => {
    const out = ok(resizeItem([it_('A', 0, 0, 12, 4)], 'A', { w: 12, h: 9999 }));
    expect(out[0].h).toBe(LIMITS.maxPanelHeight);
  });

  it('pulls a panel up when a resize frees space', () => {
    const out = ok(resizeItem([it_('A', 0, 0, 12, 8), it_('B', 0, 8, 12, 2)], 'A', { w: 12, h: 3 }));
    expect(out.find((i) => i.id === 'B')!.y).toBe(3);
  });

  it('never mutates its input', () => {
    const items = [it_('A', 0, 0, 12, 3), it_('B', 0, 3, 12, 3)];
    const before = structuredClone(items);
    resizeItem(items, 'A', { w: 12, h: 6 });
    expect(items).toEqual(before);
  });
});

// ===========================================================================
// Removal
// ===========================================================================

describe('removeItem', () => {
  it('lets blocked panels stay blocked and leaves the hole', () => {
    // Vertical gravity only: C rises because nothing is above it, D does not
    // because A blocks it, and the hole beside A remains. This is the correct
    // expectation — asserting it stops someone rewriting compaction into the
    // teleporting semantics.
    const layout = [
      it_('A', 0, 0, 12, 4),
      it_('B', 12, 0, 12, 2),
      it_('C', 12, 2, 12, 2),
      it_('D', 0, 4, 24, 2),
    ];
    const out = removeItem(layout, 'B');
    expect(out.find((i) => i.id === 'C')!.y).toBe(0);
    expect(out.find((i) => i.id === 'D')!.y).toBe(4);
  });

  it('drops the item', () => {
    expect(removeItem([it_('A', 0, 0, 12, 2), it_('B', 0, 2, 12, 2)], 'A')).toHaveLength(1);
  });
});

// ===========================================================================
// Adding
// ===========================================================================

describe('findSlot', () => {
  it('places the first panel at the origin', () => {
    expect(findSlot([], 12, 8)).toEqual({ x: 0, y: 0, w: 12, h: 8 });
  });

  it('fills a hole that exactly fits', () => {
    expect(findSlot([it_('A', 0, 0, 12, 8)], 12, 8)).toEqual({ x: 12, y: 0, w: 12, h: 8 });
  });

  it('skips a hole one column too narrow', () => {
    const out = findSlot([it_('A', 0, 0, 13, 8)], 12, 8);
    expect(out!.y).toBe(8);
  });

  it('appends below when no row has room', () => {
    expect(findSlot([it_('A', 0, 0, 24, 4)], 24, 4)).toEqual({ x: 0, y: 4, w: 24, h: 4 });
  });

  it('enforces the minimum size', () => {
    expect(findSlot([], 1, 1)).toMatchObject({ w: MIN_PANEL.w, h: MIN_PANEL.h });
  });

  it('returns null rather than a position that cannot be saved', () => {
    const H = LIMITS.maxPanelHeight;
    // Room under a single tall panel: fine, nowhere near the limit.
    expect(findSlot([it_('A', 0, 0, 24, H)], 24, 8)).not.toBeNull();

    // Grid packed full width past maxGridY: the only free row is unsaveable.
    const packed: GridItem[] = [];
    for (let i = 0; i <= LIMITS.maxGridY / H; i++) packed.push(it_(`p${i}`, 0, i * H, 24, H));
    expect(findSlot(packed, 24, 8)).toBeNull();
  });
});

// ===========================================================================
// Responsive
// ===========================================================================

describe('projectSingleColumn', () => {
  it('stacks in reading order at full width', () => {
    const out = projectSingleColumn([
      it_('B', 12, 0, 12, 4),
      it_('A', 0, 0, 12, 2),
      it_('C', 0, 4, 24, 3),
    ]);
    expect(out.map((i) => i.id)).toEqual(['A', 'B', 'C']);
    expect(out.every((i) => i.x === 0 && i.w === GRID_COLS)).toBe(true);
    expect(out.map((i) => i.y)).toEqual([0, 2, 6]);
  });

  it('preserves each panel height', () => {
    const src = [it_('A', 0, 0, 6, 5)];
    expect(projectSingleColumn(src)[0].h).toBe(5);
  });

  it('never mutates its input', () => {
    const items = [it_('A', 12, 3, 6, 5)];
    const before = structuredClone(items);
    projectSingleColumn(items);
    expect(items).toEqual(before);
  });
});

// ===========================================================================
// Clamping
// ===========================================================================

describe('clampForLoad', () => {
  it('narrows w and keeps x, matching what validation already does', () => {
    // The server's normalizePanel clamps w = max(1, 24 - x). If this shifted x
    // instead, client and server would disagree after every save and the
    // dashboard would never come clean.
    expect(clampForLoad(it_('A', 20, 0, 10, 4))).toMatchObject({ x: 20, w: 4 });
  });

  it.each([
    [it_('A', -5, -5, 12, 4), { x: 0, y: 0 }],
    [it_('A', 0, 0, 0, 0), { w: 1, h: 1 }],
    [it_('A', 99, 0, 12, 4), { x: GRID_COLS - 1 }],
    [it_('A', 0, 0, 12, 9999), { h: LIMITS.maxPanelHeight }],
  ])('clamps %o', (input, expected) => {
    expect(clampForLoad(input)).toMatchObject(expected);
  });

  it.each([[Number.NaN], [Infinity]])('survives %p', (bad) => {
    const out = clampForLoad(it_('A', bad, bad, bad, bad));
    expect(Number.isFinite(out.x) && Number.isFinite(out.w)).toBe(true);
  });
});

describe('clampForDrag', () => {
  it('clamps x and keeps w, so the panel does not shrink mid-drag', () => {
    expect(clampForDrag(it_('A', 99, 0, 8, 4))).toMatchObject({ x: GRID_COLS - 8, w: 8 });
  });
});

// ===========================================================================
// Pixel math
// ===========================================================================

describe('cellWidth', () => {
  it('accounts for the gaps between columns', () => {
    // containerWidth / cols is the tempting wrong answer: it gives 50 where the
    // truth is 42.33, and a 500px drag then resolves 2 columns short.
    expect(cellWidth({ containerWidth: 1200, cols: 24, gap: 8 })).toBeCloseTo(42.333, 2);
    expect(cellWidth({ containerWidth: 1200, cols: 24, gap: 0 })).toBe(50);
  });

  it('does not go negative on a container narrower than its gaps', () => {
    expect(cellWidth({ containerWidth: 10, cols: 24, gap: 8 })).toBe(0);
  });
});

describe('pointerToDelta', () => {
  const geom = { containerWidth: 1200, cols: 24, rowHeight: 30, gap: 8 };

  it('converts a drag to whole cells', () => {
    // 500px / (42.33 + 8) ≈ 9.93 -> 10
    expect(pointerToDelta(500, 0, geom).dx).toBe(10);
    expect(pointerToDelta(0, 76, geom).dy).toBe(2);
  });

  it('is symmetric for negative drags', () => {
    // Math.round(-0.5) is -0, so rounding magnitude separately would make
    // leftward drags stickier than rightward ones.
    const right = pointerToDelta(200, 100, geom);
    const left = pointerToDelta(-200, -100, geom);
    expect(left.dx).toBe(-right.dx);
    expect(left.dy).toBe(-right.dy);
  });

  it('moves at the halfway point, not a whole cell', () => {
    const cw = cellWidth(geom) + geom.gap;
    expect(pointerToDelta(cw * 0.49, 0, geom).dx).toBe(0);
    expect(pointerToDelta(cw * 0.51, 0, geom).dx).toBe(1);
  });

  it('survives a zero-width container', () => {
    expect(pointerToDelta(100, 100, { ...geom, containerWidth: 0, gap: 0, rowHeight: 0 })).toEqual({
      dx: 0,
      dy: 0,
    });
  });
});

// ===========================================================================
// Panel adapter
// ===========================================================================

describe('toItems / applyItems', () => {
  const mk = (id: string, gridPos: { x: number; y: number; w: number; h: number }): Panel => ({
    ...createPanel({ type: 'timeseries', gridPos, id }),
  });

  it('preserves the panel array order, which is part of the saved bytes', () => {
    // sortKeys orders object keys but leaves arrays alone, so returning the
    // engine's (y,x,id)-sorted array would make the first drag produce a large
    // spurious diff and defeat the no-op-save check.
    const panels = [
      mk('z', { x: 0, y: 4, w: 24, h: 2 }),
      mk('a', { x: 0, y: 0, w: 12, h: 2 }),
      mk('m', { x: 12, y: 0, w: 12, h: 2 }),
    ];
    const moved = compact(toItems(panels));
    const out = applyItems(panels, moved);
    expect(out.map((p) => p.id)).toEqual(['z', 'a', 'm']);
  });

  it('returns the SAME panel object when its position did not change', () => {
    // Identity matters for the keyed {#each}: a new object per panel per frame
    // would let Svelte tear down a chart mid-drag.
    const panels = [mk('a', { x: 0, y: 0, w: 12, h: 2 })];
    const out = applyItems(panels, toItems(panels));
    expect(out[0]).toBe(panels[0]);
  });

  it('writes a changed position through', () => {
    const panels = [mk('a', { x: 0, y: 5, w: 12, h: 2 })];
    const out = applyItems(panels, compact(toItems(panels)));
    expect(out[0].gridPos.y).toBe(0);
    expect(out[0]).not.toBe(panels[0]);
  });

  it('ignores items with no matching panel', () => {
    const panels = [mk('a', { x: 0, y: 0, w: 12, h: 2 })];
    expect(applyItems(panels, [it_('ghost', 0, 9, 4, 4)])).toEqual(panels);
  });
});

describe('totalHeight', () => {
  it('is one past the lowest bottom edge', () => {
    expect(totalHeight([it_('A', 0, 0, 12, 4), it_('B', 12, 2, 12, 5)])).toBe(7);
  });

  it('is zero for an empty grid', () => {
    expect(totalHeight([])).toBe(0);
  });
});
