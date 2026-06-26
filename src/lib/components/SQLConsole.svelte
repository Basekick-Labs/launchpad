<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import SchemaExplorer from './SchemaExplorer.svelte';
  import QueryHistory from './QueryHistory.svelte';
  import QueryEditor from './QueryEditor.svelte';
  import ResultsPanel from './ResultsPanel.svelte';
  import { Button } from '$lib/components/ui/button';
  import { cn } from '$lib/utils';
  import type { ArcClient, QueryResult, StatementResult } from '$lib/arcClient';
  import { PanelLeftClose, PanelLeft, Table2, History, Database } from 'lucide-svelte';

  export let client: ArcClient;

  const dispatch = createEventDispatcher();

  let queryEditor: QueryEditor;
  let schemaCollapsed = false;
  let activeSchemaTab: 'tables' | 'history' = 'tables';

  // Database selection state (persisted in localStorage)
  const DB_STORAGE_KEY = 'arc_sql_console_database';
  let selectedDatabase: string | null = null;

  // Restore from localStorage on init
  try {
    selectedDatabase = localStorage.getItem(DB_STORAGE_KEY);
  } catch {
    // localStorage not available
  }

  // Query state
  let currentQuery = 'SELECT 1;';
  let lastResults: StatementResult[] = [];
  let lastQueryText = '';

  function handleDatabaseSelect(database: string | null) {
    selectedDatabase = database;
    try {
      if (selectedDatabase) {
        localStorage.setItem(DB_STORAGE_KEY, selectedDatabase);
      } else {
        localStorage.removeItem(DB_STORAGE_KEY);
      }
    } catch {
      // localStorage not available
    }
  }

  function handleTableSelect(query: string) {
    if (queryEditor) {
      queryEditor.setQuery(query);
    }
  }

  function handleQuerySelect(sql: string) {
    if (queryEditor) {
      queryEditor.setQuery(sql);
    }
  }

  function handleQueryExecuted(event: CustomEvent<{ results: StatementResult[]; query: string; error: string; executionTime?: number }>) {
    const { results, query, error, executionTime } = event.detail;
    lastResults = results;
    lastQueryText = query;

    // Calculate totals for status bar
    const totalRows = results.reduce((sum, r) => sum + (r.result?.rowCount || 0), 0);
    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;

    // Dispatch to parent for status bar updates
    dispatch('queryExecuted', {
      results,
      query,
      error,
      executionTime,
      statementCount: results.length,
      successCount,
      errorCount,
      totalRows
    });
  }

  function toggleSchemaPanel() {
    schemaCollapsed = !schemaCollapsed;
  }

  // Export method to set query from parent
  export function setQuery(sql: string) {
    if (queryEditor) {
      queryEditor.setQuery(sql);
    }
  }
</script>

<div class="flex h-full">
  <!-- Schema Panel (Left) -->
  <aside
    class={cn(
      'flex flex-col border-r bg-card transition-all duration-200',
      schemaCollapsed ? 'w-0 overflow-hidden' : 'w-64'
    )}
  >
    <!-- Schema Panel Header with Tabs -->
    <div class="flex h-10 items-center border-b px-2">
      <Button
        variant="ghost"
        size="sm"
        class={cn(
          'h-7 flex-1 justify-start gap-2 px-2 text-xs',
          activeSchemaTab === 'tables' && 'bg-muted'
        )}
        on:click={() => activeSchemaTab = 'tables'}
      >
        <Table2 class="h-3.5 w-3.5" />
        Tables
      </Button>
      <Button
        variant="ghost"
        size="sm"
        class={cn(
          'h-7 flex-1 justify-start gap-2 px-2 text-xs',
          activeSchemaTab === 'history' && 'bg-muted'
        )}
        on:click={() => activeSchemaTab = 'history'}
      >
        <History class="h-3.5 w-3.5" />
        History
      </Button>
    </div>

    <!-- Schema Content -->
    <div class="flex-1 overflow-auto">
      {#if activeSchemaTab === 'tables'}
        <SchemaExplorer
          {client}
          {selectedDatabase}
          onTableSelect={handleTableSelect}
          onDatabaseSelect={handleDatabaseSelect}
        />
      {:else}
        <QueryHistory onQuerySelect={handleQuerySelect} />
      {/if}
    </div>
  </aside>

  <!-- Main Content (Right) -->
  <div class="flex flex-1 flex-col overflow-hidden">
    <!-- Toggle Button + Editor Header -->
    <div class="flex h-10 items-center gap-2 border-b bg-muted/30 px-2">
      <Button
        variant="ghost"
        size="icon"
        class="h-7 w-7"
        on:click={toggleSchemaPanel}
        title={schemaCollapsed ? 'Show schema' : 'Hide schema'}
      >
        {#if schemaCollapsed}
          <PanelLeft class="h-4 w-4" />
        {:else}
          <PanelLeftClose class="h-4 w-4" />
        {/if}
      </Button>
      <span class="text-sm font-medium">SQL Console</span>

      <!-- Active Database Indicator -->
      {#if selectedDatabase}
        <div class="ml-auto flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-xs text-primary">
          <Database class="h-3.5 w-3.5" />
          <span>{selectedDatabase}</span>
        </div>
      {:else}
        <span class="ml-auto text-xs text-muted-foreground">Click a database to select it</span>
      {/if}
    </div>

    <!-- Editor + Results Split -->
    <div class="flex flex-1 flex-col overflow-hidden">
      <!-- Query Editor (Top) -->
      <div class="h-[45%] min-h-[200px] border-b">
        <QueryEditor
          {client}
          database={selectedDatabase}
          bind:this={queryEditor}
          initialQuery={currentQuery}
          on:queryExecuted={handleQueryExecuted}
        />
      </div>

      <!-- Results Panel (Bottom) -->
      <div class="flex-1 overflow-auto">
        <ResultsPanel results={lastResults} />
      </div>
    </div>
  </div>
</div>
