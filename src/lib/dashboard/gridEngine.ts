/**
 * The dashboard grid layout algorithm: 24 columns, vertical gravity, push-down
 * collision resolution.
 *
 * Hand-rolled rather than `gridstack.js` (which owns and mutates DOM nodes,
 * fighting Svelte's keyed `{#each}`) or `svelte-grid` (Svelte-3-era,
 * unmaintained). Everything that can be wrong in an interesting way lives here,
 * where it can be tested; the component is pointer bookkeeping and CSS.
 *
 * Pure and immutable: every function returns new objects and never mutates its
 * input. That is not style — the loaded `Dashboard` is compared against
 * `serializeForSave` to decide whether a save is a no-op, so mutating it in
 * place would make every dashboard permanently dirty.
 *
 * ## "Compact" means float UP from where you are, not "fall to the first free row"
 *
 * The distinction looks academic and is not. Take a legal, collision-free stored
 * layout:
 *
 *     X (4 wide) at y=0     Y (24 wide) at y=2     Z (4 wide) at y=4
 *
 * "Smallest free y" moves Z to y=0 — straight THROUGH the full-width Y — and,
 * worse, the stored layout is then not a fixed point, so simply opening and
 * saving a dashboard rewrites its layout. Floating up until blocked leaves it
 * alone. Verified both ways.
 *
 * ## Gravity NEVER runs on load
 *
 * Only an explicit edit (move, resize, add, remove) may change positions. If
 * load-time normalisation could move a panel, opening a dashboard would mark it
 * dirty, the no-op-save check in `$lib/server/dashboards` would stop
 * short-circuiting, and every save would burn a version of history with no user
 * edit. This codebase has already been bitten by exactly that shape — see the
 * note on the threshold comparator in `validate.ts`.
 *
 * ## Downward drags need directional resolution
 *
 * Pushing every collider down and then compacting makes a downward drag a
 * NO-OP: the dragged panel is sorted first, floats back to where it started, and
 * the pushed panel falls back under it. Measured on a two-panel column, drops at
 * y=1, y=2 and y=3 all returned the panel to y=0 — the user has to drag a full
 * panel height PAST the target before anything happens, and only downwards.
 *
 * So when the drag is downward, a collider is first offered the space ABOVE the
 * dragged panel. That produces the swap the user asked for, and the result is a
 * fixed point of plain compaction.
 */

import { GRID_COLUMNS, LIMITS, type GridPos, type Panel } from './model';

export const GRID_COLS = GRID_COLUMNS;

/**
 * Smaller than this and a panel cannot show a chart — at 24 columns, `w: 1` is
 * about 42px, narrower than an axis label. Grafana uses the same floor.
 */
export const MIN_PANEL = { w: 2, h: 3 } as const;

