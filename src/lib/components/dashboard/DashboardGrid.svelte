<!--
  The drag-and-resize surface. All layout maths lives in `$lib/dashboard/gridEngine`
  (pure, tested); this file is pointer bookkeeping, keyboard handling and CSS.

  Svelte 4: `export let`, `$:`, no runes.

  Things here that look like style and are not:

  - `preview` is nullable and only non-null between pointerdown and drop. The
    naive `$: preview = items` re-runs whenever the parent reassigns `panels` —
    which it does on every query result and refresh tick — and the in-flight drag
    snaps back mid-gesture.
  - `{#each ... (panel.id)}` is keyed. Unkeyed, Svelte recreates the panel
    component on every layout change and tears down its chart.
  - `grid-template-columns: repeat(24, minmax(0, 1fr))`. Plain `1fr` is
    `minmax(auto, 1fr)`, so one panel containing a wide table or a long legend
    blows its column out and shifts every other panel.
  - The breakpoint is measured from the CONTAINER, not the viewport: this grid
    sits beside a collapsible sidebar, so a viewport media query collapses at the
    wrong moment whenever the sidebar state differs.
  - The single-column layout is a render-time projection and is NEVER emitted as
    a change. Otherwise opening a dashboard on a phone and saving anything
    destroys the desktop layout.
