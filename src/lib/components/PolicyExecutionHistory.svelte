<script lang="ts">
  import { onMount } from 'svelte';
  import type { ArcClient, RetentionExecution, CQExecution } from '$lib/arcClient';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { ChevronDown, ChevronUp, Loader2, AlertCircle } from 'lucide-svelte';

  export let client: ArcClient;
  export let policyId: number;
  export let type: 'retention' | 'cq';

  let executions: (RetentionExecution | CQExecution)[] = [];
  let isLoading = false;
  let error: string | null = null;
  let isExpanded = false;
  let limit = 5;

  async function loadExecutions() {
    isLoading = true;
    error = null;
    try {
      if (type === 'retention') {
        executions = await client.getRetentionExecutions(policyId, limit);
      } else {
        executions = await client.getCQExecutions(policyId, limit);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load execution history';
    } finally {
      isLoading = false;
    }
  }

  function toggleExpanded() {
    isExpanded = !isExpanded;
    if (isExpanded && executions.length === 0) {
      loadExecutions();
    }
  }

  function loadMore() {
    limit += 10;
    loadExecutions();
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleString();
  }

  function formatDuration(execution: RetentionExecution | CQExecution): string {
    if ('execution_duration_ms' in execution) {
      return `${execution.execution_duration_ms.toFixed(0)}ms`;
    }
    if ('execution_duration_seconds' in execution) {
      return `${execution.execution_duration_seconds.toFixed(2)}s`;
    }
    return 'N/A';
  }

  function getRecordCount(execution: RetentionExecution | CQExecution): string {
    if ('deleted_count' in execution) {
      return `${execution.deleted_count.toLocaleString()} deleted`;
    }
    if ('records_written' in execution) {
      return `${execution.records_written.toLocaleString()} written`;
    }
    return 'N/A';
  }

  function getStatusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
    switch (status.toLowerCase()) {
      case 'success':
        return 'default';
      case 'error':
      case 'failed':
        return 'destructive';
      case 'running':
        return 'secondary';
      default:
        return 'outline';
    }
  }
</script>

<div class="mt-4 border-t pt-4">
  <button
    class="flex w-full items-center justify-between text-sm font-medium hover:text-primary"
    on:click={toggleExpanded}
  >
    <span>Execution History</span>
    {#if isExpanded}
      <ChevronUp class="h-4 w-4" />
    {:else}
      <ChevronDown class="h-4 w-4" />
    {/if}
  </button>

  {#if isExpanded}
    <div class="mt-3">
      {#if isLoading}
        <div class="flex items-center justify-center py-4">
          <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      {:else if error}
        <div class="flex items-center gap-2 py-4 text-sm text-destructive">
          <AlertCircle class="h-4 w-4" />
          {error}
        </div>
      {:else if executions.length === 0}
        <p class="py-4 text-center text-sm text-muted-foreground">No executions yet</p>
      {:else}
        <div class="overflow-hidden rounded-md border">
          <table class="w-full text-sm">
            <thead class="bg-muted">
              <tr>
                <th class="px-3 py-2 text-left font-medium">Time</th>
                <th class="px-3 py-2 text-left font-medium">Status</th>
                <th class="px-3 py-2 text-left font-medium">Duration</th>
                <th class="px-3 py-2 text-left font-medium">Records</th>
                <th class="px-3 py-2 text-left font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {#each executions as execution}
                <tr class="border-t hover:bg-muted/50">
                  <td class="px-3 py-2 whitespace-nowrap">{formatDate(execution.execution_time)}</td>
                  <td class="px-3 py-2">
                    <Badge variant={getStatusVariant(execution.status)}>
                      {execution.status}
                    </Badge>
                  </td>
                  <td class="px-3 py-2">{formatDuration(execution)}</td>
                  <td class="px-3 py-2">{getRecordCount(execution)}</td>
                  <td class="px-3 py-2 max-w-[200px] truncate text-muted-foreground" title={execution.error_message || ''}>
                    {execution.error_message || '-'}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        {#if executions.length >= limit}
          <div class="mt-2 text-center">
            <Button variant="ghost" size="sm" on:click={loadMore}>
              Load more
            </Button>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>
