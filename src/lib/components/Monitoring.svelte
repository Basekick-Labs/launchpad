<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { ArcClient, TimeSeriesPoint, MetricsSnapshot, EndpointMetrics } from '$lib/arcClient';
  import MetricChart from './MetricChart.svelte';
  import LogsViewer from './LogsViewer.svelte';
  import { Button } from '$lib/components/ui/button';
  import { RefreshCw, Pause, Play, Activity } from 'lucide-svelte';

  export let client: ArcClient;

  let autoRefresh = true;
  let refreshInterval: ReturnType<typeof setInterval> | null = null;
  let durationMinutes = 30;
  let isLoading = true;
  let error: string | null = null;

  // Metrics data
  let systemMetrics: TimeSeriesPoint[] = [];
  let apiMetrics: TimeSeriesPoint[] = [];
  let appMetrics: TimeSeriesPoint[] = [];
  let currentMetrics: MetricsSnapshot | null = null;
  let endpointMetrics: EndpointMetrics | null = null;

  // Chart data in uPlot format [timestamps[], values[]]
  let memoryData: [number[], number[]] = [[], []];
  let goroutinesData: [number[], number[]] = [[], []];
  let httpRequestsData: [number[], number[]] = [[], []];
  let httpLatencyData: [number[], number[]] = [[], []];
  let storageWritesData: [number[], number[]] = [[], []];
  let storageReadsData: [number[], number[]] = [[], []];
  let gcCyclesData: [number[], number[]] = [[], []];

  const durationOptions = [
    { value: 5, label: '5 minutes' },
    { value: 15, label: '15 minutes' },
    { value: 30, label: '30 minutes' },
    { value: 60, label: '1 hour' },
    { value: 360, label: '6 hours' },
    { value: 1440, label: '24 hours' },
  ];

  async function fetchMetrics() {
    try {
      isLoading = true;
      error = null;

      const [systemRes, apiRes, appRes, currentRes, endpointRes] = await Promise.all([
        client.getTimeSeriesMetrics('system', durationMinutes),
        client.getTimeSeriesMetrics('api', durationMinutes),
        client.getTimeSeriesMetrics('application', durationMinutes),
        client.getMetrics(),
        client.getEndpointMetrics(),
      ]);

      systemMetrics = systemRes.data;
      apiMetrics = apiRes.data;
      appMetrics = appRes.data;
      currentMetrics = currentRes;
      endpointMetrics = endpointRes;

      // Transform data for charts
      transformChartData();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to fetch metrics';
    } finally {
      isLoading = false;
    }
  }

  function transformChartData() {
    if (systemMetrics.length === 0) return;

    // Memory usage (MB)
    memoryData = [
      systemMetrics.map(p => new Date(p.timestamp).getTime() / 1000),
      systemMetrics.map(p => p.values.memory_heap_mb || 0),
    ];

    // Goroutines
    goroutinesData = [
      systemMetrics.map(p => new Date(p.timestamp).getTime() / 1000),
      systemMetrics.map(p => p.values.goroutines || 0),
    ];

    // GC Cycles
    gcCyclesData = [
      systemMetrics.map(p => new Date(p.timestamp).getTime() / 1000),
      systemMetrics.map(p => p.values.gc_cycles || 0),
    ];

    // HTTP Requests and Latency (from API metrics)
    if (apiMetrics.length > 0) {
      httpRequestsData = [
        apiMetrics.map(p => new Date(p.timestamp).getTime() / 1000),
        apiMetrics.map(p => p.values.http_requests_total || 0),
      ];

      httpLatencyData = [
        apiMetrics.map(p => new Date(p.timestamp).getTime() / 1000),
        apiMetrics.map(p => (p.values.http_latency_avg_us || 0) / 1000), // Convert to ms
      ];
    }

    // Storage I/O (from application metrics)
    if (appMetrics.length > 0) {
      storageWritesData = [
        appMetrics.map(p => new Date(p.timestamp).getTime() / 1000),
        appMetrics.map(p => p.values.storage_writes_total || 0),
      ];

      storageReadsData = [
        appMetrics.map(p => new Date(p.timestamp).getTime() / 1000),
        appMetrics.map(p => p.values.storage_reads_total || 0),
      ];
    }
  }

  function toggleAutoRefresh() {
    autoRefresh = !autoRefresh;
    setupRefreshInterval();
  }

  function setupRefreshInterval() {
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }

    if (autoRefresh) {
      refreshInterval = setInterval(fetchMetrics, 5000); // Refresh every 5 seconds
    }
  }

  function handleDurationChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    durationMinutes = Number(target.value);
    fetchMetrics();
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  onMount(() => {
    fetchMetrics();
    setupRefreshInterval();
  });

  onDestroy(() => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
  });
