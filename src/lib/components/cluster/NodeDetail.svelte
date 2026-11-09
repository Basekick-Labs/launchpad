<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ClusterApiError, getNodeSnapshot } from '$lib/cloudApi';
  import {
    dataAgeMs,
    describeClusterError,
    gaugeSeries,
    rateSeries,
    SERIES_DURATIONS,
    walDiskFree,
    windowLatencyMs,
    type ClusterNode,
    type NodeReachability,
    type NodeSnapshot,
    type NodeSnapshotData,
  } from '$lib/cluster';
  import { formatAge, formatBytes, formatCount, formatUptime } from '$lib/format';
  import MetricChart from '$lib/components/MetricChart.svelte';
  import NodeLogs from './NodeLogs.svelte';

  export let orgId: string;
  export let instanceId: string;
  export let node: ClusterNode;
  /** Bumped by the parent on each refresh. */
  export let tick: number;
  /** The parent's 1 s clock. */
  export let now: number;
  export let reachability: NodeReachability | null;

  let duration: number = 15;
  let data: NodeSnapshotData | null = null;
  let receivedAt = 0;
  /** The snapshot before `data`, for latency over the refresh window. */
  let previous: NodeSnapshot | null = null;
  let error: ClusterApiError | null = null;
  let loading = false;
  let controller: AbortController | null = null;

  async function load() {
    controller?.abort();
    const mine = (controller = new AbortController());
    loading = true;
    try {
      const next = await getNodeSnapshot(orgId, instanceId, node.id, duration, mine.signal);
      // The server caches the snapshot; the same one again is not a new window.
      if (!data || next.fetchedAt !== data.fetchedAt) previous = data?.snapshot ?? null;
      data = next;
      receivedAt = Date.now();
      error = null;
    } catch (err) {
      if (mine.signal.aborted) return;
      error = err instanceof ClusterApiError ? err : new ClusterApiError('error', 'Could not load the node');
    } finally {
      if (controller === mine) loading = false;
    }
  }

  onDestroy(() => controller?.abort());

  // Refetch on every parent refresh and when the window changes.
  $: tick, duration, load();

  $: s = data?.snapshot ?? {};
  $: httpLatency = data ? windowLatencyMs(previous, s, 'http_latency_sum_us', 'http_latency_count') : null;
  $: queryLatency = data ? windowLatencyMs(previous, s, 'query_latency_sum_us', 'query_latency_count') : null;
  $: walFree = walDiskFree(s);
  $: heap = gaugeSeries(data?.series.system ?? [], 'memory_heap_mb');
  $: goroutines = gaugeSeries(data?.series.system ?? [], 'goroutines');
  $: httpRate = rateSeries(data?.series.api ?? [], 'http_requests_total');
  $: ingestRate = rateSeries(data?.series.application ?? [], 'ingest_records_total');
  $: queryRate = rateSeries(data?.series.application ?? [], 'query_requests_total');

  function ms(v: number | null): string {
    return v === null ? '—' : `${v.toFixed(v < 10 ? 2 : 0)} ms`;
  }
</script>

<section class="rounded-lg border bg-card p-4" aria-labelledby="node-detail-{node.id}">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
    <div>
      <h3 id="node-detail-{node.id}" class="font-semibold">Node <span class="font-mono">{node.name}</span></h3>
      <p class="text-xs text-muted-foreground">
        Source: node <span class="font-mono">{data?.nodeId ?? node.id}</span>
        {#if data}at <span class="font-mono">{data.source}</span> · fetched {formatAge(dataAgeMs(data, receivedAt, now))}{/if}
      </p>
    </div>
    <label class="flex items-center gap-2 text-xs text-muted-foreground">
      Charts
      <select bind:value={duration} class="h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {#each SERIES_DURATIONS as d}<option value={d}>Last {d} min</option>{/each}
      </select>
    </label>
  </div>

  {#if error}
    <div role="status" class="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
      Could not read this node: {describeClusterError(error.code)}.
      {#if error.code === 'unreachable' || error.code === 'address_blocked'}
        Launchpad reads node metrics directly from each node, so the node's API address must be reachable from the Launchpad server.
      {/if}
      {#if data}Showing the last data read.{/if}
    </div>
  {:else if reachability && reachability.reachable === false && !data}
    <div role="status" class="mb-3 rounded-md border p-3 text-sm text-muted-foreground">{describeClusterError(reachability.error)}.</div>
  {/if}

  {#if !data && loading}
    <p class="py-6 text-center text-sm text-muted-foreground">Loading node metrics…</p>
  {:else if data}
    <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
      <div class="rounded-md border p-3">
        <div class="text-xs text-muted-foreground">Uptime · CPUs</div>
        <div class="mt-1 font-semibold">{formatUptime(s.uptime_seconds)} · {s.num_cpu ?? '—'}</div>
      </div>
      <div class="rounded-md border p-3">
        <div class="text-xs text-muted-foreground">Memory (heap / process)</div>
        <div class="mt-1 font-semibold">{formatBytes(s.memory_heap_alloc_bytes)} / {formatBytes(s.memory_sys_bytes)}</div>
      </div>
      <div class="rounded-md border p-3">
        <div class="text-xs text-muted-foreground">HTTP / query latency</div>
        <div class="mt-1 font-semibold">{ms(httpLatency)} / {ms(queryLatency)}</div>
        <div class="text-xs text-muted-foreground">since the previous refresh</div>
      </div>
      <div class="rounded-md border p-3">
        <div class="text-xs text-muted-foreground">Active queries · DB connections</div>
        <div class="mt-1 font-semibold">{formatCount(s.query_mgmt_active_queries)} · {formatCount(s.db_connections_in_use)}/{formatCount(s.db_connections_open)} of {formatCount(s.db_connections_max)}</div>
      </div>
      <div class="rounded-md border p-3">
        <div class="text-xs text-muted-foreground">Ingested records · errors</div>
        <div class="mt-1 font-semibold">{formatCount(s.ingest_records_total)} · {formatCount(s.ingest_errors_total)}</div>
      </div>
      <div class="rounded-md border p-3">
        <div class="text-xs text-muted-foreground">Compaction jobs · failed</div>
        <div class="mt-1 font-semibold">{formatCount(s.compaction_jobs_total)} · {formatCount(s.compaction_jobs_failed)}</div>
      </div>
      <div class="rounded-md border p-3">
        <div class="text-xs text-muted-foreground">WAL disk free</div>
        <div class="mt-1 font-semibold">{walFree === null ? 'Not reported' : formatBytes(walFree)}</div>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <MetricChart title="Heap memory" unit="MB" data={heap} />
      <MetricChart title="Goroutines" data={goroutines} color="#3B82F6" />
      <MetricChart title="HTTP requests/s" data={httpRate} color="#10B981" />
      <MetricChart title="Ingested records/s" data={ingestRate} color="#F59E0B" />
      <MetricChart title="Queries/s" data={queryRate} color="#EF4444" />
    </div>
    <p class="mt-2 text-xs text-muted-foreground">
      Arc keeps these in memory{data.spanMinutes ? `; this node currently holds about ${data.spanMinutes} min` : ''}.
      Arc does not report CPU % or disk usage. Launchpad's own requests count toward the node's HTTP totals.
    </p>
  {/if}

  <NodeLogs {orgId} {instanceId} nodeId={node.id} {tick} {now} />
</section>
