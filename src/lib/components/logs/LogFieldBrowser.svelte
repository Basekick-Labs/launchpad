<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { ArcClient } from '$lib/arcClient';
  import type { LogFieldMapping } from '$lib/logFieldDetector';
  import { Button } from '$lib/components/ui/button';
  import { cn } from '$lib/utils';
  import { X, RefreshCw, ChevronRight, ChevronDown, Filter, Hash, Type, Calendar, Check } from 'lucide-svelte';

  export let client: ArcClient;
  export let database: string;
  export let table: string;
  export let columns: string[] = [];
  export let fieldMapping: LogFieldMapping = { timestamp: null, level: null, message: null, source: null, traceId: null, spanId: null, parentSpanId: null };
  export let selectedLevels: Set<string> = new Set();
  export let fieldFilters: Map<string, Set<string>> = new Map();

  const dispatch = createEventDispatcher<{
    close: void;
    addFilter: { field: string; value: string };
  }>();

  interface FieldStats {
    topValues: { value: string; count: number }[];
    isLoading: boolean;
    error: string | null;
  }

  let expandedFields: Set<string> = new Set();
  let fieldStats: Record<string, FieldStats> = {};

  // Check if a value is currently filtered
  function isValueFiltered(field: string, value: string): boolean {
    // For level field, check selectedLevels
    if (field === fieldMapping.level) {
      return selectedLevels.has(value.toUpperCase());
    }
    // For other fields, check fieldFilters
    const values = fieldFilters.get(field);
    return values ? values.has(value) : false;
  }

  function getFieldIcon(fieldName: string) {
    const lower = fieldName.toLowerCase();
    if (lower.includes('time') || lower.includes('date') || lower === 'ts') {
      return Calendar;
    }
    if (lower.includes('count') || lower.includes('size') || lower.includes('bytes') || lower.includes('id')) {
      return Hash;
    }
    return Type;
  }

  async function toggleField(field: string) {
    if (expandedFields.has(field)) {
      expandedFields.delete(field);
      expandedFields = expandedFields;
    } else {
      expandedFields.add(field);
      expandedFields = expandedFields;

      // Fetch top values if not already loaded
      if (!fieldStats[field]) {
        await fetchFieldStats(field);
      }
    }
  }

  async function fetchFieldStats(field: string) {
    fieldStats[field] = { topValues: [], isLoading: true, error: null };
    fieldStats = fieldStats;

    try {
      // Query top 10 values for this field
      const query = `
        SELECT ${field} as value, COUNT(*) as cnt
        FROM ${table}
        WHERE ${field} IS NOT NULL
        GROUP BY ${field}
        ORDER BY cnt DESC
        LIMIT 10
      `;

      let result;
      try {
        result = await client.query(query, database);
      } catch {
        // Fallback to database.table syntax
        const fallbackQuery = `
          SELECT ${field} as value, COUNT(*) as cnt
          FROM ${database}.${table}
          WHERE ${field} IS NOT NULL
          GROUP BY ${field}
          ORDER BY cnt DESC
          LIMIT 10
        `;
        result = await client.query(fallbackQuery);
      }

      const topValues = (result.rows || []).map(row => ({
        value: String(row[0] ?? '(null)'),
        count: Number(row[1]) || 0,
      }));

      fieldStats[field] = { topValues, isLoading: false, error: null };
    } catch (err) {
      fieldStats[field] = {
        topValues: [],
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to load stats',
      };
    }
    fieldStats = fieldStats;
  }

  function handleAddFilter(field: string, value: string) {
    dispatch('addFilter', { field, value });
  }

  function close() {
    dispatch('close');
  }
</script>

<div class="flex h-full flex-col border-l bg-card">
  <!-- Header -->
  <div class="flex items-center justify-between border-b px-4 py-3">
    <div class="flex items-center gap-2">
      <span class="text-sm font-medium">Field Browser</span>
      <span class="text-xs text-muted-foreground">
        {columns.length} field{columns.length !== 1 ? 's' : ''}
      </span>
    </div>
    <Button variant="ghost" size="icon" on:click={close}>
      <X class="h-4 w-4" />
    </Button>
  </div>

  <!-- Content -->
  <div class="flex-1 overflow-auto">
    {#if columns.length === 0}
      <div class="flex h-full items-center justify-center text-muted-foreground">
        No fields available
      </div>
    {:else}
      <div class="divide-y">
        {#each columns as field}
          {@const isExpanded = expandedFields.has(field)}
          {@const stats = fieldStats[field]}
          {@const FieldIcon = getFieldIcon(field)}

          <div class="px-3 py-2">
            <button
              class="flex w-full items-center gap-2 text-left hover:bg-muted/30 rounded px-1 py-1 transition-colors"
              on:click={() => toggleField(field)}
            >
              <span class="text-muted-foreground">
                {#if isExpanded}
                  <ChevronDown class="h-4 w-4" />
                {:else}
                  <ChevronRight class="h-4 w-4" />
                {/if}
              </span>
              <svelte:component this={FieldIcon} class="h-4 w-4 text-muted-foreground" />
              <span class="flex-1 font-mono text-sm truncate">{field}</span>
            </button>

            {#if isExpanded}
              <div class="ml-6 mt-2 space-y-1">
                {#if stats?.isLoading}
                  <div class="flex items-center gap-2 text-xs text-muted-foreground py-1">
                    <RefreshCw class="h-3 w-3 animate-spin" />
                    Loading values...
                  </div>
                {:else if stats?.error}
                  <div class="text-xs text-destructive py-1">{stats.error}</div>
                {:else if stats?.topValues && stats.topValues.length > 0}
                  <div class="text-xs text-muted-foreground mb-1">Top values:</div>
                  {#each stats.topValues as { value, count }}
                    {@const isFiltered = isValueFiltered(field, value)}
                    <button
                      class={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1 text-xs transition-colors group",
                        isFiltered
                          ? "bg-primary/20 text-primary"
                          : "hover:bg-muted/50"
                      )}
                      on:click={() => handleAddFilter(field, value)}
                      title={isFiltered ? "Click to remove filter" : "Click to add filter"}
                    >
                      <span class="flex-1 truncate font-mono text-left">{value}</span>
                      <span class={cn("text-muted-foreground", isFiltered && "text-primary/70")}>{count.toLocaleString()}</span>
                      {#if isFiltered}
                        <Check class="h-3 w-3 text-primary" />
                      {:else}
                        <Filter class="h-3 w-3 opacity-0 group-hover:opacity-100 text-primary transition-opacity" />
                      {/if}
                    </button>
                  {/each}
                {:else}
                  <div class="text-xs text-muted-foreground py-1">No values found</div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Footer -->
  <div class="border-t px-4 py-2 text-xs text-muted-foreground">
    Click to toggle filter
  </div>
</div>
