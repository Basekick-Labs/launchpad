<script lang="ts">
  import { onMount } from 'svelte';
  import type { ArcClient, ContinuousQuery, CQExecution, CQExecuteResult, CreateContinuousQuery } from '$lib/arcClient';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import * as Dialog from '$lib/components/ui/dialog';
  import { toast } from 'svelte-sonner';
  import { cn } from '$lib/utils';
  import {
    Plus,
    Pencil,
    Trash2,
    Play,
    Loader2,
    RefreshCcw,
    ChevronDown,
    ChevronRight,
    CheckCircle,
    XCircle,
    Clock,
    AlertCircle,
    Database,
    ArrowRight,
    Code
  } from 'lucide-svelte';
  import PolicyExecutionHistory from './PolicyExecutionHistory.svelte';
  import IntervalInput from './IntervalInput.svelte';

  export let client: ArcClient;

  let queries: ContinuousQuery[] = [];
  let isLoading = true;
  let error: string | null = null;
  let isFeatureDisabled = false;

  // Dialog state
  let showCreateDialog = false;
  let showDeleteDialog = false;
  let showExecuteDialog = false;
  let editingQuery: ContinuousQuery | null = null;
  let deletingQuery: ContinuousQuery | null = null;
  let executingQuery: ContinuousQuery | null = null;

  // Form state
  let formName = '';
  let formDescription = '';
  let formDatabase = '';
  let formSourceMeasurement = '';
  let formDestinationMeasurement = '';
  let formQuery = '';
  let formInterval = '1h';
  let formRetentionDays: number | null = null;
  let formDeleteSourceAfterDays: number | null = null;
  let formIsActive = true;
  let formError = '';
  let isSaving = false;
  let isDeleting = false;
  let isExecuting = false;

  // Database/measurement selection
  let databases: string[] = [];
  let measurements: string[] = [];
  let loadingDatabases = false;
  let loadingMeasurements = false;

  // Expanded rows for details
  let expandedQueryId: number | null = null;

  // Execute dialog state
  let executeStartTime = '';
  let executeEndTime = '';
  let executeDryRun = true;
  let executeResult: CQExecuteResult | null = null;

  onMount(() => {
    loadQueries();
  });

  async function loadQueries() {
    isLoading = true;
    error = null;
    isFeatureDisabled = false;
    try {
      queries = await client.getContinuousQueries() || [];
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to load continuous queries';
      // Check if the error indicates the feature is disabled or endpoint doesn't exist
      if (errorMsg.includes('Cannot GET') || errorMsg.includes('404') || errorMsg.includes('not found')) {
        isFeatureDisabled = true;
        error = null;
      } else if (errorMsg.includes('disabled')) {
        isFeatureDisabled = true;
        error = null;
      } else {
        error = errorMsg;
      }
    } finally {
      isLoading = false;
    }
  }

  async function loadDatabases() {
    loadingDatabases = true;
    try {
      const result = await client.query('SHOW DATABASES;');
      databases = result.rows.map(row => row[0] as string);
    } catch (err) {
      console.error('Failed to load databases:', err);
    } finally {
      loadingDatabases = false;
    }
  }

  async function loadMeasurements(database: string) {
    if (!database) {
      measurements = [];
      return;
    }
    loadingMeasurements = true;
    try {
      const result = await client.query(`SHOW TABLES FROM ${database};`);
      measurements = result.rows.map(row => row[0] as string);
    } catch (err) {
      console.error('Failed to load measurements:', err);
      measurements = [];
    } finally {
      loadingMeasurements = false;
    }
  }

  function openCreateDialog() {
    editingQuery = null;
    formName = '';
    formDescription = '';
    formDatabase = '';
    formSourceMeasurement = '';
    formDestinationMeasurement = '';
    formQuery = `SELECT
  time_bucket('1 hour', time) AS time,
  COUNT(*) AS count,
  AVG(value) AS avg_value
FROM {source}
WHERE time >= '{start_time}' AND time < '{end_time}'
GROUP BY 1
ORDER BY 1`;
    formInterval = '1h';
    formRetentionDays = null;
    formDeleteSourceAfterDays = null;
    formIsActive = true;
    formError = '';
    showCreateDialog = true;
    loadDatabases();
  }

  function openEditDialog(query: ContinuousQuery) {
    editingQuery = query;
    formName = query.name;
    formDescription = query.description || '';
    formDatabase = query.database;
    formSourceMeasurement = query.source_measurement;
    formDestinationMeasurement = query.destination_measurement;
    formQuery = query.query;
    formInterval = query.interval;
    formRetentionDays = query.retention_days || null;
    formDeleteSourceAfterDays = query.delete_source_after_days || null;
    formIsActive = query.is_active;
    formError = '';
    showCreateDialog = true;
    loadDatabases();
    if (query.database) {
      loadMeasurements(query.database);
    }
  }

  function openDeleteDialog(query: ContinuousQuery) {
    deletingQuery = query;
    showDeleteDialog = true;
  }

  function openExecuteDialog(query: ContinuousQuery) {
    executingQuery = query;
    executeResult = null;
    executeDryRun = true;

    // Default to last hour
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    executeEndTime = now.toISOString().slice(0, 16);
    executeStartTime = hourAgo.toISOString().slice(0, 16);

    showExecuteDialog = true;
  }

  function validateQuery(): boolean {
    if (!formQuery.includes('{start_time}')) {
      formError = 'Query must contain {start_time} placeholder';
      return false;
    }
    if (!formQuery.includes('{end_time}')) {
      formError = 'Query must contain {end_time} placeholder';
      return false;
    }
    return true;
  }

  async function handleSave() {
    if (!formName.trim()) {
      formError = 'Name is required';
      return;
    }
    if (!formDatabase) {
      formError = 'Database is required';
      return;
    }
    if (!formSourceMeasurement) {
      formError = 'Source measurement is required';
      return;
    }
    if (!formDestinationMeasurement.trim()) {
      formError = 'Destination measurement is required';
      return;
    }
    if (!formQuery.trim()) {
      formError = 'Query is required';
      return;
    }
    if (!validateQuery()) {
      return;
    }
    if (!formInterval) {
      formError = 'Interval is required';
      return;
    }

    isSaving = true;
    formError = '';

    try {
      const queryData: CreateContinuousQuery = {
        name: formName.trim(),
        database: formDatabase,
        source_measurement: formSourceMeasurement,
        destination_measurement: formDestinationMeasurement.trim(),
        query: formQuery,
        interval: formInterval,
        is_active: formIsActive
      };

      if (formDescription.trim()) {
        queryData.description = formDescription.trim();
      }
      if (formRetentionDays && Number(formRetentionDays) > 0) {
        queryData.retention_days = Number(formRetentionDays);
      }
      if (formDeleteSourceAfterDays && Number(formDeleteSourceAfterDays) > 0) {
        queryData.delete_source_after_days = Number(formDeleteSourceAfterDays);
      }

      if (editingQuery) {
        await client.updateContinuousQuery(editingQuery.id, queryData);
        toast.success('Continuous query updated');
      } else {
        await client.createContinuousQuery(queryData);
        toast.success('Continuous query created');
      }

      showCreateDialog = false;
      loadQueries();
    } catch (err) {
      formError = err instanceof Error ? err.message : 'Failed to save query';
    } finally {
      isSaving = false;
    }
  }

  async function handleDelete() {
    if (!deletingQuery) return;

    isDeleting = true;
    try {
      await client.deleteContinuousQuery(deletingQuery.id);
      toast.success('Continuous query deleted');
      showDeleteDialog = false;
      deletingQuery = null;
      loadQueries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete query');
    } finally {
      isDeleting = false;
    }
  }

  async function handleExecute() {
    if (!executingQuery) return;

    isExecuting = true;
    try {
      executeResult = await client.executeContinuousQuery(executingQuery.id, {
        dry_run: executeDryRun,
        start_time: new Date(executeStartTime).toISOString(),
        end_time: new Date(executeEndTime).toISOString()
      });

      if (!executeDryRun) {
        toast.success(`Wrote ${executeResult.records_written.toLocaleString()} records`);
        showExecuteDialog = false;
        loadQueries();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to execute query');
    } finally {
      isExecuting = false;
    }
  }

  async function toggleQueryActive(query: ContinuousQuery) {
    try {
      await client.updateContinuousQuery(query.id, { is_active: !query.is_active });
      toast.success(query.is_active ? 'Query paused' : 'Query activated');
      loadQueries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update query');
    }
  }

  function toggleExpanded(queryId: number) {
    expandedQueryId = expandedQueryId === queryId ? null : queryId;
  }

  function formatDate(dateStr: string | null | undefined): string {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString();
  }

  function formatInterval(interval: string): string {
    const match = interval.match(/^(\d+)([smhd])$/);
    if (!match) return interval;
    const [, value, unit] = match;
    const units: Record<string, string> = { s: 'sec', m: 'min', h: 'hour', d: 'day' };
    return `${value} ${units[unit]}${parseInt(value) > 1 ? 's' : ''}`;
  }

  function handleDatabaseChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    formDatabase = select.value;
    formSourceMeasurement = '';
    loadMeasurements(select.value);
  }
