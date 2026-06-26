<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { createVirtualizer } from '@tanstack/svelte-virtual';
  import { cn } from '$lib/utils';
  import { ChevronDown, ChevronRight, Copy, Check, ArrowDown, Layers } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    getLevelColorClass,
    getLevelBgClass,
    formatLogTimestamp,
    type LogFieldMapping,
  } from '$lib/logFieldDetector';

  export let logs: Record<string, unknown>[] = [];
  export let fieldMapping: LogFieldMapping;
  export let columns: string[] = [];
  export let autoScroll = false; // When true, auto-scroll to top on new logs
  export let useUtc = false; // Display timestamps in UTC or local time

  const dispatch = createEventDispatcher<{
    showContext: { log: Record<string, unknown>; index: number };
  }>();

  let scrollElement: HTMLDivElement;
  let expandedRows: Set<number> = new Set();
  let copiedRow: number | null = null;

  // Auto-scroll state
  let userHasScrolled = false;
  let showScrollToTop = false;
  let previousLogCount = 0;
  let newLogCount = 0;

  // Estimated row height - expanded rows will be measured dynamically
  const ESTIMATED_ROW_HEIGHT = 36;

  $: virtualizer = createVirtualizer({
    count: logs.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 10,
  });

  $: items = $virtualizer.getVirtualItems();
  $: totalSize = $virtualizer.getTotalSize();

  // Handle new logs arriving
  $: if (logs.length > previousLogCount && autoScroll) {
    newLogCount = logs.length - previousLogCount;
    previousLogCount = logs.length;

    // Auto-scroll to top if user hasn't scrolled away
    if (!userHasScrolled && scrollElement) {
      scrollElement.scrollTop = 0;
    } else {
      showScrollToTop = true;
    }
  } else if (logs.length !== previousLogCount) {
    previousLogCount = logs.length;
    newLogCount = 0;
  }

  function handleScroll() {
    if (!scrollElement) return;

    // User has scrolled if not at the top
    const isAtTop = scrollElement.scrollTop < 50;
    userHasScrolled = !isAtTop;

    // Hide "scroll to top" indicator when at top
    if (isAtTop) {
      showScrollToTop = false;
      newLogCount = 0;
    }
  }

  function scrollToTop() {
    if (scrollElement) {
      scrollElement.scrollTo({ top: 0, behavior: 'smooth' });
      userHasScrolled = false;
      showScrollToTop = false;
      newLogCount = 0;
    }
  }

  function toggleRowExpand(index: number) {
    if (expandedRows.has(index)) {
      expandedRows.delete(index);
    } else {
      expandedRows.add(index);
    }
    expandedRows = expandedRows;
    // Force virtualizer to recalculate
    $virtualizer.measure();
  }

  async function copyLogRow(index: number, event: MouseEvent) {
    event.stopPropagation();
    const log = logs[index];
    try {
      await navigator.clipboard.writeText(JSON.stringify(log, null, 2));
      copiedRow = index;
      setTimeout(() => {
        copiedRow = null;
      }, 2000);
    } catch {
      // Clipboard API failed
    }
  }

  function getLogValue(log: Record<string, unknown>, field: string | null): string {
    if (!field || !(field in log)) return '-';
    const value = log[field];
    if (value === null || value === undefined) return '-';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  interface DisplayColumn {
    field: string;
    label: string;
    width: string;
    flex?: boolean;
  }

  function getDisplayColumns(
    mapping: LogFieldMapping,
    allColumns: string[]
  ): DisplayColumn[] {
    const cols: DisplayColumn[] = [];

    // Always show timestamp first (if detected)
    if (mapping.timestamp) {
      cols.push({ field: mapping.timestamp, label: 'Time', width: 'w-[140px]' });
    }

    // Show level if present
    if (mapping.level) {
      cols.push({ field: mapping.level, label: 'Level', width: 'w-[60px]' });
    }

    // Show source if present
    if (mapping.source) {
      cols.push({ field: mapping.source, label: mapping.source, width: 'w-[100px]' });
    }

    // Show message if present (takes flex space)
    if (mapping.message) {
      cols.push({ field: mapping.message, label: 'Message', width: '', flex: true });
    } else {
      // No message field - show other interesting columns
      const skipFields = new Set(
        [
          mapping.timestamp,
          mapping.level,
          mapping.source,
          mapping.traceId,
          mapping.spanId,
          mapping.parentSpanId,
        ].filter(Boolean)
      );

      // Pick up to 3 other columns to display
      const otherCols = allColumns.filter((c) => !skipFields.has(c));
      const showCols = otherCols.slice(0, 3);

      showCols.forEach((col, i) => {
        const isLast = i === showCols.length - 1;
        cols.push({
          field: col,
          label: col,
          width: isLast ? '' : 'w-[120px]',
          flex: isLast,
        });
      });
    }

    return cols;
  }

  // Compute display columns dynamically
  $: displayColumns = getDisplayColumns(fieldMapping, columns);

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
      }
    };
  }
