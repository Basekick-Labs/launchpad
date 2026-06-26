<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { createVirtualizer } from '@tanstack/svelte-virtual';
  import { cn } from '$lib/utils';
  import { ChevronDown, ChevronRight, Filter, AlertCircle, CheckCircle2 } from 'lucide-svelte';
  import type { TraceData } from '$lib/traceExtractor';
  import { formatDuration } from '$lib/traceExtractor';
  import SpanWaterfall from './SpanWaterfall.svelte';

  export let traces: TraceData[] = [];

  const dispatch = createEventDispatcher<{
    filterByTrace: { traceId: string };
  }>();

  let scrollElement: HTMLDivElement;
  let expandedTraces: Set<string> = new Set();

  // Virtualization for traces list
  $: virtualizer = createVirtualizer({
    count: traces.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 56,
    overscan: 5,
  });

  $: items = $virtualizer.getVirtualItems();
  $: totalSize = $virtualizer.getTotalSize();

  function toggleTraceExpand(traceId: string) {
    if (expandedTraces.has(traceId)) {
      expandedTraces.delete(traceId);
    } else {
      expandedTraces.add(traceId);
    }
    expandedTraces = expandedTraces;
    $virtualizer.measure();
  }

  function handleFilterByTrace(traceId: string, event: MouseEvent) {
    event.stopPropagation();
    dispatch('filterByTrace', { traceId });
  }

  function truncateTraceId(traceId: string): string {
    if (traceId.length <= 16) return traceId;
    return `${traceId.slice(0, 8)}...${traceId.slice(-4)}`;
  }

  function formatTimestamp(date: Date): string {
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  // Svelte action for dynamic row measurement
  function measureElement(node: HTMLElement, virtualizer: any) {
    const observer = new ResizeObserver(() => {
      virtualizer.measureElement(node);
    });
    observer.observe(node);
    virtualizer.measureElement(node);

    return {
      destroy() {
        observer.disconnect();
      },
      update(newVirtualizer: any) {
        newVirtualizer.measureElement(node);
      },
    };
  }
</script>

<div class="flex h-full flex-col">
  <!-- Column Headers -->
  <div
    class="flex items-center gap-2 px-4 py-2 border-b text-xs font-medium text-muted-foreground shrink-0 bg-muted/40"
  >
    <span class="w-6"></span>
    <span class="w-[140px] uppercase">Trace ID</span>
    <span class="w-[60px] text-right uppercase">Spans</span>
    <span class="w-[80px] text-right uppercase">Duration</span>
    <span class="w-[80px] uppercase">Time</span>
    <span class="flex-1 uppercase">Services</span>
    <span class="w-[60px] text-center uppercase">Status</span>
    <span class="w-[40px]"></span>
  </div>

  <!-- Virtualized Trace List -->
  {#if traces.length === 0}
    <div class="flex-1 flex items-center justify-center text-muted-foreground text-sm">
      No traces found
    </div>
  {:else}
    <div bind:this={scrollElement} class="flex-1 overflow-auto">
      <div style="height: {totalSize}px; width: 100%; position: relative;">
        {#each items as row (row.index)}
          {@const trace = traces[row.index]}
          {@const isExpanded = expandedTraces.has(trace.traceId)}

          <div
            data-index={row.index}
            style="position: absolute; top: 0; left: 0; width: 100%; transform: translateY({row.start}px);"
            class={cn("group border-b hover:bg-muted/20", trace.hasErrors && "bg-red-500/5")}
            use:measureElement={$virtualizer}
          >
            <!-- Collapsed Row -->
            <button
              class="flex w-full items-center gap-2 px-4 py-3 text-left"
              on:click={() => toggleTraceExpand(trace.traceId)}
            >
              <span class="w-6 shrink-0 text-muted-foreground">
                {#if isExpanded}
                  <ChevronDown class="h-4 w-4" />
                {:else}
                  <ChevronRight class="h-4 w-4" />
                {/if}
              </span>

              <span
                class="w-[140px] font-mono text-xs truncate"
                title={trace.traceId}
              >
                {truncateTraceId(trace.traceId)}
              </span>

              <span class="w-[60px] text-right font-mono text-xs font-semibold">
                {trace.spans.length}
              </span>

              <span class="w-[80px] text-right font-mono text-xs">
                {formatDuration(trace.totalDuration)}
              </span>

              <span class="w-[80px] font-mono text-xs text-muted-foreground">
                {formatTimestamp(trace.startTime)}
              </span>

              <span class="flex-1 text-xs truncate">
                {#if trace.services.length > 0}
                  <span class="flex gap-1 flex-wrap">
                    {#each trace.services.slice(0, 3) as service}
                      <span class="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        {service}
                      </span>
                    {/each}
                    {#if trace.services.length > 3}
                      <span class="px-1.5 py-0.5 text-muted-foreground">
                        +{trace.services.length - 3}
                      </span>
                    {/if}
                  </span>
                {:else}
                  <span class="text-muted-foreground">-</span>
                {/if}
              </span>

              <span class="w-[60px] flex justify-center">
                {#if trace.hasErrors}
                  <AlertCircle class="h-4 w-4 text-red-500" />
                {:else}
                  <CheckCircle2 class="h-4 w-4 text-green-500" />
                {/if}
              </span>

              <div class="w-[40px] flex items-center justify-end">
                <button
                  on:click={(e) => handleFilterByTrace(trace.traceId, e)}
                  class="p-1 rounded hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Show logs for this trace"
                >
                  <Filter class="h-4 w-4 text-muted-foreground hover:text-primary" />
                </button>
              </div>
            </button>

            <!-- Expanded Span Waterfall -->
            {#if isExpanded}
              <div class="border-t bg-muted/10">
                <SpanWaterfall {trace} />
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Footer -->
  <div class="border-t px-4 py-2 text-xs text-muted-foreground bg-muted/10">
    Click a trace to expand span details, or use <Filter class="h-3 w-3 inline" /> to filter logs
  </div>
</div>
