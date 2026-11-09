<script lang="ts">
  import { ClusterApiError, getNodeSnapshot, type NodeSnapshotResponse } from '$lib/cloudApi';
  import {
    describeClusterError,
    gaugeSeries,
    rateSeries,
    walDiskFree,
    windowLatencyMs,
    type ClusterNode,
    type NodeSnapshot,
  } from '$lib/cluster';
  import { formatAge, formatBytes, formatCount, formatUptime } from '$lib/format';
  import MetricChart from '$lib/components/MetricChart.svelte';
  import NodeLogs from './NodeLogs.svelte';

  export let orgId: string;
  export let instanceId: string;
  export let node: ClusterNode;
  /** Bumped by the parent on each refresh. */
  export let tick: number;
  export let reachability: { reachable: boolean; error: string | null } | null;

  const DURATIONS = [5, 15, 30, 60];
  let duration = 15;
  let data: NodeSnapshotResponse | null = null;
  /** The snapshot before `data`, for latency over the refresh window. */
  let previous: NodeSnapshot | null = null;
  let error: ClusterApiError | null = null;
  let loading = false;
  let request = 0;

  async function load() {
    const mine = ++request;
    loading = true;
    try {
      const next = await getNodeSnapshot(orgId, instanceId, node.id, duration);
      if (mine !== request) return;
      // The server caches for 5 s; an identical fetch is not a new window.
      if (!data || next.fetchedAt !== data.fetchedAt) previous = data?.snapshot ?? null;
      data = next;
      error = null;
    } catch (err) {
      if (mine !== request) return;
      error = err instanceof ClusterApiError ? err : new ClusterApiError('error', 'Could not load the node');
    } finally {
      if (mine === request) loading = false;
    }
  }

  // Refetch on every parent refresh and when the duration changes.
  $: tick, duration, load();

  $: s = data?.snapshot ?? {};
  $: httpLatency = data ? windowLatencyMs(previous, s, 'http_latency_sum_us', 'http_latency_count') : null;
  $: queryLatency = data ? windowLatencyMs(previous, s, 'query_latency_sum_us', 'query_latency_count') : null;
  $: walFree = walDiskFree(s);
  $: sys = data?.series.system ?? [];
  $: api = data?.series.api ?? [];
  $: app = data?.series.application ?? [];

  function ms(v: number | null): string {
    return v === null ? '—' : `${v.toFixed(v < 10 ? 2 : 0)} ms`;
  }
</script>

<section class="rounded-lg border bg-card p-4" aria-label="Node {node.id}">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
    <div>
      <h3 class="font-semibold">Node <span class="font-mono">{node.name}</span></h3>
      <p class="text-xs text-muted-foreground">
        {#if data}
          Source: node <span class="font-mono">{data.nodeId}</span> at <span class="font-mono">{data.source}</span> · fetched {formatAge(Date.now() - data.fetchedAt)}
        {:else}
          Source: node <span class="font-mono">{node.id}</span>
        {/if}
      </p>
    </div>
    <label class="flex items-center gap-2 text-xs text-muted-foreground">
      Charts
      <select bind:value={duration} class="h-8 rounded-md border border-input bg-background px-2 text-xs">
        {#each DURATIONS as d}<option value={d}>Last {d} min</option>{/each}
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
  {:else if reachability && !reachability.reachable && !data}
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
      <div class="rounded-md border p-3">
        <div class="text-xs text-muted-foreground">CPU % · disk usage</div>
        <div class="mt-1 text-sm text-muted-foreground">Not reported by Arc</div>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <MetricChart title="Heap memory" unit="MB" data={gaugeSeries(sys, 'memory_heap_mb')} />
      <MetricChart title="Goroutines" data={gaugeSeries(sys, 'goroutines')} color="#3B82F6" />
      <MetricChart title="HTTP requests/s" data={rateSeries(api, 'http_requests_total')} color="#10B981" />
      <MetricChart title="Ingested records/s" data={rateSeries(app, 'ingest_records_total')} color="#F59E0B" />
      <MetricChart title="Queries/s" data={rateSeries(app, 'query_requests_total')} color="#EF4444" />
    </div>
    <p class="mt-2 text-xs text-muted-foreground">
      Arc keeps these in memory{data.spanMinutes ? `; this node currently holds about ${data.spanMinutes} min` : ''}. Launchpad's own requests count toward the node's HTTP totals.
    </p>
  {/if}

  <NodeLogs {orgId} {instanceId} nodeId={node.id} {tick} />
</section>
