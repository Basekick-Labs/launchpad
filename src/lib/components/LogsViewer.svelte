<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { ArcClient, LogEntry } from '$lib/arcClient';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { RefreshCw, Search, Pause, Play } from 'lucide-svelte';
  import { cn } from '$lib/utils/cn';

  export let client: ArcClient;

  let logs: LogEntry[] = [];
  let filteredLogs: LogEntry[] = [];
  let isLoading = false;
  let error: string | null = null;
  let autoRefresh = true;
  let refreshInterval: ReturnType<typeof setInterval> | null = null;

  let levelFilter = '';
  let searchQuery = '';
  let sinceMinutes = 60;

  const levelOptions = [
    { value: '', label: 'All Levels' },
    { value: 'DEBUG', label: 'Debug' },
    { value: 'INFO', label: 'Info' },
    { value: 'WARN', label: 'Warning' },
    { value: 'ERROR', label: 'Error' },
  ];

  const timeOptions = [
    { value: 5, label: 'Last 5 minutes' },
    { value: 15, label: 'Last 15 minutes' },
    { value: 30, label: 'Last 30 minutes' },
    { value: 60, label: 'Last hour' },
    { value: 360, label: 'Last 6 hours' },
    { value: 1440, label: 'Last 24 hours' },
  ];

  async function fetchLogs() {
    try {
      isLoading = true;
      error = null;

      const response = await client.getLogs(200, levelFilter || undefined, sinceMinutes);
      logs = response.logs;
      filterLogs();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to fetch logs';
    } finally {
      isLoading = false;
    }
  }

  function filterLogs() {
    if (!searchQuery) {
      filteredLogs = logs;
      return;
    }

    const query = searchQuery.toLowerCase();
    filteredLogs = logs.filter(log =>
      log.message.toLowerCase().includes(query) ||
      log.component?.toLowerCase().includes(query) ||
      log.level.toLowerCase().includes(query)
    );
  }

  function handleLevelChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    levelFilter = target.value;
    fetchLogs();
  }

  function handleTimeChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    sinceMinutes = Number(target.value);
    fetchLogs();
  }

  function handleSearch() {
    filterLogs();
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
      refreshInterval = setInterval(fetchLogs, 5000);
    }
  }

  function formatTimestamp(timestamp: string): string {
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return timestamp;
    }
  }

  function getLevelClass(level: string): string {
    switch (level.toUpperCase()) {
      case 'ERROR':
      case 'FATAL':
        return 'text-red-500';
      case 'WARN':
      case 'WARNING':
        return 'text-yellow-500';
      case 'INFO':
        return 'text-blue-400';
      case 'DEBUG':
        return 'text-neutral-500';
      default:
        return 'text-muted-foreground';
    }
  }

  function getLevelBgClass(level: string): string {
    switch (level.toUpperCase()) {
      case 'ERROR':
      case 'FATAL':
        return 'bg-red-500/10';
      case 'WARN':
      case 'WARNING':
        return 'bg-yellow-500/10';
      case 'INFO':
        return 'bg-blue-500/10';
      case 'DEBUG':
        return 'bg-neutral-500/10';
      default:
        return 'bg-muted';
    }
  }

  $: {
    searchQuery;
    filterLogs();
  }

  onMount(() => {
    fetchLogs();
    setupRefreshInterval();
  });

  onDestroy(() => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
  });
</script>

<div class="flex flex-col rounded-lg border bg-card">
  <!-- Toolbar -->
  <div class="flex flex-wrap items-center gap-3 border-b p-4">
    <select
      class="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      value={levelFilter}
      on:change={handleLevelChange}
    >
      {#each levelOptions as option}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>

    <select
      class="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      value={sinceMinutes}
      on:change={handleTimeChange}
    >
      {#each timeOptions as option}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>

    <div class="relative flex-1 min-w-[200px]">
      <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="text"
        placeholder="Search logs..."
        class="pl-9"
        bind:value={searchQuery}
        on:input={handleSearch}
      />
    </div>

    <Button variant="outline" size="sm" on:click={toggleAutoRefresh}>
      {#if autoRefresh}
        <Pause class="mr-2 h-4 w-4" />
        Auto
      {:else}
        <Play class="mr-2 h-4 w-4" />
        Auto
      {/if}
    </Button>

    <Button variant="outline" size="icon" on:click={fetchLogs} disabled={isLoading}>
      <RefreshCw class={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
    </Button>
  </div>

  <!-- Logs Table -->
  <div class="max-h-[400px] overflow-auto">
    {#if error}
      <div class="p-4 text-destructive">{error}</div>
    {:else if filteredLogs.length === 0}
      <div class="p-8 text-center text-muted-foreground">
        {#if isLoading}
          Loading logs...
        {:else}
          No logs found
        {/if}
      </div>
    {:else}
      <table class="w-full text-sm">
        <thead class="sticky top-0 bg-card">
          <tr class="border-b text-left text-muted-foreground">
            <th class="w-[100px] px-4 py-2 font-medium">Time</th>
            <th class="w-[80px] px-4 py-2 font-medium">Level</th>
            <th class="w-[120px] px-4 py-2 font-medium">Component</th>
            <th class="px-4 py-2 font-medium">Message</th>
          </tr>
        </thead>
        <tbody class="font-mono text-xs">
          {#each filteredLogs as log}
            <tr class={cn('border-b border-border/50 hover:bg-muted/30', getLevelBgClass(log.level))}>
              <td class="px-4 py-2 text-muted-foreground">{formatTimestamp(log.timestamp)}</td>
              <td class="px-4 py-2">
                <span class={cn('font-semibold', getLevelClass(log.level))}>
                  {log.level}
                </span>
              </td>
              <td class="px-4 py-2 text-muted-foreground">{log.component || '-'}</td>
              <td class="px-4 py-2 truncate max-w-[500px]" title={log.message}>{log.message}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <!-- Footer -->
  <div class="border-t px-4 py-2 text-xs text-muted-foreground">
    Showing {filteredLogs.length} of {logs.length} logs
  </div>
</div>
