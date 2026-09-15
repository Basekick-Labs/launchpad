<!--
  The time series panel.

  Deliberately thin: every decision lives in `$lib/dashboard/timeSeriesOptions`,
  which is testable in node. This file is `new uPlot` / `setData` / `setSize` /
  `destroy` plus the legend and tooltip markup.

  ## Three uPlot behaviours this is built around

  1. **Colours are functions.** uPlot wraps `series[i].stroke` in `fnOrSelf` at
     construction and invokes it on every draw, so assigning a colour string to
     restyle a theme change throws inside `drawSeries` and kills the panel. The
     options builder closes every colour over a mutable `ink` object; a theme
     change writes `ink` and calls `redraw(false)`.

  2. **`setData(d)` resets the viewport.** It calls `autoScaleX()` unless passed
     `false`. Always `setData(d, false)`, with the x scale pinned to the
     dashboard range.

  3. **A series-count change is a REBUILD.** The number of y arrays must equal
     `series.length - 1`. Too few and `drawSeries` dereferences `undefined` and
     throws; too many and the extra series silently never renders, which is the
     more dangerous direction. `addSeries`/`delSeries` are not an escape hatch —
     `delSeries` throws when `cursor.points.show` is falsy, which is a config
     this repo already uses.

  Drag-to-zoom and the shared crosshair are NOT here. `cursor.sync` forwards
  mousedown/mouseup/dblclick as well as the cursor, so a drag on one panel zooms
  every synced panel and fires one `setSelect` per panel — which would push a
  history entry per panel for a single drag. It needs its own issue.
-->
<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { colorScheme } from '$lib/stores/theme';
  import {
    buildTimeSeriesOptions,
    restyle,
    type BuildResult,
    type UPlotData,
  } from '$lib/dashboard/timeSeriesOptions';
  import type { Frame } from '$lib/dashboard/frame';
  import type { PanelResult } from '$lib/dashboard/queryRunner';
  import type { FieldConfigSource } from '$lib/dashboard/model';

  /** What PanelChrome passes through its slot. */
  export let result: PanelResult | null = null;
  export let fieldConfig: FieldConfigSource | undefined = undefined;
  export let from: number;
  export let to: number;
  export let timezone = 'UTC';
  /**
   * Held by the PAGE, keyed by panel id: PanelChrome unmounts this slot on every
   * state change, so component-local state would not survive and colours would
   * shuffle whenever a series was filtered out.
   *
   * Input only. The new assignment goes back up as a `slots` event — writing to
   * the prop here would make `build` depend on its own output.
   */
  export let priorSlots: Record<string, number> = {};
  export let legendPlacement: 'bottom' | 'right' = 'bottom';
  export let showLegend = true;

  let container: HTMLDivElement | undefined;
  let chart: { setData: (d: unknown, reset?: boolean) => void; setSize: (s: { width: number; height: number }) => void; redraw: (rebuildPaths?: boolean) => void; destroy: () => void; cursor: { idx: number | null }; data: unknown[] } | null = null;
  let built: BuildResult | null = null;
  let shapeKey = '';
  let uPlotCtor: (new (o: unknown, d: unknown, el: HTMLElement) => NonNullable<typeof chart>) & {
    tzDate: (d: Date, tz: string) => Date;
  } | null = null;

  /** Cursor index, for the tooltip. */
  let cursorIdx: number | null = null;

  // A partly-failed panel still reports success, so skip the targets that have
  // no frame rather than assuming every target produced one.
  $: frames = (result?.targets ?? [])
    .map((t) => t.frame)
    .filter((f): f is Frame => f !== undefined);

  $: build = buildTimeSeriesOptions({
    frames,
    fieldConfig,
    from,
    to,
    scheme: $colorScheme,
    timezone,
    priorSlots,
    tzDate: uPlotCtor ? (ts: number) => uPlotCtor!.tzDate(new Date(ts), timezone) : undefined,
  });

  const dispatch = createEventDispatcher<{ slots: Record<string, number> }>();

  // Report the assignment upward so the next mount keeps colours stable. The
  // page stores it and passes it back as `priorSlots`.
  $: if (build && Object.keys(build.slots).length > 0) dispatch('slots', build.slots);

  $: void sync(build);

  async function sync(next: BuildResult): Promise<void> {
    if (!container || !uPlotCtor || next.refusal || next.series.length === 0) {
      if (next.refusal && chart) destroyChart();
      return;
    }
    built = next;

    if (!chart || next.shapeKey !== shapeKey) {
      // Series count, draw style, null mode or timezone changed — the config is
      // baked at construction, so this is a rebuild rather than a setData.
      destroyChart();
      await tick();
      if (!container) return;
      shapeKey = next.shapeKey;
      chart = new uPlotCtor(
        { ...next.options, width: container.clientWidth || 300, height: container.clientHeight || 150 },
        next.data as unknown,
        container,
      );
      return;
    }

    // `false` keeps the viewport: the default calls autoScaleX and snaps x to
    // the new data extent.
    chart.setData(next.data as unknown, false);
  }

  // A theme change is a restyle, never a rebuild — so the viewport survives.
  $: if (chart && built) {
    restyle(built.ink, $colorScheme, built.series.map((s) => s.label), built.slots);
    chart.redraw(false);
  }

  function destroyChart(): void {
    chart?.destroy();
    chart = null;
    shapeKey = '';
  }

  let frame = 0;
  function observe(node: HTMLDivElement) {
    if (typeof ResizeObserver === 'undefined') return { destroy() {} };
    const ro = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        // clientWidth/Height exclude a scrollbar. Measuring contentRect on a
        // scrolling ancestor can oscillate: setSize overshoots by a pixel, a
        // scrollbar appears, the box shrinks, the observer fires again.
        const w = node.clientWidth;
        const h = node.clientHeight;
        // A hidden panel (kiosk, fullscreen) measures 0 and would put NaNs
        // through uPlot's layout convergence.
        if (chart && w > 0 && h > 0) chart.setSize({ width: w, height: h });
      });
    });
    ro.observe(node);
    return {
      destroy() {
        ro.disconnect();
        if (frame) cancelAnimationFrame(frame);
      },
    };
  }

  onMount(async () => {
    // The one dynamic import that keeps uPlot out of the dashboard route chunk.
    const mod = await import('uplot');
    uPlotCtor = mod.default as typeof uPlotCtor;
    await sync(build);
  });

  onDestroy(() => {
    if (frame) cancelAnimationFrame(frame);
    // uPlot's destroy also unsubscribes from any cursor sync group, so panel
    // churn does not leak.
    destroyChart();
  });

  function onMove(event: MouseEvent): void {
    if (!chart || !container) return;
    cursorIdx = chart.cursor.idx;
    tooltipX = event.offsetX;
    tooltipY = event.offsetY;
  }
  let tooltipX = 0;
  let tooltipY = 0;

  $: tooltipRows =
    cursorIdx === null || !chart || !built
      ? []
      : built.series.map((s, i) => ({
          label: s.label,
          color: built!.ink.colors[i],
          value: (chart!.data[i + 1] as (number | null)[] | undefined)?.[cursorIdx as number] ?? null,
        }));
