<script lang="ts">
  import { onMount } from 'svelte';
  import type { ArcClient } from '$lib/arcClient';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { cn } from '$lib/utils';
  import { ChevronDown, ChevronRight, Database, Table2, RefreshCw, Loader2, Check, Plus, X } from 'lucide-svelte';

  export let client: ArcClient;
  export let onTableSelect: (tableName: string) => void;
  export let onDatabaseSelect: (database: string | null) => void = () => {};
  export let selectedDatabase: string | null = null;

  interface DatabaseSchema {
    database: string;
    tables: string[];
    tier: string | null;
  }

  let databases: DatabaseSchema[] = [];
  let expandedDatabases = new Set<string>();
  let isLoading = false;
  let loadingTables = new Set<string>();
  let error = '';
  let showCreateInput = false;
  let newDbName = '';
  let creating = false;

  async function loadDatabases() {
    isLoading = true;
    error = '';

    // Remember which databases were expanded before refresh
    const previouslyExpanded = new Set(expandedDatabases);

    try {
      // Get list of databases
      const result = await client.query('SHOW DATABASES;');

      // Response format: { columns: ['database', 'tier'], data: [['db_name', 'hot'], ...] }
      // Tier column is optional (only present when tiering is enabled)
      const tierIndex = result.columns.indexOf('tier');

      databases = result.rows.map(row => ({
        database: row[0] as string,
        tables: [],
        tier: tierIndex >= 0 ? (row[tierIndex] as string) : null
      }));

      // Determine which databases to expand and load tables for
      const databasesToExpand = previouslyExpanded.size > 0
        ? [...previouslyExpanded].filter(db => databases.some(d => d.database === db))
        : databases.length > 0 ? [databases[0].database] : [];

      // Restore expanded state
      expandedDatabases = new Set(databasesToExpand);

      // Load tables for all expanded databases in parallel
      await Promise.all(databasesToExpand.map(db => loadTablesForDatabase(db)));
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load databases';
      console.error('Schema load error:', err);
    } finally {
      isLoading = false;
    }
  }

  async function loadTablesForDatabase(database: string) {
    loadingTables.add(database);
    loadingTables = loadingTables;

    try {
      // Get tables for specific database
      const result = await client.query(`SHOW TABLES FROM ${database};`);

      // SHOW TABLES returns: [database, table_name, path, ...]
      // Table name is in column 1 (index 1)
      const tables = result.rows.map(row => row[1] as string);

      // Update the database with its tables
      databases = databases.map(db =>
        db.database === database ? { ...db, tables } : db
      );
    } catch (err) {
      console.error(`Failed to load tables for ${database}:`, err);
    } finally {
      loadingTables.delete(database);
      loadingTables = loadingTables;
    }
  }

  function toggleDatabase(database: string) {
    if (expandedDatabases.has(database)) {
      expandedDatabases.delete(database);
    } else {
      expandedDatabases.add(database);
      // Load tables if not already loaded
      const db = databases.find(d => d.database === database);
      if (db && db.tables.length === 0 && !loadingTables.has(database)) {
        loadTablesForDatabase(database);
      }
    }
    expandedDatabases = expandedDatabases;
  }

  function handleDatabaseClick(database: string) {
    // Toggle selection: if already selected, deselect; otherwise select
    if (selectedDatabase === database) {
      onDatabaseSelect(null);
    } else {
      onDatabaseSelect(database);
    }
    // Also expand the database
    if (!expandedDatabases.has(database)) {
      toggleDatabase(database);
    }
  }

  function handleTableClick(database: string, table: string) {
    // Generate a full SELECT query
    const tableName = selectedDatabase === database ? table : `${database}.${table}`;
    const query = `SELECT * FROM ${tableName} LIMIT 100;`;
    onTableSelect(query);
  }

  function getTierBadgeClass(tier: string): string {
    if (tier.includes('hot') && tier.includes('cold')) {
      return 'bg-gradient-to-r from-orange-500/20 to-blue-500/20 text-orange-600 dark:text-orange-400';
    }
    if (tier === 'hot') {
      return 'bg-orange-500/20 text-orange-600 dark:text-orange-400';
    }
    if (tier === 'cold') {
      return 'bg-blue-500/20 text-blue-600 dark:text-blue-400';
    }
    // local or unknown
    return 'bg-muted text-muted-foreground';
  }

  async function handleCreateDatabase() {
    const name = newDbName.trim();
    if (!name || creating) return;
    creating = true;
    try {
      await client.createDatabase(name);
      showCreateInput = false;
      newDbName = '';
      await loadDatabases();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create database';
    } finally {
      creating = false;
    }
  }

  onMount(() => {
    loadDatabases();
  });
