<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { ArcClient } from '$lib/arcClient';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { cn } from '$lib/utils';
  import {
    RefreshCw,
    Search,
    Play,
    Pause,
    X,
    Database,
    Code,
    Filter,
    Download,
    Columns,
    BarChart3,
    Layers2,
    Route,
    Globe,
    Calendar,
  } from 'lucide-svelte';
  import VirtualLogList from './VirtualLogList.svelte';
  import LogExportDialog from './LogExportDialog.svelte';
  import LogContextPanel from './LogContextPanel.svelte';
  import LogFieldBrowser from './LogFieldBrowser.svelte';
  import LogHistogram from './LogHistogram.svelte';
  import LogPatternsList from './LogPatternsList.svelte';
  import TraceList from './TraceList.svelte';
  import { createPatternExtractor, type LogPattern } from '$lib/logPatterns';
  import { createTraceExtractor, type TraceData } from '$lib/traceExtractor';
  import {
    detectLogFieldsWithData,
    LOG_LEVELS,
    type LogFieldMapping,
  } from '$lib/logFieldDetector';
  import {
    TIME_RANGE_PRESETS,
    type TimeRange,
  } from '$lib/logQueryBuilder';

  export let client: ArcClient;

  // Table info
  interface TableInfo {
    database: string;
    table: string;
    displayName: string; // For UI display: database.table
  }

  // State
  let tables: TableInfo[] = [];
  let selectedTable: TableInfo | null = null;
  let isLoadingTables = false;

  let logs: Record<string, unknown>[] = [];
  let columns: string[] = [];
  let fieldMapping: LogFieldMapping = { timestamp: null, level: null, message: null, source: null, traceId: null, spanId: null, parentSpanId: null };
  let isLoadingLogs = false;
  let error: string | null = null;

  let relativeMinutes = 60;
  let selectedLevels: Set<string> = new Set();
  let searchText = '';
  let queryLimit = 1000;

  // Custom time range state
  let showCustomRangePicker = false;
  let customStartDate = '';
  let customEndDate = '';
  let customTimeRangeActive = false;
  let customTimeRange: { start: Date; end: Date } | null = null;

  // Field-specific filters from Field Browser (field -> Set of values)
  let fieldFilters: Map<string, Set<string>> = new Map();

  // Histogram time range selection (absolute time filter)
  let histogramTimeRange: { start: Date; end: Date } | null = null;

  let autoRefresh = false;
  let refreshInterval: ReturnType<typeof setInterval> | null = null;

  let showQueryPreview = false;
  let showExportDialog = false;
  let showContextPanel = false;
  let showFieldBrowser = false;
  let showHistogram = true; // Show histogram by default
  let selectedLogForContext: Record<string, unknown> | null = null;

  // Custom SQL mode
  let customQueryMode = false;
  let customQuery = '';

  // Patterns feature
  let viewMode: 'logs' | 'patterns' | 'traces' = 'logs';
  const patternExtractor = createPatternExtractor();
  let activePatternFilter: LogPattern | null = null;

  // Traces feature
  const traceExtractor = createTraceExtractor();
  let activeTraceFilter: string | null = null;

  // Timezone preference (persisted)
  const TZ_STORAGE_KEY = 'arc_log_explorer_timezone';
  let useUtcTimezone = false;

  // Load timezone preference on mount
  try {
    useUtcTimezone = localStorage.getItem(TZ_STORAGE_KEY) === 'utc';
  } catch {
    // localStorage not available
  }

  function toggleTimezone() {
    useUtcTimezone = !useUtcTimezone;
    try {
      localStorage.setItem(TZ_STORAGE_KEY, useUtcTimezone ? 'utc' : 'local');
    } catch {
      // localStorage not available
    }
  }

  // Build query based on current state (uses table name only, database via header)
  function buildQuery(tableName: string): string {
    if (!tableName) {
      return '';
    }

    const conditions: string[] = [];

    // Time range condition - only if timestamp field is detected
    if (fieldMapping.timestamp) {
      if (histogramTimeRange) {
        // Use absolute time range from histogram selection (highest priority)
        const startISO = histogramTimeRange.start.toISOString();
        const endISO = histogramTimeRange.end.toISOString();
        conditions.push(`${fieldMapping.timestamp} >= '${startISO}'`);
        conditions.push(`${fieldMapping.timestamp} <= '${endISO}'`);
      } else if (customTimeRangeActive && customTimeRange) {
        // Use custom absolute time range
        const startISO = customTimeRange.start.toISOString();
        const endISO = customTimeRange.end.toISOString();
        conditions.push(`${fieldMapping.timestamp} >= '${startISO}'`);
        conditions.push(`${fieldMapping.timestamp} <= '${endISO}'`);
      } else {
        // Use relative time range
        conditions.push(`${fieldMapping.timestamp} >= NOW() - INTERVAL '${relativeMinutes} minutes'`);
      }
    }

    // Level filter
    if (selectedLevels.size > 0 && fieldMapping.level) {
      const levelValues = Array.from(selectedLevels).map(l => `'${l}'`).join(', ');
      conditions.push(`UPPER(${fieldMapping.level}) IN (${levelValues})`);
    }

    // Field-specific filters from Field Browser
    for (const [field, values] of fieldFilters) {
      if (values.size > 0) {
        const escapedValues = Array.from(values).map(v => `'${v.replace(/'/g, "''")}'`).join(', ');
        conditions.push(`${field} IN (${escapedValues})`);
      }
    }

    // Text search
    if (searchText.trim() && fieldMapping.message) {
      const escapedSearch = searchText.trim().replace(/'/g, "''");
      conditions.push(`${fieldMapping.message} ILIKE '%${escapedSearch}%'`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = fieldMapping.timestamp ? `ORDER BY ${fieldMapping.timestamp} DESC` : '';

    // Query uses just table name; database is passed via x-arc-database header
    return `SELECT * FROM ${tableName} ${whereClause} ${orderBy} LIMIT ${queryLimit}`;
  }

  $: currentQuery = selectedTable ? buildQuery(selectedTable.table) : '';

  // Pattern extraction (memoized)
  $: patterns = logs.length > 0 && fieldMapping.message
    ? patternExtractor.extract(logs, fieldMapping)
    : [];

  // Trace extraction (memoized)
  $: traces = logs.length > 0 && fieldMapping.traceId
    ? traceExtractor.extract(logs, fieldMapping)
    : [];

  // Filter logs by active trace or pattern
  $: displayLogs = activeTraceFilter && fieldMapping.traceId
    ? logs.filter(log => log[fieldMapping.traceId!] === activeTraceFilter)
    : activePatternFilter
      ? logs.filter((_, i) => activePatternFilter!.matchingLogIndices.includes(i))
      : logs;

  // LocalStorage key for persisting selection
  const STORAGE_KEY = 'arc_log_explorer_last_table';

  // Persist selected table
  $: if (selectedTable) {
    try {
      localStorage.setItem(STORAGE_KEY, selectedTable.displayName);
    } catch {
      // localStorage might not be available
    }
  }

  // Fetch tables on mount
  onMount(async () => {
    await fetchTables();
  });

  onDestroy(() => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
  });

  async function fetchTables() {
    try {
      isLoadingTables = true;
      error = null;
      tables = [];

      // Get list of databases
      const dbResult = await client.query('SHOW DATABASES;');
      const dbNames = dbResult.rows.map(row => row[0] as string);

      // For each database, get tables
      for (const db of dbNames) {
        try {
          const tableResult = await client.query(`SHOW TABLES FROM ${db};`);
          // SHOW TABLES returns: [database, table_name, path, ...]
          for (const row of tableResult.rows) {
            const tableName = row[1] as string;
            tables.push({
              database: db,
              table: tableName,
              displayName: `${db}.${tableName}`,
            });
          }
        } catch {
          // Skip databases we can't access
        }
      }

      tables = tables; // Trigger reactivity

      // Try to restore last selected table from localStorage
      if (tables.length > 0 && !selectedTable) {
        let lastTableName: string | null = null;
        try {
          lastTableName = localStorage.getItem(STORAGE_KEY);
        } catch {
          // localStorage might not be available
        }

        // Find the last selected table or default to first
        const lastTable = lastTableName
          ? tables.find(t => t.displayName === lastTableName)
          : null;

        selectedTable = lastTable || tables[0];
        await fetchLogs();
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to fetch tables';
    } finally {
      isLoadingTables = false;
    }
  }

  async function fetchLogs() {
    if (!selectedTable) return;

    try {
      isLoadingLogs = true;
      error = null;

      const { database, table } = selectedTable;

      // First, fetch a sample to detect fields
      // Try with x-arc-database header first, fallback to database.table syntax
      let sampleResult;
      try {
        sampleResult = await client.query(`SELECT * FROM ${table} LIMIT 1`, database);
      } catch {
        // Fallback to database.table syntax for backwards compatibility
        sampleResult = await client.query(`SELECT * FROM ${database}.${table} LIMIT 1`);
      }

      if (sampleResult.columns) {
        columns = sampleResult.columns;
        // Use enhanced detection with sample data for better field matching
        const sampleRow = sampleResult.rows?.[0] || [];
        fieldMapping = detectLogFieldsWithData(columns, sampleRow);
      }

      // Build and execute the filtered query
      const query = buildQuery(table);
      if (!query) {
        logs = [];
        return;
      }

      let result;
      try {
        // Try with x-arc-database header first (preferred, more performant)
        result = await client.query(query, database);
      } catch {
        // Fallback to database.table syntax
        const fallbackQuery = buildQuery(`${database}.${table}`);
        result = await client.query(fallbackQuery);
      }

      if (result.rows) {
        // IMPORTANT: Use columns from the actual result, not the sample query
        // Column order may differ between queries
        const resultColumns = result.columns || columns;
        logs = result.rows.map(row => {
          const obj: Record<string, unknown> = {};
          resultColumns.forEach((col, idx) => {
            obj[col] = row[idx];
          });
          return obj;
        });
      } else {
        logs = [];
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to fetch logs';
      logs = [];
    } finally {
      isLoadingLogs = false;
    }
  }

  function handleTableChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    const displayName = target.value;
    selectedTable = tables.find(t => t.displayName === displayName) || null;
    // Reset field mapping for new table
    fieldMapping = { timestamp: null, level: null, message: null, source: null, traceId: null, spanId: null, parentSpanId: null };
    fetchLogs();
  }

  function handleTimeRangeChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    const value = Number(target.value);

    if (value === -1) {
      // Custom range selected - show the picker
      showCustomRangePicker = true;
      // Initialize with sensible defaults (last 24 hours)
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      customEndDate = formatDateTimeLocal(now);
      customStartDate = formatDateTimeLocal(yesterday);
    } else {
      // Relative time range selected
      relativeMinutes = value;
      customTimeRangeActive = false;
      customTimeRange = null;
      // Clear histogram selection when changing relative time range
      histogramTimeRange = null;
      fetchLogs();
    }
  }

  function formatDateTimeLocal(date: Date): string {
    // Format as YYYY-MM-DDTHH:mm for datetime-local input
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  function applyCustomTimeRange() {
    if (!customStartDate || !customEndDate) return;

    customTimeRange = {
      start: new Date(customStartDate),
      end: new Date(customEndDate),
    };
    customTimeRangeActive = true;
    histogramTimeRange = null;
    showCustomRangePicker = false;
    fetchLogs();
  }

  function cancelCustomTimeRange() {
    showCustomRangePicker = false;
    // If no custom range was active, reset to the previous relative time
    if (!customTimeRangeActive) {
      // Keep relativeMinutes as is
    }
  }

  function formatCustomRangeDisplay(): string {
    if (!customTimeRange) return '';
    const opts: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    };
    return `${customTimeRange.start.toLocaleString(undefined, opts)} - ${customTimeRange.end.toLocaleString(undefined, opts)}`;
  }

  function handleLevelToggle(level: string) {
    if (selectedLevels.has(level)) {
      selectedLevels.delete(level);
    } else {
      selectedLevels.add(level);
    }
    selectedLevels = selectedLevels; // Trigger reactivity
    fetchLogs();
  }

  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      fetchLogs();
    }
  }

  function clearFilters() {
    selectedLevels = new Set();
    fieldFilters = new Map();
    searchText = '';
    relativeMinutes = 60;
    histogramTimeRange = null;
    customTimeRangeActive = false;
    customTimeRange = null;
    fetchLogs();
  }

  function toggleAutoRefresh() {
    autoRefresh = !autoRefresh;
    if (autoRefresh) {
      refreshInterval = setInterval(fetchLogs, 5000);
    } else if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
  }

  function handleShowContext(event: CustomEvent<{ log: Record<string, unknown>; index: number }>) {
    selectedLogForContext = event.detail.log;
    showContextPanel = true;
  }

  function handleCloseContext() {
    showContextPanel = false;
    selectedLogForContext = null;
  }

  function handleCloseFieldBrowser() {
    showFieldBrowser = false;
  }

  function handleAddFieldFilter(event: CustomEvent<{ field: string; value: string }>) {
    const { field, value } = event.detail;

    // If filtering by level field, use the level filter (toggle)
    if (field === fieldMapping.level) {
      const upperValue = value.toUpperCase();
      // Check if it's a known log level
      const isKnownLevel = LOG_LEVELS.some(l => l.value === upperValue);
      if (isKnownLevel) {
        // Toggle: remove if already selected, add if not
        if (selectedLevels.has(upperValue)) {
          selectedLevels.delete(upperValue);
        } else {
          selectedLevels.add(upperValue);
        }
        selectedLevels = selectedLevels; // Trigger reactivity
        fetchLogs();
        return;
      }
    }

    // For other fields, use field filters (toggle)
    if (!fieldFilters.has(field)) {
      fieldFilters.set(field, new Set());
    }
    const values = fieldFilters.get(field)!;

    // Toggle: remove if already filtered, add if not
    if (values.has(value)) {
      values.delete(value);
      if (values.size === 0) {
        fieldFilters.delete(field);
      }
    } else {
      values.add(value);
    }
    fieldFilters = fieldFilters; // Trigger reactivity
    fetchLogs();
  }

  function handleHistogramTimeRangeSelect(event: CustomEvent<{ start: Date; end: Date } | null>) {
    histogramTimeRange = event.detail;
    fetchLogs();
  }

  function handleFilterByPattern(event: CustomEvent<{ pattern: LogPattern }>) {
    activePatternFilter = event.detail.pattern;
    viewMode = 'logs'; // Switch to logs to see filtered results
  }

  function toggleCustomQueryMode() {
    customQueryMode = !customQueryMode;
    showQueryPreview = customQueryMode; // Show query panel when in custom mode
    if (customQueryMode) {
      // Initialize custom query with current query
      customQuery = currentQuery;
    }
  }

  function exitCustomQueryMode() {
    customQueryMode = false;
    customQuery = '';
    fetchLogs(); // Re-fetch with normal query
  }

  async function runCustomQuery() {
    if (!customQuery.trim() || !selectedTable) return;

    try {
      isLoadingLogs = true;
      error = null;

      const { database } = selectedTable;

      let result;
      try {
        result = await client.query(customQuery.trim(), database);
      } catch {
        // Try without database header as fallback
        result = await client.query(customQuery.trim());
      }

      if (result.columns) {
        columns = result.columns;
        // Re-detect field mapping for custom query results
        const sampleRow = result.rows?.[0] || [];
        fieldMapping = detectLogFieldsWithData(columns, sampleRow);
      }

      if (result.rows) {
        const resultColumns = result.columns || columns;
        logs = result.rows.map(row => {
          const obj: Record<string, unknown> = {};
          resultColumns.forEach((col, idx) => {
            obj[col] = row[idx];
          });
          return obj;
        });
      } else {
        logs = [];
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to execute query';
      logs = [];
    } finally {
      isLoadingLogs = false;
    }
  }

  function handleCustomQueryKeydown(event: KeyboardEvent) {
    // Cmd/Ctrl + Enter to run query
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      runCustomQuery();
    }
  }