</script>

<div class="wrap" class:right={legendPlacement === 'right'}>
  {#if build.refusal}
    <p class="refusal">{build.refusal}</p>
  {:else if build.series.length === 0}
    <p class="refusal">No series to draw.</p>
  {:else}
    <div
      class="plot"
      bind:this={container}
      use:observe
      role="presentation"
      on:mousemove={onMove}
      on:mouseleave={() => (cursorIdx = null)}
    >
      {#if cursorIdx !== null && tooltipRows.length > 0}
        <div class="tooltip" style="left:{tooltipX + 12}px; top:{tooltipY + 12}px">
          {#each tooltipRows as row}
            <div class="row">
              <span class="swatch" style:background={row.color}></span>
              <span class="name">{row.label}</span>
              <span class="val">{row.value ?? '—'}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    {#if showLegend}
      <!-- Ours, not uPlot's: uPlot's legend is a table inside the plot root so
           it cannot sit to the right, and its marker colours are inline styles
           written once at construction — a theme change would leave every
           marker stale. -->
      <ul class="legend">
        {#each build.series as s, i}
          <li>
            <span class="swatch" style:background={build.ink.colors[i]}></span>
            <span class="name" title={s.label}>{s.label}</span>
            {#if s.overflow}
              <span class="over" title="More series than the palette has colours">dashed</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .wrap { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; gap: 0.35rem; }
  .wrap.right { flex-direction: row; }
  .plot { flex: 1; min-height: 0; min-width: 0; position: relative; overflow: hidden; }
  .refusal {
    margin: 0;
    display: flex;
    height: 100%;
    align-items: center;
    justify-content: center;
    text-align: center;
    font-size: 0.8125rem;
    color: hsl(var(--muted-foreground));
  }
  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    font-size: 0.6875rem;
    overflow: auto;
    flex: none;
    max-height: 4rem;
  }
  .wrap.right .legend { flex-direction: column; flex-wrap: nowrap; max-height: none; width: 9rem; }
  .legend li { display: flex; align-items: center; gap: 0.3rem; min-width: 0; }
  .swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .over { color: hsl(var(--muted-foreground)); font-style: italic; }
  .tooltip {
    position: absolute;
    z-index: 10;
    pointer-events: none;
    padding: 0.35rem 0.5rem;
    border-radius: 0.375rem;
    background: hsl(var(--popover));
    border: 1px solid hsl(var(--border));
    font-size: 0.6875rem;
    white-space: nowrap;
    box-shadow: 0 2px 8px hsl(0 0% 0% / 0.15);
  }
  .tooltip .row { display: flex; align-items: center; gap: 0.35rem; }
  .tooltip .val { margin-left: auto; font-variant-numeric: tabular-nums; }
</style>
