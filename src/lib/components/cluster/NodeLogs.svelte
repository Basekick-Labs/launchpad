<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ClusterApiError, getNodeLogs } from '$lib/cloudApi';
  import { dataAgeMs, describeClusterError, LOG_LEVELS, LOG_SINCE_OPTIONS, type NodeLogsData } from '$lib/cluster';
  import { formatAge } from '$lib/format';
  import { formatDateTime, timezone } from '$lib/stores/timezone';
  import { Button } from '$lib/components/ui/button';
  import { RefreshCw } from 'lucide-svelte';

  export let orgId: string;
  export let instanceId: string;
  export let nodeId: string;
  export let tick: number;
  export let now: number;

  let level = '';
  let since: number = 60;
  let search = '';
  /** Refetch with every cluster refresh; off by default (each read carries the admin token). */
  let follow = false;
  let data: NodeLogsData | null = null;
  let receivedAt = 0;
  let rows: Array<NodeLogsData['logs'][number] & { haystack: string }> = [];
  let error: ClusterApiError | null = null;
  let loading = false;
  let controller: AbortController | null = null;

  async function load() {
    controller?.abort();
    const mine = (controller = new AbortController());
    loading = true;
    try {
      const next = await getNodeLogs(orgId, instanceId, nodeId, { limit: 200, level: level || null, since }, mine.signal);
      data = next;
      receivedAt = Date.now();
      // Lower-case once per load, not per keystroke.
      rows = next.logs.map((l) => ({ ...l, haystack: `${l.component ?? ''} ${l.message}`.toLowerCase() }));
      error = null;
    } catch (err) {
      if (mine.signal.aborted) return;
      // Keep the last logs on screen, like the metrics panel.
      error = err instanceof ClusterApiError ? err : new ClusterApiError('error', 'Could not load logs');
    } finally {
      if (controller === mine) loading = false;
    }
  }

  onDestroy(() => controller?.abort());

  $: nodeId, level, since, load();
  $: if (follow && tick) load();

  $: needle = search.trim().toLowerCase();
  $: shown = needle ? rows.filter((r) => r.haystack.includes(needle)) : rows;

  const LEVEL_CLASS: Record<string, string> = {
    ERROR: 'text-red-600 dark:text-red-400',
    FATAL: 'text-red-600 dark:text-red-400',
    WARN: 'text-yellow-600 dark:text-yellow-400',
    INFO: 'text-blue-600 dark:text-blue-400',
    DEBUG: 'text-muted-foreground',
  };
  const selectClass = 'h-8 rounded-md border border-input bg-background px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
</script>

<div class="mt-5">
  <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
    <div>
      <h4 class="text-sm font-semibold">Arc application logs</h4>
      <p class="text-xs text-muted-foreground">
        Source: node <span class="font-mono">{nodeId}</span>{data ? ` at ${data.source}` : ''} · the node's in-memory log buffer
        {#if data}· fetched {formatAge(dataAgeMs(data, receivedAt, now))}{/if}
      </p>
    </div>
    <div class="flex items-center gap-2 text-xs">
      <select bind:value={level} aria-label="Minimum level" class={selectClass}>
        <option value="">All levels</option>
        {#each LOG_LEVELS as l}<option value={l}>{l.toUpperCase()}+</option>{/each}
      </select>
      <select bind:value={since} aria-label="Time range" class={selectClass}>
        {#each LOG_SINCE_OPTIONS as m}<option value={m}>Last {m < 60 ? `${m} min` : `${m / 60} h`}</option>{/each}
      </select>
      <input type="search" bind:value={search} placeholder="Filter" aria-label="Filter logs" class="h-8 w-36 rounded-md border border-input bg-background px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      <label class="flex items-center gap-1 text-muted-foreground"><input type="checkbox" bind:checked={follow} /> Follow</label>
      <Button variant="ghost" size="sm" on:click={load} disabled={loading} aria-label="Reload logs">
        <RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
      </Button>
    </div>
  </div>

  {#if error}
    <p role="status" class="mb-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
      Could not read logs: {describeClusterError(error.code)}.{data ? ' Showing the last logs read.' : ''}
    </p>
  {/if}
  {#if !data && loading}
    <p class="py-4 text-center text-sm text-muted-foreground">Loading logs…</p>
  {:else if data && shown.length === 0}
    <p class="py-4 text-center text-sm text-muted-foreground">No log entries match.</p>
  {:else if data}
    <div class="max-h-80 overflow-auto rounded-md border font-mono text-xs">
      {#each shown as log}
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