</script>

<div class="flex h-full flex-col">
  <!-- Header -->
  <div class="border-b bg-muted/30 px-4 py-3">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-lg font-semibold">Log Explorer</h2>
        <p class="text-sm text-muted-foreground">Query and visualize log data</p>
      </div>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          on:click={() => (showHistogram = !showHistogram)}
          class={cn(showHistogram && 'bg-primary text-primary-foreground')}
          disabled={!fieldMapping.timestamp}
        >
          <BarChart3 class="mr-2 h-4 w-4" />
          Chart
        </Button>
        <Button
          variant="outline"
          size="sm"
          on:click={() => (showFieldBrowser = !showFieldBrowser)}
          class={cn(showFieldBrowser && 'bg-primary text-primary-foreground')}
          disabled={columns.length === 0}
        >
          <Columns class="mr-2 h-4 w-4" />
          Fields
        </Button>
        <Button
          variant="outline"
          size="sm"
          on:click={() => (viewMode = viewMode === 'patterns' ? 'logs' : 'patterns')}
          class={cn(viewMode === 'patterns' && 'bg-primary text-primary-foreground')}
          disabled={logs.length === 0 || !fieldMapping.message}
          title={!fieldMapping.message ? 'No message field detected' : undefined}
        >
          <Layers2 class="mr-2 h-4 w-4" />
          Patterns
        </Button>
        <Button
          variant="outline"
          size="sm"
          on:click={() => (viewMode = viewMode === 'traces' ? 'logs' : 'traces')}
          class={cn(viewMode === 'traces' && 'bg-primary text-primary-foreground')}
          disabled={logs.length === 0 || !fieldMapping.traceId}
          title={!fieldMapping.traceId ? 'No trace_id field detected' : undefined}
        >
          <Route class="mr-2 h-4 w-4" />
          Traces
        </Button>
        <Button
          variant="outline"
          size="sm"
          on:click={() => (showExportDialog = true)}
          disabled={logs.length === 0}
        >
          <Download class="mr-2 h-4 w-4" />
          Export
        </Button>
        <Button
          variant="outline"
          size="sm"
          on:click={toggleCustomQueryMode}
          class={cn(customQueryMode && 'bg-primary text-primary-foreground')}
        >
          <Code class="mr-2 h-4 w-4" />
          SQL
        </Button>
        <Button
          variant="outline"
          size="sm"
          on:click={toggleTimezone}
          title={useUtcTimezone ? 'Showing UTC time - click for local' : 'Showing local time - click for UTC'}
        >
          <Globe class="mr-2 h-4 w-4" />
          {useUtcTimezone ? 'UTC' : 'Local'}
        </Button>
      </div>
    </div>
  </div>

  <!-- Toolbar -->
  <div class="flex flex-wrap items-center gap-3 border-b px-4 py-3">
    {#if customQueryMode}
      <!-- Custom Query Mode Indicator -->
      <div class="flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-sm">
        <Code class="h-4 w-4" />
        <span>Custom SQL Mode</span>
      </div>
      <span class="text-xs text-muted-foreground">Filters disabled while using custom query</span>
    {:else}
      <!-- Table Selector -->
      <div class="flex items-center gap-2">
        <Database class="h-4 w-4 text-muted-foreground" />
        <select
          class="h-9 min-w-[200px] rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          value={selectedTable?.displayName || ''}
          on:change={handleTableChange}
          disabled={isLoadingTables}
        >
          {#if isLoadingTables}
            <option value="">Loading tables...</option>
          {:else if tables.length === 0}
            <option value="">No tables found</option>
          {:else}
            {#each tables as t}
              <option value={t.displayName}>{t.displayName}</option>
            {/each}
          {/if}
        </select>
      </div>

      <!-- Time Range -->
      <div class="flex items-center gap-2">
        {#if customTimeRangeActive && customTimeRange}
          <button
            class="flex items-center gap-2 h-9 rounded-md border border-primary bg-primary/10 px-3 py-1 text-sm text-primary hover:bg-primary/20 transition-colors"
            on:click={() => { showCustomRangePicker = true; }}
            title="Click to modify custom range"
          >
            <Calendar class="h-4 w-4" />
            <span class="max-w-[250px] truncate">{formatCustomRangeDisplay()}</span>
          </button>
          <button
            class="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            on:click={() => {
              customTimeRangeActive = false;
              customTimeRange = null;
              relativeMinutes = 60;
              fetchLogs();
            }}
            title="Clear custom range"
          >
            <X class="h-4 w-4" />
          </button>
        {:else}
          <select
            class="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            value={relativeMinutes}
            on:change={handleTimeRangeChange}
          >
            {#each TIME_RANGE_PRESETS as preset}
              <option value={preset.value}>{preset.label}</option>
            {/each}
          </select>
        {/if}
      </div>

    <!-- Level Filters -->
    <div class="flex items-center gap-1">
      <Filter class="h-4 w-4 text-muted-foreground" />
      {#each LOG_LEVELS as level}
        <button
          class={cn(
            'rounded-md px-2 py-1 text-xs font-medium transition-colors',
            selectedLevels.has(level.value)
              ? level.value === 'ERROR'
                ? 'bg-red-500/20 text-red-500'
                : level.value === 'WARN'
                  ? 'bg-yellow-500/20 text-yellow-500'
                  : level.value === 'INFO'
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'bg-neutral-500/20 text-neutral-400'
              : 'bg-muted text-muted-foreground hover:bg-muted/80'
          )}
          on:click={() => handleLevelToggle(level.value)}
        >
          {level.label}
        </button>
      {/each}
    </div>

    <!-- Search -->
    <div class="relative flex-1 min-w-[200px]">
      <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="text"
        placeholder="Search logs..."
        class="pl-9"
        bind:value={searchText}
        on:keydown={handleSearchKeydown}
      />
    </div>

    <!-- Clear Filters -->
    {#if selectedLevels.size > 0 || fieldFilters.size > 0 || searchText || histogramTimeRange || customTimeRangeActive}
      <Button variant="ghost" size="sm" on:click={clearFilters}>
        <X class="mr-1 h-4 w-4" />
        Clear
      </Button>
    {/if}

    <!-- Pattern Filter Indicator -->
    {#if activePatternFilter}
      <div class="flex items-center gap-2 px-2 py-1 rounded bg-primary/10 text-primary text-xs">
        <Layers2 class="h-3 w-3" />
        <span class="max-w-[200px] truncate" title={activePatternFilter.template}>
          {activePatternFilter.template}
        </span>
        <button
          on:click={() => { activePatternFilter = null; }}
          class="p-0.5 rounded hover:bg-primary/20"
          title="Clear pattern filter"
        >
          <X class="h-3 w-3" />
        </button>
      </div>
    {/if}

    <!-- Trace Filter Indicator -->
    {#if activeTraceFilter}
      <div class="flex items-center gap-2 px-2 py-1 rounded bg-primary/10 text-primary text-xs">
        <Route class="h-3 w-3" />
        <span class="font-mono" title={activeTraceFilter}>
          Trace: {activeTraceFilter.slice(0, 8)}...
        </span>
        <button
          on:click={() => { activeTraceFilter = null; }}
          class="p-0.5 rounded hover:bg-primary/20"
          title="Clear trace filter"
        >
          <X class="h-3 w-3" />
        </button>
      </div>
    {/if}

    <!-- Auto Refresh -->
    <Button variant="outline" size="sm" on:click={toggleAutoRefresh}>
      {#if autoRefresh}
        <Pause class="mr-2 h-4 w-4" />
        Pause
      {:else}
        <Play class="mr-2 h-4 w-4" />
        Live
      {/if}
    </Button>

    <!-- Refresh -->
    <Button variant="outline" size="icon" on:click={customQueryMode ? runCustomQuery : fetchLogs} disabled={isLoadingLogs}>
      <RefreshCw class={cn('h-4 w-4', isLoadingLogs && 'animate-spin')} />
    </Button>
    {/if}
  </div>

  <!-- Query Editor / Preview -->
  {#if showQueryPreview}
    <div class="border-b bg-muted/20 px-4 py-3">
      {#if customQueryMode}
        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-xs text-muted-foreground">
              <Code class="h-3 w-3" />
              <span>Custom SQL Query</span>
              <span class="text-muted-foreground/60">·</span>
              <kbd class="px-1.5 py-0.5 rounded bg-muted text-[10px]">⌘ Enter</kbd>
              <span class="text-muted-foreground/60">to run</span>
            </div>
            <div class="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                on:click={exitCustomQueryMode}
              >
                <X class="mr-1 h-3 w-3" />
                Exit
              </Button>
              <Button
                size="sm"
                on:click={runCustomQuery}
                disabled={isLoadingLogs || !customQuery.trim()}
              >
                {#if isLoadingLogs}
                  <RefreshCw class="mr-2 h-3 w-3 animate-spin" />
                {:else}
                  <Play class="mr-2 h-3 w-3" />
                {/if}
                Run
              </Button>
            </div>
          </div>
          <textarea
            bind:value={customQuery}
            on:keydown={handleCustomQueryKeydown}
            class="w-full min-h-[100px] rounded bg-muted p-3 text-xs font-mono resize-y focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="SELECT * FROM table WHERE ..."
            spellcheck="false"
          />
        </div>
      {:else if currentQuery}
        <pre class="overflow-x-auto rounded bg-muted p-3 text-xs font-mono">{currentQuery}</pre>
      {/if}
    </div>
  {/if}

  <!-- Histogram -->
  {#if showHistogram && selectedTable && fieldMapping.timestamp}
    <LogHistogram
      {client}
      database={selectedTable.database}
      table={selectedTable.table}
      {fieldMapping}
      {relativeMinutes}
      clientSideMode={customQueryMode}
      logs={customQueryMode ? logs : null}
      on:timeRangeSelect={handleHistogramTimeRangeSelect}
    />
  {/if}

  <!-- Content -->
  <div class="flex-1 overflow-hidden flex">
    {#if showFieldBrowser && selectedTable}
      <div class="w-[280px] shrink-0 border-r">
        <LogFieldBrowser
          {client}
          database={selectedTable.database}
          table={selectedTable.table}
          {columns}
          {fieldMapping}
          {selectedLevels}
          {fieldFilters}
          on:close={handleCloseFieldBrowser}
          on:addFilter={handleAddFieldFilter}
        />
      </div>
    {/if}

    <div class={cn('flex-1 overflow-hidden', showContextPanel && 'border-r')}>
      {#if error}
        <div class="p-4 text-destructive">{error}</div>
      {:else if isLoadingLogs && logs.length === 0}
        <div class="flex h-full items-center justify-center text-muted-foreground">
          <RefreshCw class="mr-2 h-4 w-4 animate-spin" />
          Loading logs...
        </div>
      {:else if logs.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <Database class="h-8 w-8" />
          <p>No logs found</p>
          <p class="text-xs">Try adjusting your filters or time range</p>
        </div>
      {:else if viewMode === 'traces'}
        <TraceList
          {traces}
          on:filterByTrace={(e) => {
            activeTraceFilter = e.detail.traceId;
            viewMode = 'logs';
          }}
        />
      {:else if viewMode === 'patterns'}
        <LogPatternsList
          {patterns}
          totalLogs={logs.length}
          on:filterByPattern={handleFilterByPattern}
        />
      {:else}
        <VirtualLogList logs={displayLogs} {fieldMapping} {columns} autoScroll={autoRefresh} useUtc={useUtcTimezone} on:showContext={handleShowContext} />
      {/if}
    </div>

    {#if showContextPanel && selectedTable}
      <div class="w-[400px] shrink-0">
        <LogContextPanel
          {client}
          selectedLog={selectedLogForContext}
          {fieldMapping}
          database={selectedTable.database}
          table={selectedTable.table}
          on:close={handleCloseContext}
        />
      </div>
    {/if}
  </div>

  <!-- Footer -->
  <div class="border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground flex items-center justify-between">
    <span>
      {#if viewMode === 'traces'}
        {traces.length} trace{traces.length !== 1 ? 's' : ''} from {logs.length} log{logs.length !== 1 ? 's' : ''}
      {:else if viewMode === 'patterns'}
        {patterns.length} pattern{patterns.length !== 1 ? 's' : ''} detected from {logs.length} log{logs.length !== 1 ? 's' : ''}
      {:else}
        Showing {displayLogs.length} log{displayLogs.length !== 1 ? 's' : ''}
        {#if activePatternFilter}
          (filtered by pattern)
        {/if}
        {#if activeTraceFilter}
          (filtered by trace)
        {/if}
      {/if}
      {#if histogramTimeRange}
        · Time: {histogramTimeRange.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - {histogramTimeRange.end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      {/if}
      {#if selectedLevels.size > 0}
        · Levels: {Array.from(selectedLevels).join(', ')}
      {/if}
    </span>
    {#if autoRefresh}
      <span class="flex items-center gap-1">
        <span class="h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
        Live updates
      </span>
    {/if}
  </div>
</div>

<!-- Export Dialog -->
<LogExportDialog bind:open={showExportDialog} {logs} {columns} />

<!-- Custom Time Range Picker Modal -->
{#if showCustomRangePicker}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" on:click|self={cancelCustomTimeRange}>
    <div class="bg-background rounded-lg shadow-xl border p-6 w-[400px] max-w-[90vw]">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-semibold flex items-center gap-2">
          <Calendar class="h-5 w-5" />
          Custom Time Range
        </h3>
        <button
          class="p-1 rounded hover:bg-muted"
          on:click={cancelCustomTimeRange}
        >
          <X class="h-4 w-4" />
        </button>
      </div>

      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium mb-1.5" for="custom-start">
            Start Date & Time
          </label>
          <input
            id="custom-start"
            type="datetime-local"
            bind:value={customStartDate}
            class="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          />
        </div>

        <div>
          <label class="block text-sm font-medium mb-1.5" for="custom-end">
            End Date & Time
          </label>
          <input
            id="custom-end"
            type="datetime-local"
            bind:value={customEndDate}
            class="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          />
        </div>

        <!-- Quick presets -->
        <div class="border-t pt-4">
          <div class="text-xs text-muted-foreground mb-2">Quick presets:</div>
          <div class="flex flex-wrap gap-2">
            {#each [
              { label: 'Today', days: 0 },
              { label: 'Yesterday', days: 1 },
              { label: 'Last 7 days', days: 7 },
              { label: 'Last 30 days', days: 30 },
              { label: 'Last 90 days', days: 90 },
            ] as preset}
              <button
                class="px-2 py-1 text-xs rounded bg-muted hover:bg-muted/80 transition-colors"
                on:click={() => {
                  const now = new Date();
                  const end = new Date(now);
                  end.setHours(23, 59, 59, 999);

                  const start = new Date(now);
                  if (preset.days === 0) {
                    start.setHours(0, 0, 0, 0);
                  } else if (preset.days === 1) {
                    start.setDate(start.getDate() - 1);
                    start.setHours(0, 0, 0, 0);
                    end.setDate(end.getDate() - 1);
                  } else {
                    start.setDate(start.getDate() - preset.days);
                    start.setHours(0, 0, 0, 0);
                  }

                  customStartDate = formatDateTimeLocal(start);
                  customEndDate = formatDateTimeLocal(end);
                }}
              >
                {preset.label}
              </button>
            {/each}
          </div>
        </div>
      </div>

      <div class="flex justify-end gap-2 mt-6">
        <Button variant="outline" on:click={cancelCustomTimeRange}>
          Cancel
        </Button>
        <Button
          on:click={applyCustomTimeRange}
          disabled={!customStartDate || !customEndDate}
        >
          Apply Range
        </Button>
      </div>
    </div>
  </div>
{/if}