-->
<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import {
    GRID_COLS,
    applyItems,
    clampForDrag,
    moveItem,
    pointerToDelta,
    projectSingleColumn,
    resizeItem,
    toItems,
    type GridItem,
  } from '$lib/dashboard/gridEngine';
  import type { Panel } from '$lib/dashboard/model';

  export let panels: Panel[] = [];
  export let rowHeight = 30;
  export let gap = 8;
  /** Below this container width the grid collapses to one column. */
  export let singleColumnBelow = 640;
  export let editable = true;

  const dispatch = createEventDispatcher<{
    change: { panels: Panel[] };
    /** A layout edit was refused because it could not be saved. */
    nospace: void;
  }>();

  let container: HTMLDivElement | undefined;
  let containerWidth = 0;
  /** Non-null ONLY during a gesture. See the note above. */
  let preview: GridItem[] | null = null;
  let announcement = '';

  type Gesture = {
    kind: 'move' | 'resize';
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    origin: GridItem;
    target: HTMLElement;
  };
  let gesture: Gesture | null = null;
  let frame = 0;
  let pendingEvent: PointerEvent | null = null;

  /** Keyboard grab: arrows only move a panel once it has been picked up. */
  let grabbedId: string | null = null;
  /** Roving tabindex, so a 20-panel dashboard is one tab stop, not forty. */
  let focusedId: string | null = null;

  $: base = toItems(panels);
  $: narrow = containerWidth > 0 && containerWidth < singleColumnBelow;
  $: interactive = editable && !narrow;
  $: layout = narrow ? projectSingleColumn(preview ?? base) : (preview ?? base);
  $: positions = new Map(layout.map((i) => [i.id, i]));
  $: if (focusedId === null && panels.length > 0) focusedId = panels[0].id;

  // --- geometry ------------------------------------------------------------

  $: geom = { containerWidth, cols: GRID_COLS, rowHeight, gap };

  function observe(node: HTMLDivElement) {
    // ResizeObserver rather than a window listener: the container is what
    // matters, and it changes when the sidebar toggles without the window moving.
    if (typeof ResizeObserver === 'undefined') {
      containerWidth = node.clientWidth;
      return { destroy() {} };
    }
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) containerWidth = e.contentRect.width;
    });
    ro.observe(node);
    return { destroy: () => ro.disconnect() };
  }

  // --- commit --------------------------------------------------------------

  function commit(next: GridItem[]): void {
    const updated = applyItems(panels, next);
    // applyItems returns the same objects when nothing moved, so an identical
    // layout produces no event and cannot dirty the dashboard.
    if (updated.every((p, i) => p === panels[i])) return;
    panels = updated;
    dispatch('change', { panels: updated });
  }

  function apply(result: ReturnType<typeof moveItem>): GridItem[] {
    if (!result.ok) {
      dispatch('nospace');
      announce('No room for that change.');
    }
    return result.items;
  }

  function announce(text: string): void {
    // One region at grid level, one message per commit. Compaction relocates
    // panels the user never touched, so the collateral count is part of the
    // message — otherwise a screen-reader user has no signal at all.
    announcement = text;
  }

  function movedCount(before: GridItem[], after: GridItem[]): number {
    const prev = new Map(before.map((i) => [i.id, i]));
    return after.filter((i) => {
      const p = prev.get(i.id);
      return p && (p.x !== i.x || p.y !== i.y);
    }).length;
  }

  // --- pointer -------------------------------------------------------------

  function startGesture(kind: 'move' | 'resize', panel: Panel, event: PointerEvent): void {
    if (!interactive || event.button !== 0) return;
    const origin = base.find((i) => i.id === panel.id);
    if (!origin) return;

    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    gesture = {
      kind,
      id: panel.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin,
      target,
    };
    preview = base;
    focusedId = panel.id;
  }

  function onPointerMove(event: PointerEvent): void {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    pendingEvent = event;
    // Pointer events fire faster than frames, and most of them do not cross a
    // cell boundary, so coalescing to a frame is the difference between smooth
    // and not.
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const e = pendingEvent;
      pendingEvent = null;
      if (!e || !gesture) return;

      const { dx, dy } = pointerToDelta(e.clientX - gesture.startX, e.clientY - gesture.startY, geom);
      const { origin, id, kind } = gesture;

      if (kind === 'move') {
        const next = clampForDrag({ ...origin, x: origin.x + dx, y: Math.max(0, origin.y + dy) });
        if (next.x === origin.x && next.y === origin.y) {
          preview = base;
          return;
        }
        preview = moveItem(base, id, { x: next.x, y: next.y }, origin.y).items;
      } else {
        preview = resizeItem(base, id, { w: origin.w + dx, h: origin.h + dy }).items;
      }
    });
  }

  function endGesture(event: PointerEvent, cancelled = false): void {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    cancelFrame();
    const { target, pointerId, id, origin, kind } = gesture;
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    gesture = null;

    if (cancelled || !preview) {
      preview = null;
      return;
    }

    const current = preview.find((i) => i.id === id);
    preview = null;
    if (!current) return;

    const result =
      kind === 'move'
        ? moveItem(base, id, { x: current.x, y: current.y }, origin.y)
        : resizeItem(base, id, { w: current.w, h: current.h });
    const next = apply(result);
    if (result.ok) {
      const others = movedCount(base, next) - 1;
      announce(
        `${kind === 'move' ? 'Moved' : 'Resized'} to column ${current.x + 1}, row ${current.y + 1}` +
          (others > 0 ? `; ${others} other panel${others === 1 ? '' : 's'} moved.` : '.'),
      );
      commit(next);
    }
  }

  function cancelFrame(): void {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pendingEvent = null;
  }

  onDestroy(cancelFrame);

  // --- keyboard ------------------------------------------------------------

  const ARROWS: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };

  function onPanelKeydown(panel: Panel, event: KeyboardEvent): void {
    const delta = ARROWS[event.key];

    // Grab mode. Without it, arrows would have to be captured whenever a panel
    // has focus, which steals page scrolling and breaks any focusable content
    // inside the panel. It also gives the keyboard path a single commit point,
    // so it dirties the dashboard once rather than per keypress.
    if (event.key === 'Enter' || event.key === ' ') {
      if (!interactive) return;
      event.preventDefault();
      if (grabbedId === panel.id) {
        const next = preview ?? base;
        preview = null;
        grabbedId = null;
        commit(next);
        announce('Panel dropped.');
      } else {
        grabbedId = panel.id;
        preview = base;
        announce('Panel grabbed. Arrow keys move it, Enter to drop, Escape to cancel.');
      }
      return;
    }

    if (event.key === 'Escape' && grabbedId) {
      // Esc cancels the move. Dropping the preview restores the rendered
      // layout from `base`, and the model was never touched, so there is
      // nothing to emit. It must NOT blur — there is nothing to escape from
      // when no grab is active.
      event.preventDefault();
      preview = null;
      grabbedId = null;
      announce('Move cancelled.');
      return;
    }

    if (!delta) return;
    const [dx, dy] = delta;

    if (grabbedId !== panel.id) {
      // Not grabbed: arrows move FOCUS between panels, which is what makes the
      // grid a single tab stop.
      event.preventDefault();
      moveFocus(panel, dx, dy);
      return;
    }

    event.preventDefault();
    const current = (preview ?? base).find((i) => i.id === panel.id);
    if (!current) return;

    if (dy !== 0) {
      // Vertical keyboard movement is REORDER, not y ± 1. A one-row nudge is
      // undone by gravity — the panel pushes its neighbour, compaction pulls it
      // straight back, and the key appears to do nothing forever.
      preview = apply(reorderVertically(preview ?? base, panel.id, dy));
    } else {
      const next = clampForDrag({ ...current, x: current.x + dx });
      preview = apply(moveItem(preview ?? base, panel.id, { x: next.x, y: current.y }, current.y));
    }
    const moved = (preview ?? base).find((i) => i.id === panel.id);
    if (moved) announce(`Column ${moved.x + 1}, row ${moved.y + 1}.`);
  }

  /** Swaps a panel with its nearest neighbour above or below. */
  function reorderVertically(items: GridItem[], id: string, dir: number) {
    const me = items.find((i) => i.id === id);
    if (!me) return { ok: true as const, items };
    const candidates = items
      .filter((i) => i.id !== id && i.x < me.x + me.w && i.x + i.w > me.x)
      .filter((i) => (dir < 0 ? i.y < me.y : i.y > me.y))
      .sort((a, b) => (dir < 0 ? b.y - a.y : a.y - b.y));
    const neighbour = candidates[0];
    if (!neighbour) return { ok: true as const, items };
    const targetY = dir < 0 ? neighbour.y : neighbour.y + neighbour.h - me.h;
    return moveItem(items, id, { x: me.x, y: Math.max(0, targetY) }, me.y);
  }

  function moveFocus(panel: Panel, dx: number, dy: number): void {
    const me = positions.get(panel.id);
    if (!me) return;
    const ranked = [...layout]
      .filter((i) => i.id !== panel.id)
      .map((i) => ({ i, score: (i.x - me.x) * dx + (i.y - me.y) * dy }))
      .filter((r) => r.score > 0)
      .sort((a, b) => a.score - b.score);
    const next = ranked[0]?.i;
    if (!next) return;
    focusedId = next.id;
    container?.querySelector<HTMLElement>(`[data-handle-id="${next.id}"]`)?.focus();
  }

  $: placeholder = gesture || grabbedId ? positions.get(gesture?.id ?? grabbedId ?? '') : undefined;
