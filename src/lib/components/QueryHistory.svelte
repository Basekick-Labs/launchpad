<script lang="ts">
  import { onMount } from 'svelte';
  import { QueryHistoryManager, type QueryHistoryEntry } from '$lib/queryHistory';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { cn } from '$lib/utils';
  import { ChevronDown, ChevronRight, History, X, Check, AlertCircle, Trash2 } from 'lucide-svelte';

  export let onQuerySelect: (sql: string) => void;

  let history: QueryHistoryEntry[] = [];

  function loadHistory() {
    history = QueryHistoryManager.getHistory();
  }

  function handleQueryClick(entry: QueryHistoryEntry) {
    onQuerySelect(entry.sql);
  }

  function handleClearHistory() {
    if (confirm('Clear all query history?')) {
      QueryHistoryManager.clearHistory();
      loadHistory();
    }
  }

  function handleDeleteEntry(id: string, event: Event) {
    event.stopPropagation();
    QueryHistoryManager.deleteEntry(id);
    loadHistory();
  }

  function formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    // Less than 1 minute
    if (diff < 60000) {
      return 'Just now';
    }
    // Less than 1 hour
    if (diff < 3600000) {
      const mins = Math.floor(diff / 60000);
      return `${mins}m ago`;
    }
    // Less than 24 hours
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours}h ago`;
    }
    // Same year
    if (date.getFullYear() === now.getFullYear()) {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    // Different year
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatDuration(ms?: number): string {
    if (!ms) return '';
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  function truncateSQL(sql: string, maxLength = 60): string {
    const singleLine = sql.replace(/\s+/g, ' ').trim();
    if (singleLine.length <= maxLength) return singleLine;
    return singleLine.substring(0, maxLength) + '...';
  }

  // Refresh history when component mounts
  onMount(() => {
    loadHistory();

    // Listen for custom event when query is executed
    const handleQueryExecuted = () => loadHistory();
    window.addEventListener('query-executed', handleQueryExecuted);

    return () => {
      window.removeEventListener('query-executed', handleQueryExecuted);
    };
  });
</script>

<div>
  <!-- Header -->
  <div class="flex items-center justify-between border-b px-3 py-2">
    <span class="text-xs font-medium text-muted-foreground">
      HISTORY {#if history.length > 0}({history.length}){/if}
    </span>
    {#if history.length > 0}
      <Button
        variant="ghost"
        size="icon"
        class="h-6 w-6 text-muted-foreground hover:text-destructive"
        on:click={handleClearHistory}
        title="Clear all history"
      >
        <Trash2 class="h-3 w-3" />
      </Button>
    {/if}
  </div>

  <div>
    <div class="px-2 pb-2">
      {#if history.length === 0}
        <div class="py-4 text-center text-sm text-muted-foreground">No query history</div>
      {:else}
        <div class="max-h-[400px] space-y-1 overflow-y-auto">
          {#each history as entry}
            <button
              class={cn(
                "group flex w-full flex-col gap-1 rounded-md p-2 text-left transition-colors hover:bg-muted",
                !entry.success && "border-l-2 border-destructive"
              )}
              on:click={() => handleQueryClick(entry)}
              title={entry.sql}
            >
              <div class="flex items-center gap-2 text-xs">
                {#if entry.success}
                  <Check class="h-3 w-3 text-green-500" />
                {:else}
                  <AlertCircle class="h-3 w-3 text-destructive" />
                {/if}
                <span class="flex-1 text-muted-foreground">{formatTimestamp(entry.timestamp)}</span>
                <button
                  class="rounded p-0.5 opacity-0 transition-opacity hover:bg-background group-hover:opacity-100"
                  on:click={(e) => handleDeleteEntry(entry.id, e)}
                  title="Delete"
                >
                  <X class="h-3 w-3 text-muted-foreground hover:text-destructive" />
                </button>
              </div>
              <div class="truncate font-mono text-xs">{truncateSQL(entry.sql)}</div>
              {#if entry.success && entry.rowCount !== undefined}
                <div class="flex gap-3 text-xs text-muted-foreground">
                  <span>{entry.rowCount} rows</span>
                  {#if entry.executionTime}
                    <span class="text-primary">{formatDuration(entry.executionTime)}</span>
                  {/if}
                </div>
              {/if}
              {#if !entry.success && entry.error}
                <div class="truncate text-xs text-destructive">{entry.error}</div>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