</script>

<div class="flex h-full flex-col">
  <!-- Header -->
  <div class="flex items-center justify-between border-b bg-muted/30 px-6 py-4">
    <div>
      <h2 class="text-lg font-semibold">Continuous Queries</h2>
      <p class="text-sm text-muted-foreground">Schedule automated data aggregation and rollup queries</p>
    </div>
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" on:click={loadQueries} disabled={isLoading}>
        <RefreshCcw class={cn('mr-2 h-4 w-4', isLoading && 'animate-spin')} />
        Refresh
      </Button>
      <Button size="sm" on:click={openCreateDialog}>
        <Plus class="mr-2 h-4 w-4" />
        Create Query
      </Button>
    </div>
  </div>

  <!-- Content -->
  <div class="flex-1 overflow-auto p-6">
    {#if isLoading}
      <div class="flex items-center justify-center py-12">
        <Loader2 class="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    {:else if isFeatureDisabled}
      <div class="flex flex-col items-center justify-center gap-4 py-12 text-center">
        <RefreshCcw class="h-12 w-12 text-muted-foreground/30" />
        <div>
          <p class="text-lg font-medium">Continuous Queries Not Available</p>
          <p class="mt-2 text-sm text-muted-foreground max-w-md">
            This feature is not enabled on your Arc server. To enable continuous queries,
            add the following to your Arc configuration:
          </p>
          <pre class="mt-4 rounded-md bg-muted p-4 text-left text-xs font-mono">continuous_queries:
  enabled: true</pre>
          <p class="mt-4 text-xs text-muted-foreground">
            After updating the configuration, restart the Arc server.
          </p>
        </div>
        <Button variant="outline" on:click={loadQueries}>
          <RefreshCcw class="mr-2 h-4 w-4" />
          Check Again
        </Button>
      </div>
    {:else if error}
      <div class="flex flex-col items-center justify-center gap-4 py-12">
        <AlertCircle class="h-12 w-12 text-destructive" />
        <p class="text-destructive">{error}</p>
        <Button variant="outline" on:click={loadQueries}>Try Again</Button>
      </div>
    {:else if queries.length === 0}
      <div class="flex flex-col items-center justify-center gap-4 py-12 text-center">
        <RefreshCcw class="h-12 w-12 text-muted-foreground/50" />
        <div>
          <p class="text-lg font-medium">No continuous queries</p>
          <p class="text-sm text-muted-foreground">Create a query to automatically aggregate data on a schedule</p>
        </div>
        <Button on:click={openCreateDialog}>
          <Plus class="mr-2 h-4 w-4" />
          Create Query
        </Button>
      </div>
    {:else}
      <div class="space-y-3">
        {#each queries as query (query.id)}
          <div class="rounded-lg border bg-card">
            <!-- Query Row -->
            <button
              class="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
              on:click={() => toggleExpanded(query.id)}
            >
              <div class="flex-shrink-0">
                {#if expandedQueryId === query.id}
                  <ChevronDown class="h-4 w-4 text-muted-foreground" />
                {:else}
                  <ChevronRight class="h-4 w-4 text-muted-foreground" />
                {/if}
              </div>

              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="font-medium">{query.name}</span>
                  <Badge variant={query.is_active ? 'default' : 'secondary'}>
                    {query.is_active ? 'Active' : 'Paused'}
                  </Badge>
                </div>
                <div class="mt-1 flex items-center gap-4 text-sm text-muted-foreground">
                  <span class="flex items-center gap-1">
                    <Database class="h-3.5 w-3.5" />
                    {query.database}
                  </span>
                  <span class="flex items-center gap-1">
                    {query.source_measurement}
                    <ArrowRight class="h-3 w-3" />
                    {query.destination_measurement}
                  </span>
                  <span class="flex items-center gap-1">
                    <Clock class="h-3.5 w-3.5" />
                    {formatInterval(query.interval)}
                  </span>
                </div>
              </div>

              <div class="flex items-center gap-2 text-sm text-muted-foreground">
                {#if query.last_execution_status === 'success'}
                  <CheckCircle class="h-4 w-4 text-green-500" />
                {:else if query.last_execution_status === 'error'}
                  <XCircle class="h-4 w-4 text-destructive" />
                {:else}
                  <Clock class="h-4 w-4" />
                {/if}
                <span>{formatDate(query.last_execution_time)}</span>
              </div>
            </button>

            <!-- Expanded Details -->
            {#if expandedQueryId === query.id}
              <div class="border-t bg-muted/30 px-4 py-4">
                {#if query.description}
                  <p class="mb-4 text-sm text-muted-foreground">{query.description}</p>
                {/if}

                <div class="mb-4">
                  <p class="mb-2 text-sm font-medium">SQL Query</p>
                  <pre class="overflow-x-auto rounded-md bg-muted p-3 text-xs">{query.query}</pre>
                </div>

                <div class="mb-4 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                  <div>
                    <p class="text-muted-foreground">Interval</p>
                    <p class="font-medium">{formatInterval(query.interval)}</p>
                  </div>
                  <div>
                    <p class="text-muted-foreground">Last Processed</p>
                    <p class="font-medium">{formatDate(query.last_processed_time)}</p>
                  </div>
                  <div>
                    <p class="text-muted-foreground">Last Records Written</p>
                    <p class="font-medium">{query.last_records_written?.toLocaleString() ?? 'N/A'}</p>
                  </div>
                  <div>
                    <p class="text-muted-foreground">Retention</p>
                    <p class="font-medium">{query.retention_days ? `${query.retention_days} days` : 'None'}</p>
                  </div>
                </div>

                <div class="flex items-center gap-2">
                  <Button variant="outline" size="sm" on:click={() => openEditDialog(query)}>
                    <Pencil class="mr-2 h-4 w-4" />
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" on:click={() => toggleQueryActive(query)}>
                    {query.is_active ? 'Pause' : 'Activate'}
                  </Button>
                  <Button variant="outline" size="sm" on:click={() => openExecuteDialog(query)}>
                    <Play class="mr-2 h-4 w-4" />
                    Execute Now
                  </Button>
                  <Button variant="outline" size="sm" class="text-destructive hover:text-destructive" on:click={() => openDeleteDialog(query)}>
                    <Trash2 class="mr-2 h-4 w-4" />
                    Delete
                  </Button>
                </div>

                <!-- Execution History -->
                <PolicyExecutionHistory {client} policyId={query.id} type="cq" />
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<!-- Create/Edit Dialog -->
<Dialog.Root bind:open={showCreateDialog}>
  <Dialog.Content class="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>{editingQuery ? 'Edit Continuous Query' : 'Create Continuous Query'}</Dialog.Title>
      <Dialog.Description>
        Configure an automated query to aggregate data on a schedule.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4 py-4">
      {#if formError}
        <div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {formError}
        </div>
      {/if}

      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-2">
          <Label for="name">Query Name</Label>
          <Input
            id="name"
            placeholder="e.g., cpu-hourly-avg"
            bind:value={formName}
            disabled={!!editingQuery}
          />
        </div>
        <div class="space-y-2">
          <Label for="interval">Interval</Label>
          <IntervalInput bind:value={formInterval} />
        </div>
      </div>

      <div class="space-y-2">
        <Label for="description">Description (optional)</Label>
        <Input
          id="description"
          placeholder="Describe what this query does"
          bind:value={formDescription}
        />
      </div>

      <div class="space-y-2">
        <Label for="database">Database</Label>
        <select
          id="database"
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
          value={formDatabase}
          on:change={handleDatabaseChange}
          disabled={loadingDatabases}
        >
          <option value="">Select a database</option>
          {#each databases as db}
            <option value={db}>{db}</option>
          {/each}
        </select>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-2">
          <Label for="source">Source Measurement</Label>
          <select
            id="source"
            class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            bind:value={formSourceMeasurement}
            disabled={!formDatabase || loadingMeasurements}
          >
            <option value="">Select source</option>
            {#each measurements as m}
              <option value={m}>{m}</option>
            {/each}
          </select>
        </div>
        <div class="space-y-2">
          <Label for="destination">Destination Measurement</Label>
          <Input
            id="destination"
            placeholder="e.g., cpu_hourly"
            bind:value={formDestinationMeasurement}
          />
        </div>
      </div>

      <div class="space-y-2">
        <Label for="query">SQL Query</Label>
        <textarea
          id="query"
          class="flex min-h-[150px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder={"SELECT ... FROM source WHERE time >= '{start_time}' AND time < '{end_time}' ..."}
          bind:value={formQuery}
        ></textarea>
        <p class="text-xs text-muted-foreground">
          Query must include <code class="rounded bg-muted px-1">{'{start_time}'}</code> and <code class="rounded bg-muted px-1">{'{end_time}'}</code> placeholders
        </p>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-2">
          <Label for="retention_days">Retention Days (optional)</Label>
          <Input
            id="retention_days"
            type="number"
            min="1"
            placeholder="Keep forever"
            bind:value={formRetentionDays}
          />
          <p class="text-xs text-muted-foreground">Auto-delete aggregated data after N days</p>
        </div>
        <div class="space-y-2">
          <Label for="delete_source">Delete Source After (days, optional)</Label>
          <Input
            id="delete_source"
            type="number"
            min="1"
            placeholder="Keep forever"
            bind:value={formDeleteSourceAfterDays}
          />
          <p class="text-xs text-muted-foreground">Auto-delete source data after aggregation</p>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <input
          type="checkbox"
          id="is_active"
          bind:checked={formIsActive}
          class="h-4 w-4 rounded border-input"
        />
        <Label for="is_active" class="cursor-pointer">Enable query immediately</Label>
      </div>
    </div>

    <Dialog.Footer>
      <Button variant="outline" on:click={() => showCreateDialog = false}>Cancel</Button>
      <Button on:click={handleSave} disabled={isSaving}>
        {#if isSaving}
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        {/if}
        {editingQuery ? 'Update' : 'Create'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- Delete Confirmation Dialog -->
<Dialog.Root bind:open={showDeleteDialog}>
  <Dialog.Content class="sm:max-w-[400px]">
    <Dialog.Header>
      <Dialog.Title>Delete Continuous Query</Dialog.Title>
      <Dialog.Description>
        Are you sure you want to delete "{deletingQuery?.name}"? This action cannot be undone.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" on:click={() => showDeleteDialog = false}>Cancel</Button>
      <Button variant="destructive" on:click={handleDelete} disabled={isDeleting}>
        {#if isDeleting}
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        {/if}
        Delete
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- Execute Dialog -->
<Dialog.Root bind:open={showExecuteDialog}>
  <Dialog.Content class="sm:max-w-[500px]">
    <Dialog.Header>
      <Dialog.Title>Execute Continuous Query</Dialog.Title>
      <Dialog.Description>
        Run "{executingQuery?.name}" for a specific time range.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4 py-4">
      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-2">
          <Label for="start_time">Start Time</Label>
          <Input
            id="start_time"
            type="datetime-local"
            bind:value={executeStartTime}
          />
        </div>
        <div class="space-y-2">
          <Label for="end_time">End Time</Label>
          <Input
            id="end_time"
            type="datetime-local"
            bind:value={executeEndTime}
          />
        </div>
      </div>

      <div class="flex items-center gap-2">
        <input
          type="checkbox"
          id="dry_run"
          bind:checked={executeDryRun}
          class="h-4 w-4 rounded border-input"
        />
        <Label for="dry_run" class="cursor-pointer">Dry run (preview only, no data written)</Label>
      </div>

      {#if executeResult}
        <div class="rounded-lg bg-muted p-4">
          <h4 class="mb-2 font-medium">{executeResult.dry_run ? 'Dry-Run' : 'Execution'} Results</h4>
          <div class="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p class="text-muted-foreground">Records read</p>
              <p class="text-lg font-semibold">{executeResult.records_read.toLocaleString()}</p>
            </div>
            <div>
              <p class="text-muted-foreground">Records written</p>
              <p class="text-lg font-semibold">{executeResult.records_written.toLocaleString()}</p>
            </div>
            <div>
              <p class="text-muted-foreground">Duration</p>
              <p class="font-medium">{executeResult.execution_time_seconds.toFixed(2)}s</p>
            </div>
            <div>
              <p class="text-muted-foreground">Time range</p>
              <p class="font-medium text-xs">{new Date(executeResult.start_time).toLocaleString()} - {new Date(executeResult.end_time).toLocaleString()}</p>
            </div>
          </div>
        </div>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="outline" on:click={() => { showExecuteDialog = false; executeResult = null; }}>
        {executeResult && !executeResult.dry_run ? 'Close' : 'Cancel'}
      </Button>
      <Button on:click={handleExecute} disabled={isExecuting}>
        {#if isExecuting}
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        {/if}
        {executeDryRun ? 'Preview' : 'Execute'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
