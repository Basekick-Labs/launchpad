<script lang="ts">
  import { cn } from '$lib/utils';
  import { Clock, Server } from 'lucide-svelte';
  import type { TraceData, SpanData } from '$lib/traceExtractor';
  import { flattenSpanTree, formatDuration } from '$lib/traceExtractor';

  export let trace: TraceData;

  // Flatten the span tree for rendering
  $: flatSpans = flattenSpanTree(trace.rootSpans);

  // Calculate timeline scale
  $: traceStart = trace.startTime.getTime();
  $: traceDuration = trace.totalDuration || 1; // Avoid division by zero

  function getSpanOffset(span: SpanData): number {
    const offset = span.timestamp.getTime() - traceStart;
    return (offset / traceDuration) * 100;
  }

  function getSpanWidth(span: SpanData): number {
    const duration = span.duration || 1;
    return Math.max(1, (duration / traceDuration) * 100); // Minimum 1% width for visibility
  }

  function getSpanColor(span: SpanData): string {
    const level = span.level.toUpperCase();
    switch (level) {
      case 'ERROR':
      case 'FATAL':
      case 'CRITICAL':
        return 'bg-red-500';
      case 'WARN':
      case 'WARNING':
        return 'bg-yellow-500';
      case 'DEBUG':
      case 'TRACE':
        return 'bg-neutral-400';
      default:
        return 'bg-blue-500';
    }
  }

  function formatTimestamp(date: Date): string {
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hour12: false,
    });
  }
</script>

<div class="py-3 px-4">
  <!-- Trace Summary -->
  <div class="flex items-center gap-4 mb-4 text-xs">
    <div class="flex items-center gap-1 text-muted-foreground">
      <Clock class="h-3 w-3" />
      <span>Duration: <span class="font-mono font-semibold text-foreground">{formatDuration(trace.totalDuration)}</span></span>
    </div>
    <div class="flex items-center gap-1 text-muted-foreground">
      <span>Spans: <span class="font-mono font-semibold text-foreground">{trace.spans.length}</span></span>
    </div>
    {#if trace.services.length > 0}
      <div class="flex items-center gap-1 text-muted-foreground">
        <Server class="h-3 w-3" />
        <span>Services: {trace.services.join(', ')}</span>
      </div>
    {/if}
  </div>

  <!-- Timeline Header -->
  <div class="flex items-center mb-2 text-xs text-muted-foreground">
    <div class="w-[250px] shrink-0">Span</div>
    <div class="flex-1 flex justify-between px-2">
      <span>{formatTimestamp(trace.startTime)}</span>
      <span>{formatTimestamp(trace.endTime)}</span>
    </div>
    <div class="w-[80px] text-right">Duration</div>
  </div>

  <!-- Span Rows -->
  <div class="space-y-1">
    {#each flatSpans as { span, depth }}
      {@const offset = getSpanOffset(span)}
      {@const width = getSpanWidth(span)}
      {@const color = getSpanColor(span)}

      <div class="group flex items-center hover:bg-muted/30 rounded py-1.5">
        <!-- Span Name with Indentation -->
        <div
          class="w-[250px] shrink-0 flex items-center gap-1 truncate"
          style="padding-left: {depth * 16}px;"
        >
          {#if span.service}
            <span class="px-1 py-0.5 rounded bg-muted text-[10px] text-muted-foreground shrink-0">
              {span.service}
            </span>
          {/if}
          <span
            class="font-mono text-xs truncate"
            title={span.operation || span.spanId}
          >
            {span.operation || span.spanId}
          </span>
        </div>

        <!-- Timeline Bar -->
        <div class="flex-1 relative h-5 bg-muted/30 rounded mx-2">
          <div
            class={cn("absolute top-0.5 bottom-0.5 rounded", color)}
            style="left: {offset}%; width: {width}%;"
            title="{span.operation || span.spanId}: {formatDuration(span.duration)}"
          ></div>
        </div>

        <!-- Duration -->
        <div class="w-[80px] text-right font-mono text-xs text-muted-foreground">
          {formatDuration(span.duration)}
        </div>
      </div>
    {/each}
  </div>

  <!-- Legend -->
  <div class="flex items-center gap-4 mt-4 pt-3 border-t text-xs text-muted-foreground">
    <div class="flex items-center gap-1">
      <span class="w-3 h-3 rounded bg-blue-500"></span>
      <span>Info</span>
    </div>
    <div class="flex items-center gap-1">
      <span class="w-3 h-3 rounded bg-yellow-500"></span>
      <span>Warning</span>
    </div>
    <div class="flex items-center gap-1">
      <span class="w-3 h-3 rounded bg-red-500"></span>
      <span>Error</span>
    </div>
    <div class="flex items-center gap-1">
      <span class="w-3 h-3 rounded bg-neutral-400"></span>
      <span>Debug</span>
    </div>
  </div>
</div>