export interface GridItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LayoutResult =
  | { ok: true; items: GridItem[] }
  /** The edit would push the layout past `maxGridY`, where it stops being saveable. */
  | { ok: false; reason: 'no_room'; items: GridItem[] };

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function overlaps(a: GridItem, b: GridItem): boolean {
  return (
    a.id !== b.id &&
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

/**
 * Total order for placement.
 *
 * The `id` tiebreak is what removes the dependence on input array order — and
 * that matters because array order is part of the serialized bytes, so an
 * order-dependent layout would make the same edit produce different saves.
 *
 * Plain string comparison, never `localeCompare`: that is locale-dependent, and
 * saved output must not vary by the user's browser locale.
 */
function byPosition(a: GridItem, b: GridItem): number {
  return a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** One past the bottom edge of the lowest panel. */
export function totalHeight(items: readonly GridItem[]): number {
  let max = 0;
  for (const i of items) max = Math.max(max, i.y + i.h);
  return max;
}

/**
 * Matches `GridPosSchema` exactly: it bounds `y <= maxGridY` and
 * `h <= maxPanelHeight` INDEPENDENTLY, with no constraint on `y + h`. Being
 * stricter here would refuse edits the server would have accepted; being looser
 * would produce a layout that 400s on save with an error the user cannot act on.
 */
function fitsGrid(items: readonly GridItem[]): boolean {
  return items.every((i) => i.y <= LIMITS.maxGridY && i.h <= LIMITS.maxPanelHeight);
}

// ---------------------------------------------------------------------------
// Clamping — two policies, because two callers need different things
// ---------------------------------------------------------------------------

/**
 * For a layout arriving from storage or an import.
 *
 * Narrows `w` and keeps `x`, which is EXACTLY what `normalizePanel` in
 * `validate.ts` does when it clamps an overflowing panel. The two must agree: if
 * this shifted `x` instead, the client and the server would disagree after every
 * save and the dashboard would never come clean.
 *
 * Note this is belt-and-braces — every write path validates, and validation
 * already clamps — so in practice it is a no-op on stored data. It exists for
 * layouts that reach the component without passing validation.
 */
export function clampForLoad(item: GridItem): GridItem {
  const x = clamp(Math.trunc(item.x), 0, GRID_COLS - 1);
  const w = clamp(Math.trunc(item.w), 1, GRID_COLS - x);
  const h = clamp(Math.trunc(item.h), 1, LIMITS.maxPanelHeight);
  const y = clamp(Math.trunc(item.y), 0, LIMITS.maxGridY);
  return { ...item, x, y, w, h };
}

/**
 * For a live drag.
 *
 * Clamps `x` and keeps `w`. Clamping `w` here — the load policy — would make a
 * panel silently shrink as the user dragged it toward the right edge.
 */
export function clampForDrag(item: GridItem): GridItem {
  return {
    ...item,
    x: clamp(Math.trunc(item.x), 0, GRID_COLS - item.w),
    y: Math.max(0, Math.trunc(item.y)),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * Where this item comes to rest among the ones already placed.
 *
 * Two steps, and both are needed. Floating up alone leaves an item that ALREADY
 * overlaps exactly where it was — it cannot rise, so the overlap survives
 * compaction, which shows up as two panels drawn on top of each other. So first
 * sink out of any collision, then apply gravity.
 *
 * This is still not "smallest free y": the rise stops at the first obstruction
 * rather than passing through it, which is what keeps a legal stored layout a
 * fixed point.
 */
function settle(item: GridItem, placed: readonly GridItem[]): number {
  let y = Math.max(0, item.y);

  // Sink until nothing is in the way. Jump past the blocker rather than
  // scanning row by row, so a tall dashboard costs a few hops.
  for (;;) {
    const hit = placed.find((p) => overlaps({ ...item, y }, p));
    if (!hit) break;
    y = hit.y + hit.h;
  }

  // Then rise until something blocks.
  while (y > 0 && !placed.some((p) => overlaps({ ...item, y: y - 1 }, p))) y--;
  return y;
}

/**
 * Applies gravity. Never moves anything DOWN and never moves anything sideways,
 * so a collision-free layout with no slack is returned unchanged — which is what
 * makes it idempotent and makes stored layouts survive a round trip.
 */
export function compact(items: readonly GridItem[]): GridItem[] {
  const placed: GridItem[] = [];
  for (const item of [...items].sort(byPosition)) {
    placed.push({ ...item, y: settle(item, placed) });
  }
  // Re-sorted by the SETTLED positions, not the input ones. Without this the
  // array comes back in the input's order, so compacting twice yields identical
  // positions in a different array order — and "idempotent" stops being a
  // property you can assert structurally. Callers get positions back onto the
  // original panel array through `applyItems`, so this order is internal.
  return placed.sort(byPosition);
}

// ---------------------------------------------------------------------------
// Collision resolution
// ---------------------------------------------------------------------------

/**
 * Seats everything that collides with `movedId`, transitively.
 *
 * Termination is a property of the algorithm, not a guard: a push sets
 * `collider.y = source.y + source.h`, and a collision implies
 * `collider.y < source.y + source.h`, so every push STRICTLY INCREASES the
 * pushed item's `y`. Each `y` is monotone and bounded by the grid, so the
 * worklist drains — measured at exactly `n` pops for an `n`-panel stack.
 *
 * The counter is therefore an assertion, not a cap. A cap would return a
 * silently wrong layout that a later compaction "repairs" into something
 * plausible and incorrect, which is the worst available failure.
 */
function resolveCollisions(
  items: readonly GridItem[],
  movedId: string,
  direction: 'up' | 'down' | 'none',
): GridItem[] {
  const out = items.map((i) => ({ ...i }));
  const byId = new Map(out.map((i) => [i.id, i]));
  const work: string[] = [movedId];
  const budget = out.length * out.length + 16;
  let pops = 0;

  while (work.length > 0) {
    if (++pops > budget) {
      // Unreachable given the monotonicity argument above. Loud, because a
      // silent wrong layout is worse than a crash in dev.
      throw new Error(`grid: collision resolution exceeded ${budget} steps`);
    }
    const cur = byId.get(work.shift()!);
    if (!cur) continue;

    for (const other of out) {
      if (other.id === cur.id || !overlaps(cur, other)) continue;

      // Dragging DOWN onto a neighbour: offer it the space above first, so the
      // two swap instead of the drag being a no-op.
      if (direction === 'down' && cur.id === movedId) {
        const above = cur.y - other.h;
        if (above >= 0) {
          const probe = { ...other, y: above };
          const blocked = out.some(
            (q) => q.id !== other.id && q.id !== cur.id && overlaps(probe, q),
          );
          if (!blocked) {
            other.y = above;
            work.push(other.id);
            continue;
          }
        }
      }

      other.y = cur.y + cur.h;
      work.push(other.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/**
 * Moves an item to `(x, y)`, resolving collisions and applying gravity.
 *
 * `fromY` is required, not optional: the direction of the drag decides whether a
 * collider is seated above or below, and without it every downward drag is a
 * no-op.
 */
export function moveItem(
  items: readonly GridItem[],
  id: string,
  to: { x: number; y: number },
  fromY: number,
): LayoutResult {
  const target = items.find((i) => i.id === id);
  if (!target) return { ok: true, items: items.map((i) => ({ ...i })) };

  const moved = items.map((i) =>
    i.id === id ? clampForDrag({ ...i, x: to.x, y: to.y }) : { ...i },
  );
  const y = moved.find((i) => i.id === id)!.y;
  const direction = y > fromY ? 'down' : y < fromY ? 'up' : 'none';

  const next = compact(resolveCollisions(moved, id, direction));
  if (!fitsGrid(next)) {
    return { ok: false, reason: 'no_room', items: items.map((i) => ({ ...i })) };
  }
  return { ok: true, items: next };
}

/** Resizes an item, clamped to the usable range, then resolves and compacts. */
export function resizeItem(
  items: readonly GridItem[],
  id: string,
  size: { w: number; h: number },
): LayoutResult {
  const target = items.find((i) => i.id === id);
  if (!target) return { ok: true, items: items.map((i) => ({ ...i })) };

  const w = clamp(Math.trunc(size.w), MIN_PANEL.w, GRID_COLS - target.x);
  const h = clamp(Math.trunc(size.h), MIN_PANEL.h, LIMITS.maxPanelHeight);

  const resized = items.map((i) => (i.id === id ? { ...i, w, h } : { ...i }));
  // A resize grows downward and rightward, so colliders are pushed down; there
  // is no "swap" reading of a resize.
  const next = compact(resolveCollisions(resized, id, 'none'));
  if (!fitsGrid(next)) {
    return { ok: false, reason: 'no_room', items: items.map((i) => ({ ...i })) };
  }
  return { ok: true, items: next };
}

/**
 * Removes an item and lets the rest fall.
 *
 * Note gravity is vertical only, so a panel beside the hole does NOT slide
 * across into it, and a panel blocked by an unrelated neighbour stays put. That
 * is correct for this layout model, and asserting it keeps someone from
 * "fixing" compaction into the teleporting semantics.
 */
export function removeItem(items: readonly GridItem[], id: string): GridItem[] {
  return compact(items.filter((i) => i.id !== id));
}

/**
 * The first position a `w x h` panel fits, scanning rows then columns; otherwise
 * appended below everything. Returns null when even that would leave the grid
 * unsaveable.
 */
export function findSlot(
  items: readonly GridItem[],
  w: number,
  h: number,
): GridPos | null {
  const width = clamp(Math.trunc(w), MIN_PANEL.w, GRID_COLS);
  const height = clamp(Math.trunc(h), MIN_PANEL.h, LIMITS.maxPanelHeight);
  const bottom = totalHeight(items);

  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + width <= GRID_COLS; x++) {
      const probe = { id: ' probe', x, y, w: width, h: height };
      if (!items.some((i) => overlaps(probe, i))) {
        if (y > LIMITS.maxGridY) return null;
        return { x, y, w: width, h: height };
      }
    }
  }
  if (bottom > LIMITS.maxGridY) return null;
  return { x: 0, y: bottom, w: width, h: height };
}

// ---------------------------------------------------------------------------
// Responsive projection
// ---------------------------------------------------------------------------

/**
 * One column, in reading order. A RENDER-TIME PROJECTION that must never be
 * written back to the model: a user who opens a dashboard on a phone and saves
 * anything would otherwise destroy the desktop layout. Hence the name.
 */
export function projectSingleColumn(items: readonly GridItem[]): GridItem[] {
  let y = 0;
  return [...items].sort(byPosition).map((item) => {
    const placed = { ...item, x: 0, y, w: GRID_COLS };
    y += item.h;
    return placed;
  });
}

// ---------------------------------------------------------------------------
// Pixels — pure, and where the off-by-ones live
// ---------------------------------------------------------------------------

export interface GridGeometry {
  containerWidth: number;
  cols: number;
  rowHeight: number;
  gap: number;
}

/**
 * The width of one column.
 *
 * `containerWidth / cols` is the tempting wrong answer: with 24 columns, an 8px
 * gap and a 1200px container it gives 50px where the truth is 42.33px, so a
 * 500px drag resolves to 10 columns instead of 12 — off by two at the right
 * edge, which is exactly what makes a grid feel broken.
 */
export function cellWidth(geom: Pick<GridGeometry, 'containerWidth' | 'cols' | 'gap'>): number {
  const { containerWidth, cols, gap } = geom;
  if (cols <= 0) return 0;
  return Math.max(0, (containerWidth - gap * (cols - 1)) / cols);
}

/**
 * A pixel delta as a cell delta.
 *
 * `Math.round` on purpose, so the panel follows the pointer once it is past the
 * halfway point of a cell — and applied to the signed value, because
 * `Math.round(-0.5)` is `-0`, not `-1`, so rounding magnitude separately would
 * make leftward drags feel stickier than rightward ones.
 */
export function pointerToDelta(
  dxPx: number,
  dyPx: number,
  geom: GridGeometry,
): { dx: number; dy: number } {
  const cw = cellWidth(geom) + geom.gap;
  const rh = geom.rowHeight + geom.gap;
  return {
    dx: cw > 0 ? Math.round(dxPx / cw) : 0,
    dy: rh > 0 ? Math.round(dyPx / rh) : 0,
  };
}

// ---------------------------------------------------------------------------
// Panel adapter
// ---------------------------------------------------------------------------

/** Panels -> items, in the panels' own order. */
export function toItems(panels: readonly Panel[]): GridItem[] {
  return panels.map((p) => clampForLoad({ id: p.id, ...p.gridPos }));
}

/**
 * Writes positions back onto the ORIGINAL panel array, preserving its order.
 *
 * Array order is part of the serialized bytes — `sortKeys` orders object keys
 * but leaves arrays alone — so returning the engine's `(y, x, id)`-sorted array
 * would make the first drag on any dashboard produce a large spurious diff and
 * defeat the no-op-save check. It also keeps DOM node identity stable for the
 * keyed `{#each}`, which is what stops a chart being torn down mid-drag.
 */
export function applyItems(panels: readonly Panel[], items: readonly GridItem[]): Panel[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return panels.map((p) => {
    const item = byId.get(p.id);
    if (!item) return p;
    const { x, y, w, h } = item;
    if (x === p.gridPos.x && y === p.gridPos.y && w === p.gridPos.w && h === p.gridPos.h) {
      return p;
    }
    return { ...p, gridPos: { x, y, w, h } };
  });
}
