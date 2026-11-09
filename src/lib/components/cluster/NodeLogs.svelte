<script lang="ts">
  import { ClusterApiError, getNodeLogs, type NodeLogsResponse } from '$lib/cloudApi';
  import { describeClusterError, LOG_LEVELS } from '$lib/cluster';
  import { formatDateTime, timezone } from '$lib/stores/timezone';

  export let orgId: string;
  export let instanceId: string;
  export let nodeId: string;
  export let tick: number;

  const SINCE = [15, 60, 360, 1440];
  let level = '';
  let since = 60;
  let search = '';
  let data: NodeLogsResponse | null = null;
  let error: ClusterApiError | null = null;
  let loading = false;
  let request = 0;

  async function load() {
    const mine = ++request;
    loading = true;
    try {
      const next = await getNodeLogs(orgId, instanceId, nodeId, { limit: 200, level: level || null, since });
      if (mine !== request) return;
      data = next;
      error = null;
    } catch (err) {
      if (mine !== request) return;
      error = err instanceof ClusterApiError ? err : new ClusterApiError('error', 'Could not load logs');
    } finally {
      if (mine === request) loading = false;
    }
  }

  $: tick, level, since, load();

  $: needle = search.trim().toLowerCase();
  $: shown = (data?.logs ?? []).filter(
    (l) => !needle || l.message.toLowerCase().includes(needle) || (l.component ?? '').toLowerCase().includes(needle),
  );

  const LEVEL_CLASS: Record<string, string> = {
    ERROR: 'text-red-600 dark:text-red-400',
    FATAL: 'text-red-600 dark:text-red-400',
    WARN: 'text-yellow-600 dark:text-yellow-400',
    INFO: 'text-blue-600 dark:text-blue-400',
    DEBUG: 'text-muted-foreground',
  };
</script>

<div class="mt-5">
  <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
    <div>
      <h4 class="text-sm font-semibold">Arc application logs</h4>
      <p class="text-xs text-muted-foreground">
        Source: node <span class="font-mono">{nodeId}</span>{data ? ` at ${data.source}` : ''} · the node's in-memory log buffer
      </p>
    </div>
    <div class="flex items-center gap-2 text-xs">
      <select bind:value={level} aria-label="Minimum level" class="h-8 rounded-md border border-input bg-background px-2">
        <option value="">All levels</option>
        {#each LOG_LEVELS as l}<option value={l}>{l.toUpperCase()}+</option>{/each}
      </select>
      <select bind:value={since} aria-label="Time range" class="h-8 rounded-md border border-input bg-background px-2">
        {#each SINCE as m}<option value={m}>Last {m < 60 ? `${m} min` : `${m / 60} h`}</option>{/each}
      </select>
      <input bind:value={search} placeholder="Filter" aria-label="Filter logs" class="h-8 w-36 rounded-md border border-input bg-background px-2" />
    </div>
  </div>

  {#if error}
    <p role="status" class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">Could not read logs: {describeClusterError(error.code)}.</p>
  {:else if !data && loading}
    <p class="py-4 text-center text-sm text-muted-foreground">Loading logs…</p>
  {:else if data && shown.length === 0}
    <p class="py-4 text-center text-sm text-muted-foreground">No log entries match.</p>
  {:else if data}
    <div class="max-h-80 overflow-auto rounded-md border font-mono text-xs">
      {#each shown as log, i (i)}
        <div class="flex gap-3 border-b px-3 py-1.5 last:border-b-0">
          <span class="shrink-0 text-muted-foreground">{formatDateTime(log.timestamp, $timezone)}</span>
          <span class="w-12 shrink-0 font-semibold {LEVEL_CLASS[log.level] ?? ''}">{log.level}</span>
          {#if log.component}<span class="shrink-0 text-muted-foreground">[{log.component}]</span>{/if}
          <span class="break-words">{log.message}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>