</script>

<div
  class="dashboard-grid"
  class:narrow
  bind:this={container}
  use:observe
  style="--row-h:{rowHeight}px; --gap:{gap}px; --cols:{GRID_COLS};"
>
  {#if placeholder}
    <!-- Rendered from the RESOLVED layout, not a ghost under the cursor, so the
         user sees where panels will actually land before releasing. -->
    <div
      class="placeholder"
      aria-hidden="true"
      style="grid-column: {placeholder.x + 1} / span {placeholder.w}; grid-row: {placeholder.y +
        1} / span {placeholder.h};"
    ></div>
  {/if}

  {#each panels as panel (panel.id)}
    {@const pos = positions.get(panel.id)}
    {#if pos}
      <div
        class="cell"
        class:dragging={gesture?.id === panel.id}
        class:grabbed={grabbedId === panel.id}
        data-panel-id={panel.id}
        role="group"
        aria-roledescription="Dashboard panel"
        aria-label={panel.title || 'Untitled panel'}
        style="grid-column: {pos.x + 1} / span {pos.w}; grid-row: {pos.y + 1} / span {pos.h};"
      >
        <slot {panel} dragging={gesture?.id === panel.id}>
          <div class="fallback">{panel.title || panel.id}</div>
        </slot>

        {#if interactive}
          <!--
            A real <button>, not a div with handlers. It is the panel's single tab
            stop and the element assistive tech can find and activate; a bare div
            with a pointerdown listener is invisible to AT, and a non-interactive
            role cannot legally carry a non-negative tabindex.

            `touch-action: none` is required on it: Pointer Events alone do not
            stop the browser from scrolling instead of dragging on touch.
          -->
          <button
            type="button"
            class="drag-handle"
            data-handle-id={panel.id}
            aria-label="Move {panel.title || 'panel'}. Press Enter to grab, arrow keys to move."
            aria-pressed={grabbedId === panel.id}
            tabindex={focusedId === panel.id ? 0 : -1}
            on:keydown={(e) => onPanelKeydown(panel, e)}
            on:focus={() => (focusedId = panel.id)}
            on:pointerdown={(e) => startGesture('move', panel, e)}
            on:pointermove={onPointerMove}
            on:pointerup={endGesture}
            on:pointercancel={(e) => endGesture(e, true)}
            on:lostpointercapture={(e) => endGesture(e, true)}
          ></button>
          <button
            type="button"
            class="resize-handle"
            aria-label="Resize {panel.title || 'panel'}"
            tabindex="-1"
            on:pointerdown={(e) => startGesture('resize', panel, e)}
            on:pointermove={onPointerMove}
            on:pointerup={endGesture}
            on:pointercancel={(e) => endGesture(e, true)}
            on:lostpointercapture={(e) => endGesture(e, true)}
          ></button>
        {/if}
      </div>
    {/if}
  {/each}
</div>

<div class="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>

<style>
  .dashboard-grid {
    display: grid;
    /* minmax(0, 1fr), never plain 1fr: a panel with a wide table would otherwise
       blow its column out and shift every other panel. */
    grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
    grid-auto-rows: var(--row-h);
    gap: var(--gap);
    position: relative;
    width: 100%;
  }

  .dashboard-grid.narrow {
    grid-template-columns: minmax(0, 1fr);
  }

  .cell {
    position: relative;
    /* Same reason as the columns: without these a panel's content sets its own
       minimum size and the track stops being 1fr. */
    min-width: 0;
    min-height: 0;
    outline: none;
  }

  .cell:focus-within {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 2px;
  }

  .cell.dragging,
  .cell.grabbed {
    z-index: 10;
    opacity: 0.85;
  }

  .placeholder {
    border: 2px dashed hsl(var(--muted-foreground) / 0.5);
    border-radius: 0.5rem;
    background: hsl(var(--muted) / 0.3);
    pointer-events: none;
  }

  /*
    Spans the header so the whole title bar is grabbable — but it paints AFTER
    the slot, so anything interactive a panel puts in its header (the kebab
    menu, an error badge) would be covered and unclickable.

    The contract with PanelChrome: header controls sit in a `position: relative;
    z-index: 1` cluster, which paints in the positive stacking step and so lands
    above this. Do not give this handle a z-index; that would create a stacking
    context and break the arrangement.
  */
  .drag-handle {
    position: absolute;
    inset: 0 0 auto 0;
    height: 2rem;
    cursor: grab;
    touch-action: none;
    background: transparent;
    border: 0;
    padding: 0;
  }

  .drag-handle:active {
    cursor: grabbing;
  }

  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 1rem;
    height: 1rem;
    cursor: se-resize;
    touch-action: none;
    background: transparent;
    border: 0;
    padding: 0;
  }

  .resize-handle::after {
    content: '';
    position: absolute;
    right: 3px;
    bottom: 3px;
    width: 6px;
    height: 6px;
    border-right: 2px solid hsl(var(--muted-foreground) / 0.6);
    border-bottom: 2px solid hsl(var(--muted-foreground) / 0.6);
  }

  .fallback {
    display: flex;
    height: 100%;
    align-items: center;
    justify-content: center;
    border: 1px solid hsl(var(--border));
    border-radius: 0.5rem;
    font-size: 0.75rem;
    color: hsl(var(--muted-foreground));
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }
</style>