</script>

<div class="relative h-full flex flex-col">
  <!-- Column Headers -->
  <div class="flex items-center gap-2 px-4 py-2 border-b bg-muted/40 text-xs font-medium text-muted-foreground shrink-0">
    <span class="w-6"></span> <!-- Chevron spacer -->
    {#each displayColumns as col}
      <span class={cn(col.width, col.flex && 'flex-1', 'shrink-0 uppercase truncate')}>
        {col.label}
      </span>
    {/each}
    <span class="w-[52px]"></span> <!-- Actions spacer -->
  </div>

  <div
    bind:this={scrollElement}
    class="flex-1 overflow-auto"
    on:scroll={handleScroll}
  >
    <div style="height: {totalSize}px; width: 100%; position: relative;">
      {#each items as row (row.index)}
        {@const log = logs[row.index]}
        {@const isExpanded = expandedRows.has(row.index)}
        {@const level = getLogValue(log, fieldMapping.level)}

        <div
          data-index={row.index}
          style="position: absolute; top: 0; left: 0; width: 100%; transform: translateY({row.start}px);"
          class={cn('group border-b', getLevelBgClass(level))}
          use:measureElement={$virtualizer}
        >
          <!-- Collapsed Row -->
          <button
            class="flex w-full items-start gap-2 px-4 py-2 text-left hover:bg-muted/30 transition-colors"
            on:click={() => toggleRowExpand(row.index)}
          >
            <span class="w-6 shrink-0 mt-0.5 text-muted-foreground">
              {#if isExpanded}
                <ChevronDown class="h-4 w-4" />
              {:else}
                <ChevronRight class="h-4 w-4" />
              {/if}
            </span>

            {#each displayColumns as col}
              {@const value = getLogValue(log, col.field)}
              <span
                class={cn(
                  col.width,
                  col.flex && 'flex-1',
                  'shrink-0 truncate font-mono text-xs',
                  col.field === fieldMapping.level && getLevelColorClass(value),
                  col.field === fieldMapping.level && 'font-semibold',
                  col.field === fieldMapping.timestamp && 'text-muted-foreground'
                )}
              >
                {col.field === fieldMapping.timestamp ? formatLogTimestamp(value, useUtc) : value}
              </span>
            {/each}

            <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                on:click={(e) => {
                  e.stopPropagation();
                  dispatch('showContext', { log, index: row.index });
                }}
                title="Show surrounding logs"
                class="p-1 rounded hover:bg-muted"
              >
                <Layers class="h-4 w-4 text-muted-foreground hover:text-foreground" />
              </button>
              <button
                on:click={(e) => copyLogRow(row.index, e)}
                title="Copy log entry"
                class="p-1 rounded hover:bg-muted"
              >
                {#if copiedRow === row.index}
                  <Check class="h-4 w-4 text-green-500" />
                {:else}
                  <Copy class="h-4 w-4 text-muted-foreground hover:text-foreground" />
                {/if}
              </button>
            </div>
          </button>

          <!-- Expanded Details -->
          {#if isExpanded}
            <div class="border-t bg-muted/20 px-4 py-3 ml-6">
              <div class="grid gap-2">
                {#each Object.entries(log) as [key, value]}
                  <div class="flex gap-2 font-mono text-xs">
                    <span class="w-[150px] shrink-0 text-muted-foreground">{key}:</span>
                    <span class="break-all whitespace-pre-wrap">
                      {#if typeof value === 'object'}
                        {JSON.stringify(value, null, 2)}
                      {:else}
                        {value ?? 'null'}
                      {/if}
                    </span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>

  <!-- Scroll to top indicator (shows when new logs arrive and user has scrolled) -->
  {#if showScrollToTop && autoScroll}
    <div class="absolute top-4 left-1/2 -translate-x-1/2 z-10">
      <Button
        size="sm"
        on:click={scrollToTop}
        class="shadow-lg"
      >
        <ArrowDown class="mr-2 h-4 w-4 rotate-180" />
        {newLogCount} new log{newLogCount !== 1 ? 's' : ''}
      </Button>
    </div>
  {/if}
</div>
