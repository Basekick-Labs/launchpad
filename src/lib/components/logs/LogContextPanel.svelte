<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { ArcClient } from '$lib/arcClient';
  import { Button } from '$lib/components/ui/button';
  import { cn } from '$lib/utils';
  import { X, RefreshCw, ChevronUp, ChevronDown } from 'lucide-svelte';
  import {
    getLevelColorClass,
    getLevelBgClass,
    formatLogTimestamp,
    type LogFieldMapping,
  } from '$lib/logFieldDetector';

  export let client: ArcClient;
  export let selectedLog: Record<string, unknown> | null = null;
  export let fieldMapping: LogFieldMapping;
  export let database: string;
  export let table: string;
  export let contextLines = 10; // Number of lines before/after

  const dispatch = createEventDispatcher();

  let contextLogs: Record<string, unknown>[] = [];
  let isLoading = false;
  let error: string | null = null;

  $: if (selectedLog && fieldMapping.timestamp) {
    fetchContext();
  }

  async function fetchContext() {
    if (!selectedLog || !fieldMapping.timestamp) return;

    const timestamp = selectedLog[fieldMapping.timestamp];
    if (!timestamp) return;

    try {
      isLoading = true;
      error = null;

      // Query for logs around the selected timestamp using x-arc-database header
      const beforeQuery = `
        SELECT * FROM ${table}
        WHERE ${fieldMapping.timestamp} < '${timestamp}'
        ORDER BY ${fieldMapping.timestamp} DESC
        LIMIT ${contextLines}
      `;

      const afterQuery = `
        SELECT * FROM ${table}
        WHERE ${fieldMapping.timestamp} > '${timestamp}'
        ORDER BY ${fieldMapping.timestamp} ASC
        LIMIT ${contextLines}
      `;

      let beforeResult, afterResult;
      try {
        // Try with x-arc-database header first (preferred)
        [beforeResult, afterResult] = await Promise.all([
          client.query(beforeQuery, database),
          client.query(afterQuery, database),
        ]);
      } catch {
        // Fallback to database.table syntax
        const beforeFallback = `
          SELECT * FROM ${database}.${table}
          WHERE ${fieldMapping.timestamp} < '${timestamp}'
          ORDER BY ${fieldMapping.timestamp} DESC
          LIMIT ${contextLines}
        `;
        const afterFallback = `
          SELECT * FROM ${database}.${table}
          WHERE ${fieldMapping.timestamp} > '${timestamp}'
          ORDER BY ${fieldMapping.timestamp} ASC
          LIMIT ${contextLines}
        `;
        [beforeResult, afterResult] = await Promise.all([
          client.query(beforeFallback),
          client.query(afterFallback),
        ]);
      }

      const columns = beforeResult.columns || afterResult.columns || [];

      const beforeLogs = (beforeResult.rows || []).map(row => {
        const obj: Record<string, unknown> = {};
        columns.forEach((col, idx) => {
          obj[col] = row[idx];
        });
        return obj;
      }).reverse(); // Reverse to chronological order

      const afterLogs = (afterResult.rows || []).map(row => {
        const obj: Record<string, unknown> = {};
        columns.forEach((col, idx) => {
          obj[col] = row[idx];
        });
        return obj;
      });

      // Combine: before + selected + after
      contextLogs = [...beforeLogs, selectedLog, ...afterLogs];
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to fetch context';
      contextLogs = [selectedLog];
    } finally {
      isLoading = false;
    }
  }

  function close() {
    dispatch('close');
  }

  function getLogValue(log: Record<string, unknown>, field: string | null): string {
    if (!field || !(field in log)) return '-';
    const value = log[field];
    if (value === null || value === undefined) return '-';
    return String(value);
  }

  function isSelectedLog(log: Record<string, unknown>): boolean {
    if (!selectedLog || !fieldMapping.timestamp) return false;
    return log[fieldMapping.timestamp] === selectedLog[fieldMapping.timestamp];
  }
</script>

<div class="flex h-full flex-col border-l bg-card">
  <!-- Header -->
  <div class="flex items-center justify-between border-b px-4 py-3">
    <div class="flex items-center gap-2">
      <span class="text-sm font-medium">Log Context</span>
      <span class="text-xs text-muted-foreground">
        ±{contextLines} lines
      </span>
    </div>
    <div class="flex items-center gap-1">
      <Button variant="ghost" size="icon" on:click={fetchContext} disabled={isLoading}>
        <RefreshCw class={cn('h-4 w-4', isLoading && 'animate-spin')} />
      </Button>
      <Button variant="ghost" size="icon" on:click={close}>
        <X class="h-4 w-4" />
      </Button>
    </div>
  </div>

  <!-- Content -->
  <div class="flex-1 overflow-auto">
    {#if error}
      <div class="p-4 text-sm text-destructive">{error}</div>
    {:else if isLoading}
      <div class="flex h-full items-center justify-center text-muted-foreground">
        <RefreshCw class="mr-2 h-4 w-4 animate-spin" />
        Loading context...
      </div>
    {:else if contextLogs.length === 0}
      <div class="flex h-full items-center justify-center text-muted-foreground">
        No context available
      </div>
    {:else}
      <div class="divide-y">
        {#each contextLogs as log, idx}
          {@const timestamp = getLogValue(log, fieldMapping.timestamp)}
          {@const level = getLogValue(log, fieldMapping.level)}
          {@const message = getLogValue(log, fieldMapping.message)}
          {@const isSelected = isSelectedLog(log)}

          <div
            class={cn(
              'px-4 py-2 font-mono text-xs',
              isSelected ? 'bg-primary/10 border-l-2 border-primary' : getLevelBgClass(level)
            )}
          >
            <div class="flex items-start gap-2">
              <span class="w-[120px] shrink-0 text-muted-foreground">
                {formatLogTimestamp(timestamp)}
              </span>
              <span class={cn('w-[50px] shrink-0 font-semibold', getLevelColorClass(level))}>
                {level}
              </span>
              <span class="flex-1 break-all whitespace-pre-wrap">
                {message}
              </span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Footer -->
  <div class="border-t px-4 py-2 text-xs text-muted-foreground">
    {contextLogs.length} log{contextLogs.length !== 1 ? 's' : ''} in context
  </div>
</div>