</script>

<div>
  <!-- Header -->
  <div class="flex items-center justify-between border-b px-3 py-2">
    <span class="text-xs font-medium text-muted-foreground">DATABASES</span>
    <div class="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        class="h-6 w-6"
        on:click={() => { showCreateInput = !showCreateInput; newDbName = ''; }}
        title="Create database"
      >
        <Plus class="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="h-6 w-6"
        on:click={loadDatabases}
        disabled={isLoading}
        title="Refresh schema"
      >
        <RefreshCw class={cn("h-3 w-3", isLoading && "animate-spin")} />
      </Button>
    </div>
  </div>

  <!-- Create database input -->
  {#if showCreateInput}
    <div class="border-b px-3 py-2">
      <form on:submit|preventDefault={handleCreateDatabase} class="flex items-center gap-1">
        <input
          type="text"
          bind:value={newDbName}
          placeholder="database_name"
          class="h-7 flex-1 rounded border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          disabled={creating}
          autofocus
        />
        <Button variant="ghost" size="icon" class="h-6 w-6" type="submit" disabled={!newDbName.trim() || creating}>
          <Check class="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" class="h-6 w-6" on:click={() => { showCreateInput = false; newDbName = ''; }}>
          <X class="h-3 w-3" />
        </Button>
      </form>
    </div>
  {/if}

  <div class="px-2 pb-2">
    {#if error}
      <div class="rounded-md bg-destructive/10 p-3 text-center text-sm text-destructive">{error}</div>
    {:else if isLoading && databases.length === 0}
      <div class="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 class="h-4 w-4 animate-spin" />
        Loading...
      </div>
    {:else if databases.length === 0}
      <div class="py-4 text-center text-sm text-muted-foreground">No databases found</div>
    {:else}
      <div class="space-y-1 pt-2">
        {#each databases as db}
          <div>
            <div
              class={cn(
                "flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                selectedDatabase === db.database
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-muted"
              )}
            >
              <!-- Chevron button for expand/collapse -->
              <button
                class="p-0.5 rounded hover:bg-muted/50"
                on:click|stopPropagation={() => toggleDatabase(db.database)}
                title={expandedDatabases.has(db.database) ? 'Collapse' : 'Expand'}
              >
                {#if expandedDatabases.has(db.database)}
                  <ChevronDown class="h-3 w-3 text-muted-foreground" />
                {:else}
                  <ChevronRight class="h-3 w-3 text-muted-foreground" />
                {/if}
              </button>
              <!-- Database name button for selection -->
              <button
                class="flex flex-1 items-center gap-2 text-left"
                on:click={() => handleDatabaseClick(db.database)}
                title={selectedDatabase === db.database ? 'Click to deselect database' : 'Click to use this database for queries'}
              >
                <Database class={cn("h-4 w-4", selectedDatabase === db.database ? "text-primary" : "text-muted-foreground")} />
                <span class="flex-1 truncate font-medium">{db.database}</span>
                {#if db.tier}
                  <span class={cn("h-5 px-1.5 text-[10px] font-medium rounded flex items-center", getTierBadgeClass(db.tier))} title="Storage tier: {db.tier}">
                    {db.tier}
                  </span>
                {/if}
                {#if selectedDatabase === db.database}
                  <Check class="h-3.5 w-3.5 text-primary" />
                {:else if db.tables.length > 0}
                  <Badge variant="secondary" class="h-5 px-1.5 text-xs">{db.tables.length}</Badge>
                {/if}
              </button>
            </div>

            {#if expandedDatabases.has(db.database)}
              <div class="ml-4 border-l pl-2">
                {#if loadingTables.has(db.database)}
                  <div class="flex items-center gap-2 py-2 pl-2 text-xs text-muted-foreground">
                    <Loader2 class="h-3 w-3 animate-spin" />
                    Loading tables...
                  </div>
                {:else if db.tables.length === 0}
                  <div class="py-2 pl-2 text-xs text-muted-foreground">No tables</div>
                {:else}
                  {#each db.tables as table}
                    <button
                      class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-muted"
                      on:click={() => handleTableClick(db.database, table)}
                      title="SELECT * FROM {selectedDatabase === db.database ? table : `${db.database}.${table}`} LIMIT 100"
                    >
                      <Table2 class="h-3.5 w-3.5 text-muted-foreground" />
                      <span class="truncate">{table}</span>
                    </button>
                  {/each}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
