<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';
  import type { ArcClient } from '$lib/arcClient';
  import type { LogFieldMapping } from '$lib/logFieldDetector';
  import { RefreshCw, X } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';

  export let client: ArcClient;
  export let database: string;
  export let table: string;
  export let fieldMapping: LogFieldMapping;
  export let relativeMinutes: number = 60;
  export let height: number = 120;
  // Optional: pre-fetched logs for client-side only mode (used in custom query mode)
  export let logs: Record<string, unknown>[] | null = null;
  // When true, uses logs prop instead of fetching from database
  export let clientSideMode: boolean = false;

  const dispatch = createEventDispatcher<{
    timeRangeSelect: { start: Date; end: Date } | null;
  }>();

  // Selection state
  let selectedTimeRange: { start: Date; end: Date } | null = null;

  interface BucketData {
    timestamp: number;
    total: number;
    error: number;
    warn: number;
    info: number;
    debug: number;
  }

  let chartContainer: HTMLDivElement;
  let chart: uPlot | null = null;
  let isLoading = false;
  let error: string | null = null;
  let buckets: BucketData[] = [];

  const isDark = () => document.documentElement.classList.contains('dark');

  function getThemeColors() {
    const dark = isDark();
    return {
      background: dark ? '#1a1a1a' : '#ffffff',
      axes: dark ? '#525252' : '#d4d4d4',
      grid: dark ? '#262626' : '#f5f5f5',
      text: dark ? '#a3a3a3' : '#525252',
    };
  }

  // Level colors matching Datadog style
  const levelColors = {
    error: '#ef4444', // red
    warn: '#f59e0b',  // amber
    info: '#3b82f6',  // blue
    debug: '#6b7280', // gray
  };

  async function fetchHistogramData() {
    if (!fieldMapping.timestamp) return;

    try {
      isLoading = true;
      error = null;

      // Calculate bucket size based on time range - aim for ~50-80 bars
      const bucketMinutes = Math.max(1, Math.floor(relativeMinutes / 60));
      const bucketSeconds = bucketMinutes * 60;

      // Fetch raw data and bucket client-side for maximum compatibility
      // This approach works with any SQL database
      let query: string;

      if (fieldMapping.level) {
        query = `
          SELECT ${fieldMapping.timestamp}, ${fieldMapping.level}
          FROM ${table}
          WHERE ${fieldMapping.timestamp} >= NOW() - INTERVAL '${relativeMinutes} minutes'
          ORDER BY ${fieldMapping.timestamp} ASC
          LIMIT 10000
        `;
      } else {
        query = `
          SELECT ${fieldMapping.timestamp}
          FROM ${table}
          WHERE ${fieldMapping.timestamp} >= NOW() - INTERVAL '${relativeMinutes} minutes'
          ORDER BY ${fieldMapping.timestamp} ASC
          LIMIT 10000
        `;
      }

      let result;
      try {
        result = await client.query(query, database);
      } catch {
        // Fallback to database.table syntax
        const fallbackQuery = fieldMapping.level
          ? `SELECT ${fieldMapping.timestamp}, ${fieldMapping.level} FROM ${database}.${table} WHERE ${fieldMapping.timestamp} >= NOW() - INTERVAL '${relativeMinutes} minutes' ORDER BY ${fieldMapping.timestamp} ASC LIMIT 10000`
          : `SELECT ${fieldMapping.timestamp} FROM ${database}.${table} WHERE ${fieldMapping.timestamp} >= NOW() - INTERVAL '${relativeMinutes} minutes' ORDER BY ${fieldMapping.timestamp} ASC LIMIT 10000`;
        result = await client.query(fallbackQuery);
      }

      if (result.rows && result.rows.length > 0) {
        buckets = bucketDataClientSide(result.rows, bucketSeconds, !!fieldMapping.level);
        updateChart();
      } else {
        buckets = [];
        if (chart) {
          chart.setData([[], [], [], [], []]);
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load histogram';
      buckets = [];
    } finally {
      isLoading = false;
    }
  }

  // Build histogram from pre-fetched logs (client-side mode)
  function buildHistogramFromLogs() {
    if (!logs || logs.length === 0 || !fieldMapping.timestamp) {
      buckets = [];
      if (chart) {
        chart.setData([[], [], [], [], []]);
      }
      return;
    }

    isLoading = true;

    try {
      // Find time range from logs to calculate bucket size
      const timestamps = logs
        .map(log => {
          const val = log[fieldMapping.timestamp!];
          return val ? new Date(val as string).getTime() : null;
        })
        .filter((t): t is number => t !== null && !isNaN(t));

      if (timestamps.length === 0) {
        buckets = [];
        return;
      }

      const minTime = Math.min(...timestamps);
      const maxTime = Math.max(...timestamps);
      const rangeMinutes = Math.max(1, (maxTime - minTime) / (60 * 1000));

      // Calculate bucket size - aim for ~50-80 bars
      const bucketMinutes = Math.max(1, Math.floor(rangeMinutes / 60));
      const bucketSeconds = bucketMinutes * 60;

      // Convert logs to row format for bucketing
      const hasLevel = !!fieldMapping.level;
      const rows: any[][] = logs.map(log => {
        const row: any[] = [log[fieldMapping.timestamp!]];
        if (hasLevel && fieldMapping.level) {
          row.push(log[fieldMapping.level]);
        }
        return row;
      });

      buckets = bucketDataClientSide(rows, bucketSeconds, hasLevel);
      updateChart();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to build histogram';
      buckets = [];
    } finally {
      isLoading = false;
    }
  }

  function bucketDataClientSide(rows: any[][], bucketSeconds: number, hasLevel: boolean): BucketData[] {
    if (rows.length === 0) return [];

    const bucketMap = new Map<number, BucketData>();

    for (const row of rows) {
      const ts = new Date(row[0] as string).getTime() / 1000;
      const bucketTs = Math.floor(ts / bucketSeconds) * bucketSeconds;

      if (!bucketMap.has(bucketTs)) {
        bucketMap.set(bucketTs, {
          timestamp: bucketTs,
          total: 0,
          error: 0,
          warn: 0,
          info: 0,
          debug: 0,
        });
      }

      const bucket = bucketMap.get(bucketTs)!;
      bucket.total++;

      if (hasLevel && row[1]) {
        const level = String(row[1]).toUpperCase();
        if (['ERROR', 'ERR', 'FATAL', 'CRITICAL'].includes(level)) {
          bucket.error++;
        } else if (['WARN', 'WARNING'].includes(level)) {
          bucket.warn++;
        } else if (['INFO', 'INFORMATION'].includes(level)) {
          bucket.info++;
        } else if (['DEBUG', 'TRACE'].includes(level)) {
          bucket.debug++;
        }
      }
    }

    return Array.from(bucketMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  function createChart() {
    if (!chartContainer) return;

    const colors = getThemeColors();
    const width = chartContainer.clientWidth;

    // Prepare data for stacked bars: [timestamps, error, warn, info, debug]
    const timestamps = buckets.map(b => b.timestamp);
    const errorData = buckets.map(b => b.error);
    const warnData = buckets.map(b => b.warn);
    const infoData = buckets.map(b => b.info);
    const debugData = buckets.map(b => b.debug);

    const data: uPlot.AlignedData = [
      timestamps,
      errorData,
      warnData,
      infoData,
      debugData,
    ];

    // Calculate bar width based on number of buckets
    const barWidth = Math.max(2, Math.min(20, (width - 60) / Math.max(1, buckets.length) - 1));

    const opts: uPlot.Options = {
      width,
      height,
      padding: [10, 10, 0, 0],
      cursor: {
        show: true,
        points: { show: false },
        drag: {
          x: true,  // Enable horizontal drag selection
          y: false, // Disable vertical drag
          setScale: false, // Don't zoom, we'll handle selection manually
        },
      },
      legend: { show: false },
      scales: {
        x: { time: true },
        y: { auto: true, range: (u, min, max) => [0, max * 1.1] },
      },
      hooks: {
        setSelect: [
          (u) => {
            const { left, width: selWidth } = u.select;
            if (selWidth > 0) {
              // Convert pixel coordinates to timestamps
              const startTs = u.posToVal(left, 'x');
              const endTs = u.posToVal(left + selWidth, 'x');

              selectedTimeRange = {
                start: new Date(startTs * 1000),
                end: new Date(endTs * 1000),
              };

              dispatch('timeRangeSelect', selectedTimeRange);

              // Clear the selection rectangle
              u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
            }
          },
        ],
      },
      axes: [
        {
          show: true,
          stroke: colors.text,
          grid: { show: false },
          ticks: { show: true, stroke: colors.axes, width: 1, size: 4 },
          font: '10px Inter, system-ui, sans-serif',
          // Increase space between labels for longer time ranges to prevent overlap
          space: relativeMinutes <= 60 ? 50 : relativeMinutes <= 180 ? 60 : 80,
          values: (u, vals) => vals.map(v => {
            const d = new Date(v * 1000);

            if (relativeMinutes <= 60) {
              // Up to 1 hour: just time (HH:MM)
              return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            } else if (relativeMinutes <= 1440) {
              // Up to 24 hours: just time (HH:MM)
              return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            } else {
              // More than 24 hours: show date only (Jan 24)
              return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
            }
          }),
        },
        {
          show: true,
          stroke: colors.text,
          grid: { show: true, stroke: colors.grid, width: 1 },
          ticks: { show: true, stroke: colors.axes, width: 1, size: 4 },
          font: '10px Inter, system-ui, sans-serif',
          size: 40,
          values: (u, vals) => vals.map(v => formatCount(v)),
        },
      ],
      series: [
        {},
        // Error - bottom of stack (red)
        {
          label: 'Error',
          stroke: levelColors.error,
          fill: levelColors.error,
          paths: bars({ size: [0.8, barWidth] }),
          points: { show: false },
        },
        // Warn - stacked on error (amber)
        {
          label: 'Warn',
          stroke: levelColors.warn,
          fill: levelColors.warn,
          paths: bars({ size: [0.8, barWidth] }),
          points: { show: false },
        },
        // Info - stacked on warn (blue)
        {
          label: 'Info',
          stroke: levelColors.info,
          fill: levelColors.info,
          paths: bars({ size: [0.8, barWidth] }),
          points: { show: false },
        },
        // Debug - top of stack (gray)
        {
          label: 'Debug',
          stroke: levelColors.debug,
          fill: levelColors.debug,
          paths: bars({ size: [0.8, barWidth] }),
          points: { show: false },
        },
      ],
    };

    if (chart) {
      chart.destroy();
    }

    chart = new uPlot(opts, data, chartContainer);
  }

  // Simple bar renderer for uPlot
  function bars(opts: { size: [number, number] }): uPlot.Series.PathBuilder {
    const [_pct, maxWidth] = opts.size;

    return (u: uPlot, seriesIdx: number, idx0: number, idx1: number) => {
      const s = u.series[seriesIdx];
      const xdata = u.data[0];
      const ydata = u.data[seriesIdx];

      const fill = new Path2D();
      const stroke = new Path2D();

      // Calculate cumulative values for stacking
      const cumulative = new Array(xdata.length).fill(0);
      for (let si = 1; si < seriesIdx; si++) {
        const prevData = u.data[si];
        for (let i = 0; i < prevData.length; i++) {
          cumulative[i] += prevData[i] || 0;
        }
      }

      const barWidth = Math.min(maxWidth, (u.bbox.width / xdata.length) * 0.8);

      for (let i = idx0; i <= idx1; i++) {
        const x = u.valToPos(xdata[i], 'x', true);
        const y0 = u.valToPos(cumulative[i], 'y', true);
        const y1 = u.valToPos(cumulative[i] + (ydata[i] || 0), 'y', true);

        const left = x - barWidth / 2;
        const barHeight = y0 - y1;

        if (barHeight > 0) {
          fill.rect(left, y1, barWidth, barHeight);
          stroke.rect(left, y1, barWidth, barHeight);
        }
      }

      return { fill, stroke };
    };
  }

  function formatCount(value: number): string {
    if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
    if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
    return Math.round(value).toString();
  }

  function updateChart() {
    if (!chartContainer) return;

    if (!chart) {
      createChart();
    } else {
      const timestamps = buckets.map(b => b.timestamp);
      const errorData = buckets.map(b => b.error);
      const warnData = buckets.map(b => b.warn);
      const infoData = buckets.map(b => b.info);
      const debugData = buckets.map(b => b.debug);

      chart.setData([timestamps, errorData, warnData, infoData, debugData]);
    }
  }

  function handleResize() {
    if (chart && chartContainer) {
      chart.setSize({ width: chartContainer.clientWidth, height });
    }
  }

  function clearTimeSelection() {
    selectedTimeRange = null;
    dispatch('timeRangeSelect', null);
  }

  function formatTimeRange(range: { start: Date; end: Date }): string {
    const formatTime = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const formatDate = (d: Date) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });

    const sameDay = range.start.toDateString() === range.end.toDateString();

    if (sameDay) {
      return `${formatDate(range.start)} ${formatTime(range.start)} - ${formatTime(range.end)}`;
    } else {
      return `${formatDate(range.start)} ${formatTime(range.start)} - ${formatDate(range.end)} ${formatTime(range.end)}`;
    }
  }

  // Reactive updates - either fetch from DB or build from logs
  $: if (clientSideMode && logs && fieldMapping.timestamp) {
    buildHistogramFromLogs();
  } else if (!clientSideMode && database && table && fieldMapping.timestamp && relativeMinutes) {
    fetchHistogramData();
  }

  onMount(() => {
    window.addEventListener('resize', handleResize);

    // Watch for theme changes
    const observer = new MutationObserver(() => {
      createChart();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => {
      observer.disconnect();
    };
  });

  onDestroy(() => {
    window.removeEventListener('resize', handleResize);
    if (chart) {
      chart.destroy();
    }
  });
</script>

<div class="relative border-b bg-muted/10 px-4 py-3">
  {#if isLoading}
    <div class="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
      <RefreshCw class="h-4 w-4 animate-spin text-muted-foreground" />
    </div>
  {/if}

  {#if error}
    <div class="h-[{height}px] flex items-center justify-center text-sm text-muted-foreground">
      {error}
    </div>
  {:else}
    <div bind:this={chartContainer} class="w-full" style="height: {height}px;"></div>
  {/if}

  <!-- Legend and Selection Info -->
  <div class="flex items-center justify-between mt-1 text-xs ml-9">
    <!-- Selection indicator (ml-9 = 36px to align with chart area after y-axis) -->
    <div class="flex items-center gap-2">
      {#if selectedTimeRange}
        <div class="flex items-center gap-2 px-2 py-1 rounded bg-primary/10 text-primary">
          <span class="font-medium">Selected:</span>
          <span>{formatTimeRange(selectedTimeRange)}</span>
          <button
            on:click={clearTimeSelection}
            class="p-0.5 rounded hover:bg-primary/20"
            title="Clear selection"
          >
            <X class="h-3 w-3" />
          </button>
        </div>
      {:else}
        <span class="text-muted-foreground">Drag to select time range</span>
      {/if}
    </div>

    <!-- Legend -->
    <div class="flex items-center gap-4">
      <div class="flex items-center gap-1">
        <span class="w-3 h-3 rounded" style="background-color: {levelColors.error}"></span>
        <span class="text-muted-foreground">Error</span>
      </div>
      <div class="flex items-center gap-1">
        <span class="w-3 h-3 rounded" style="background-color: {levelColors.warn}"></span>
        <span class="text-muted-foreground">Warn</span>
      </div>
      <div class="flex items-center gap-1">
        <span class="w-3 h-3 rounded" style="background-color: {levelColors.info}"></span>
        <span class="text-muted-foreground">Info</span>
      </div>
      <div class="flex items-center gap-1">
        <span class="w-3 h-3 rounded" style="background-color: {levelColors.debug}"></span>
        <span class="text-muted-foreground">Debug</span>
      </div>
    </div>
  </div>
</div>

<style>
  :global(.u-wrap) {
    background: transparent !important;
  }
</style>