</script>

<div class="flex h-full flex-col overflow-hidden">
  <!-- Header -->
  <header class="flex items-center justify-between border-b bg-card px-6 py-4">
    <div class="flex items-center gap-3">
      <Activity class="h-5 w-5 text-primary" />
      <h1 class="text-xl font-semibold">Service Health</h1>
    </div>

    <div class="flex items-center gap-3">
      <select
        class="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        value={durationMinutes}
        on:change={handleDurationChange}
      >
        {#each durationOptions as option}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>

      <Button variant="outline" size="sm" on:click={toggleAutoRefresh}>
        {#if autoRefresh}
          <Pause class="mr-2 h-4 w-4" />
          Auto-refresh ON
        {:else}
          <Play class="mr-2 h-4 w-4" />
          Auto-refresh OFF
        {/if}
      </Button>

      <Button variant="outline" size="icon" on:click={fetchMetrics} disabled={isLoading}>
        <RefreshCw class={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
      </Button>
    </div>
  </header>

  <!-- Content -->
  <div class="flex-1 overflow-auto p-6">
    {#if error}
      <div class="mb-6 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive">
        {error}
      </div>
    {/if}

    <!-- Stats Cards -->
    {#if currentMetrics}
      {@const httpLatencyAvgMs = currentMetrics.http_latency_count > 0
        ? (currentMetrics.http_latency_sum_us / currentMetrics.http_latency_count / 1000)
        : 0}
      {@const successRate = currentMetrics.http_requests_total > 0
        ? ((currentMetrics.http_requests_success / currentMetrics.http_requests_total) * 100)
        : 100}
      <div class="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <div class="rounded-lg border bg-card p-4">
          <div class="text-xs text-muted-foreground">Uptime</div>
          <div class="mt-1 text-2xl font-semibold">{formatUptime(currentMetrics.uptime_seconds)}</div>
        </div>
        <div class="rounded-lg border bg-card p-4" title="Go heap memory allocation (excludes DuckDB)">
          <div class="text-xs text-muted-foreground">Go Heap</div>
          <div class="mt-1 text-2xl font-semibold">{formatBytes(currentMetrics.memory_heap_alloc_bytes)}</div>
          <div class="mt-1 text-xs text-muted-foreground">Sys: {formatBytes(currentMetrics.memory_sys_bytes)}</div>
        </div>
        <div class="rounded-lg border bg-card p-4">
          <div class="text-xs text-muted-foreground">Goroutines</div>
          <div class="mt-1 text-2xl font-semibold">{currentMetrics.goroutines.toLocaleString()}</div>
        </div>
        <div class="rounded-lg border bg-card p-4">
          <div class="text-xs text-muted-foreground">HTTP Requests</div>
          <div class="mt-1 text-2xl font-semibold">{(currentMetrics.http_requests_total || 0).toLocaleString()}</div>
          <div class="mt-1 text-xs text-muted-foreground">
            <span class="text-green-500">{(currentMetrics.http_requests_success || 0).toLocaleString()}</span>
            {' / '}
            <span class="text-red-500">{(currentMetrics.http_requests_error || 0).toLocaleString()}</span>
          </div>
        </div>
        <div class="rounded-lg border bg-card p-4">
          <div class="text-xs text-muted-foreground">Avg Latency</div>
          <div class="mt-1 text-2xl font-semibold">{httpLatencyAvgMs.toFixed(1)} ms</div>
          <div class="mt-1 text-xs text-muted-foreground">{successRate.toFixed(1)}% success</div>
        </div>
        <div class="rounded-lg border bg-card p-4">
          <div class="text-xs text-muted-foreground">GC Cycles</div>
          <div class="mt-1 text-2xl font-semibold">{(currentMetrics.gc_cycles || 0).toLocaleString()}</div>
          <div class="mt-1 text-xs text-muted-foreground">CPUs: {currentMetrics.num_cpu}</div>
        </div>
      </div>
    {/if}

    <!-- Charts Grid -->
    <div class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      <MetricChart
        title="Memory (Heap)"
        data={memoryData}
        unit="MB"
        color="#A855F7"
      />
      <MetricChart
        title="Goroutines"
        data={goroutinesData}
        unit=""
        color="#22D3EE"
      />
      <MetricChart
        title="GC Cycles"
        data={gcCyclesData}
        unit=""
        color="#F59E0B"
      />
      <MetricChart
        title="HTTP Requests"
        data={httpRequestsData}
        unit=""
        color="#10B981"
      />
      <MetricChart
        title="HTTP Latency"
        data={httpLatencyData}
        unit="ms"
        color="#EF4444"
      />
      <MetricChart
        title="Storage Writes"
        data={storageWritesData}
        unit=""
        color="#3B82F6"
      />
    </div>

    <!-- Endpoint Statistics -->
    {#if endpointMetrics}
      <div class="mb-6">
        <h2 class="mb-4 text-lg font-semibold">Endpoint Statistics</h2>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <div class="rounded-lg border bg-card p-4">
            <h3 class="mb-3 text-sm font-medium text-muted-foreground">HTTP</h3>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between">
                <span class="text-muted-foreground">Total</span>
                <span>{endpointMetrics.http.requests_total.toLocaleString()}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted-foreground">Success</span>
                <span class="text-green-500">{endpointMetrics.http.requests_success.toLocaleString()}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted-foreground">Errors</span>
                <span class="text-red-500">{endpointMetrics.http.requests_error.toLocaleString()}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted-foreground">Avg Latency</span>
                <span>{endpointMetrics.http.latency_avg_ms.toFixed(2)} ms</span>
              </div>
            </div>
          </div>

          <div class="rounded-lg border bg-card p-4">
            <h3 class="mb-3 text-sm font-medium text-muted-foreground">Query</h3>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between">
                <span class="text-muted-foreground">Total</span>
                <span>{endpointMetrics.query.requests_total.toLocaleString()}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted-foreground">Success</span>
                <span class="text-green-500">{endpointMetrics.query.success_total.toLocaleString()}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted-foreground">Errors</span>
                <span class="text-red-500">{endpointMetrics.query.errors_total.toLocaleString()}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted-foreground">Rows Returned</span>
                <span>{endpointMetrics.query.rows_total.toLocaleString()}</span>
              </div>
            </div>
          </div>

          <div class="rounded-lg border bg-card p-4">
            <h3 class="mb-3 text-sm font-medium text-muted-foreground">Ingestion</h3>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between">
                <span class="text-muted-foreground">Records</span>
                <span>{endpointMetrics.ingestion.records_total.toLocaleString()}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted-foreground">Bytes</span>
                <span>{formatBytes(endpointMetrics.ingestion.bytes_total)}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted-foreground">Batches</span>
                <span>{endpointMetrics.ingestion.batches_total.toLocaleString()}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted-foreground">Errors</span>
                <span class="text-red-500">{endpointMetrics.ingestion.errors_total.toLocaleString()}</span>
              </div>
            </div>
          </div>

          <div class="rounded-lg border bg-card p-4">
            <h3 class="mb-3 text-sm font-medium text-muted-foreground">Storage</h3>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between">
                <span class="text-muted-foreground">Writes</span>
                <span>{endpointMetrics.storage.writes_total.toLocaleString()}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted-foreground">Bytes Written</span>
                <span>{formatBytes(endpointMetrics.storage.write_bytes_total)}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted-foreground">Reads</span>
                <span>{endpointMetrics.storage.reads_total.toLocaleString()}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted-foreground">Errors</span>
                <span class="text-red-500">{endpointMetrics.storage.errors_total.toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- Logs Section -->
    <div>
      <h2 class="mb-4 text-lg font-semibold">Application Logs</h2>
      <LogsViewer {client} />
    </div>
  </div>
</div>
