<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { createVirtualizer } from '@tanstack/svelte-virtual';
  import { cn } from '$lib/utils';
  import { ChevronDown, ChevronRight, Filter, Copy, Check } from 'lucide-svelte';
  import type { LogPattern } from '$lib/logPatterns';
  import { formatLogTimestamp } from '$lib/logFieldDetector';

  export let patterns: LogPattern[] = [];
  export let totalLogs: number = 0;

  const dispatch = createEventDispatcher<{
    filterByPattern: { pattern: LogPattern };
  }>();

  let scrollElement: HTMLDivElement;
  let expandedPatterns: Set<string> = new Set();
  let copiedPattern: string | null = null;

  // Virtualization for patterns list
  $: virtualizer = createVirtualizer({
    count: patterns.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 56,
    overscan: 5,
  });

  $: items = $virtualizer.getVirtualItems();
  $: totalSize = $virtualizer.getTotalSize();

  function togglePatternExpand(patternId: string) {
    if (expandedPatterns.has(patternId)) {
      expandedPatterns.delete(patternId);
    } else {
      expandedPatterns.add(patternId);
    }
    expandedPatterns = expandedPatterns;
    $virtualizer.measure();
  }

  function handleFilterByPattern(pattern: LogPattern, event: MouseEvent) {
    event.stopPropagation();
    dispatch('filterByPattern', { pattern });
  }

  function copyTemplate(pattern: LogPattern, event: MouseEvent) {
    event.stopPropagation();
    navigator.clipboard.writeText(pattern.template);
    copiedPattern = pattern.id;
    setTimeout(() => {
      copiedPattern = null;
    }, 2000);
  }

  function formatPercentage(value: number): string {
    return value < 1 ? '<1%' : `${Math.round(value)}%`;
  }

  function getLevelDistributionBars(pattern: LogPattern) {
    const total = pattern.count;
    return [
      { level: 'error', count: pattern.levelDistribution.error, color: 'bg-red-500' },
      { level: 'warn', count: pattern.levelDistribution.warn, color: 'bg-yellow-500' },
      { level: 'info', count: pattern.levelDistribution.info, color: 'bg-blue-500' },
      { level: 'debug', count: pattern.levelDistribution.debug, color: 'bg-neutral-500' },
      { level: 'other', count: pattern.levelDistribution.other, color: 'bg-neutral-400' },
    ]
      .filter((d) => d.count > 0)
      .map((d) => ({ ...d, width: (d.count / total) * 100 }));
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
    <span class="flex-1 uppercase">Pattern</span>
    <span class="w-[80px] text-right uppercase">Count</span>
    <span class="w-[50px] text-right uppercase">%</span>
    <span class="w-[100px] uppercase">Levels</span>
    <span class="w-[60px]"></span>
  </div>

  <!-- Virtualized Pattern List -->
  {#if patterns.length === 0}
    <div class="flex-1 flex items-center justify-center text-muted-foreground text-sm">
      No patterns detected
    </div>
  {:else}
    <div bind:this={scrollElement} class="flex-1 overflow-auto">
      <div style="height: {totalSize}px; width: 100%; position: relative;">
        {#each items as row (row.index)}
          {@const pattern = patterns[row.index]}
          {@const isExpanded = expandedPatterns.has(pattern.id)}
          {@const bars = getLevelDistributionBars(pattern)}

          <div
            data-index={row.index}
            style="position: absolute; top: 0; left: 0; width: 100%; transform: translateY({row.start}px);"
            class="group border-b hover:bg-muted/20"
            use:measureElement={$virtualizer}
          >
            <!-- Collapsed Row -->
            <button
              class="flex w-full items-center gap-2 px-4 py-3 text-left"
              on:click={() => togglePatternExpand(pattern.id)}
            >
              <span class="w-6 shrink-0 text-muted-foreground">
                {#if isExpanded}
                  <ChevronDown class="h-4 w-4" />
                {:else}
                  <ChevronRight class="h-4 w-4" />
                {/if}
              </span>

              <span class="flex-1 font-mono text-xs truncate" title={pattern.template}>
                {pattern.template}
              </span>

              <span class="w-[80px] text-right font-mono text-xs font-semibold">
                {pattern.count.toLocaleString()}
              </span>

              <span class="w-[50px] text-right font-mono text-xs text-muted-foreground">
                {formatPercentage(pattern.percentage)}
              </span>

              <!-- Level Distribution Bar -->
              <div class="w-[100px] h-2 bg-muted rounded-full overflow-hidden flex">
                {#each bars as bar}
                  <div class={bar.color} style="width: {bar.width}%"></div>
                {/each}
              </div>

              <div class="w-[60px] flex items-center justify-end gap-1">
                <button
                  on:click={(e) => copyTemplate(pattern, e)}
                  class="p-1 rounded hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Copy pattern"
                >
                  {#if copiedPattern === pattern.id}
                    <Check class="h-4 w-4 text-green-500" />
                  {:else}
                    <Copy class="h-4 w-4 text-muted-foreground" />
                  {/if}
                </button>
                <button
                  on:click={(e) => handleFilterByPattern(pattern, e)}
                  class="p-1 rounded hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Filter logs by this pattern"
                >
                  <Filter class="h-4 w-4 text-muted-foreground hover:text-primary" />
                </button>
              </div>
            </button>

            <!-- Expanded Details -->
            {#if isExpanded}
              <div class="border-t bg-muted/10 px-4 py-3 ml-6">
                <div class="grid grid-cols-2 gap-4 mb-4">
                  <div>
                    <span class="text-xs text-muted-foreground">First seen</span>
                    <div class="font-mono text-xs">
                      {pattern.firstSeen ? formatLogTimestamp(pattern.firstSeen) : '-'}
                    </div>
                  </div>
                  <div>
                    <span class="text-xs text-muted-foreground">Last seen</span>
                    <div class="font-mono text-xs">
                      {pattern.lastSeen ? formatLogTimestamp(pattern.lastSeen) : '-'}
                    </div>
                  </div>
                </div>

                <div class="mb-2 text-xs text-muted-foreground">Sample logs:</div>
                <div class="space-y-1">
                  {#each pattern.sampleMessages as sample}
                    <div
                      class="font-mono text-xs bg-muted/30 p-2 rounded truncate"
                      title={sample}
                    >
                      {sample}
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Footer -->
  <div class="border-t px-4 py-2 text-xs text-muted-foreground bg-muted/10">
    Click a pattern to expand details, or use <Filter class="h-3 w-3 inline" /> to filter logs
  </div>
</div>
