<script lang="ts">
  import { onMount } from 'svelte';
  import type { ArcClient, RetentionPolicy, RetentionExecution, RetentionExecuteResult, CreateRetentionPolicy } from '$lib/arcClient';
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
    RefreshCw,
    ChevronDown,
    ChevronRight,
    CheckCircle,
    XCircle,
    Clock,
    AlertCircle,
    Database,
    Table2
  } from 'lucide-svelte';
  import PolicyExecutionHistory from './PolicyExecutionHistory.svelte';

  export let client: ArcClient;

  let policies: RetentionPolicy[] = [];
  let isLoading = true;
  let error: string | null = null;
  let isFeatureDisabled = false;

  // Dialog state
  let showCreateDialog = false;
  let showDeleteDialog = false;
  let showExecuteDialog = false;
  let editingPolicy: RetentionPolicy | null = null;
  let deletingPolicy: RetentionPolicy | null = null;
  let executingPolicy: RetentionPolicy | null = null;

  // Form state
  let formName = '';
  let formDatabase = '';
  let formMeasurement = '';
  let formRetentionDays = 30;
  let formBufferDays = 7;
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
  let expandedPolicyId: number | null = null;

  // Dry-run result
  let dryRunResult: RetentionExecuteResult | null = null;

  onMount(() => {
    loadPolicies();
  });

  async function loadPolicies() {
    isLoading = true;
    error = null;
    isFeatureDisabled = false;
    try {
      policies = await client.getRetentionPolicies() || [];
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to load retention policies';
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
    editingPolicy = null;
    formName = '';
    formDatabase = '';
    formMeasurement = '';
    formRetentionDays = 30;
    formBufferDays = 7;
    formIsActive = true;
    formError = '';
    showCreateDialog = true;
    loadDatabases();
  }

  function openEditDialog(policy: RetentionPolicy) {
    editingPolicy = policy;
    formName = policy.name;
    formDatabase = policy.database;
    formMeasurement = policy.measurement || '';
    formRetentionDays = policy.retention_days;
    formBufferDays = policy.buffer_days;
    formIsActive = policy.is_active;
    formError = '';
    showCreateDialog = true;
    loadDatabases();
    if (policy.database) {
      loadMeasurements(policy.database);
    }
  }

  function openDeleteDialog(policy: RetentionPolicy) {
    deletingPolicy = policy;
    showDeleteDialog = true;
  }

  async function openExecuteDialog(policy: RetentionPolicy) {
    executingPolicy = policy;
    dryRunResult = null;
    showExecuteDialog = true;

    // Run dry-run immediately
    isExecuting = true;
    try {
      dryRunResult = await client.executeRetentionPolicy(policy.id, true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to run dry-run');
    } finally {
      isExecuting = false;
    }
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
    if (formRetentionDays < 1) {
      formError = 'Retention days must be at least 1';
      return;
    }

    isSaving = true;
    formError = '';

    try {
      const policyData: CreateRetentionPolicy = {
        name: formName.trim(),
        database: formDatabase,
        retention_days: Number(formRetentionDays),
        buffer_days: Number(formBufferDays),
        is_active: formIsActive
      };

      if (formMeasurement) {
        policyData.measurement = formMeasurement;
      }

      if (editingPolicy) {
        await client.updateRetentionPolicy(editingPolicy.id, policyData);
        toast.success('Retention policy updated');
      } else {
        await client.createRetentionPolicy(policyData);
        toast.success('Retention policy created');
      }

      showCreateDialog = false;
      loadPolicies();
    } catch (err) {
      formError = err instanceof Error ? err.message : 'Failed to save policy';
    } finally {
      isSaving = false;
    }
  }

  async function handleDelete() {
    if (!deletingPolicy) return;

    isDeleting = true;
    try {
      await client.deleteRetentionPolicy(deletingPolicy.id);
      toast.success('Retention policy deleted');
      showDeleteDialog = false;
      deletingPolicy = null;
      loadPolicies();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete policy');
    } finally {
      isDeleting = false;
    }
  }

  async function handleExecute() {
    if (!executingPolicy) return;

    isExecuting = true;
    try {
      const result = await client.executeRetentionPolicy(executingPolicy.id, false);
      toast.success(`Deleted ${result.deleted_count} records from ${result.files_deleted} files`);
      showExecuteDialog = false;
      executingPolicy = null;
      dryRunResult = null;
      loadPolicies();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to execute policy');
    } finally {
      isExecuting = false;
    }
  }

  async function togglePolicyActive(policy: RetentionPolicy) {
    try {
      await client.updateRetentionPolicy(policy.id, { is_active: !policy.is_active });
      toast.success(policy.is_active ? 'Policy paused' : 'Policy activated');
      loadPolicies();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update policy');
    }
  }

  function toggleExpanded(policyId: number) {
    expandedPolicyId = expandedPolicyId === policyId ? null : policyId;
  }

  function formatDate(dateStr: string | null | undefined): string {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString();
  }

  function handleDatabaseChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    formDatabase = select.value;
    formMeasurement = '';
    loadMeasurements(select.value);
  }
</script>

<div class="flex h-full flex-col">
  <!-- Header -->
  <div class="flex items-center justify-between border-b bg-muted/30 px-6 py-4">
    <div>
      <h2 class="text-lg font-semibold">Retention Policies</h2>
      <p class="text-sm text-muted-foreground">Configure automatic data retention rules</p>
    </div>
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" on:click={loadPolicies} disabled={isLoading}>
        <RefreshCw class={cn('mr-2 h-4 w-4', isLoading && 'animate-spin')} />
        Refresh
      </Button>
      <Button size="sm" on:click={openCreateDialog}>
        <Plus class="mr-2 h-4 w-4" />
        Create Policy
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
        <Clock class="h-12 w-12 text-muted-foreground/30" />
        <div>
          <p class="text-lg font-medium">Retention Policies Not Available</p>
          <p class="mt-2 text-sm text-muted-foreground max-w-md">
            This feature is not enabled on your Arc server. To enable retention policies,
            add the following to your Arc configuration:
          </p>
          <pre class="mt-4 rounded-md bg-muted p-4 text-left text-xs font-mono">retention:
  enabled: true</pre>
          <p class="mt-4 text-xs text-muted-foreground">
            After updating the configuration, restart the Arc server.
          </p>
        </div>
        <Button variant="outline" on:click={loadPolicies}>
          <RefreshCw class="mr-2 h-4 w-4" />
          Check Again
        </Button>
      </div>
    {:else if error}
      <div class="flex flex-col items-center justify-center gap-4 py-12">
        <AlertCircle class="h-12 w-12 text-destructive" />
        <p class="text-destructive">{error}</p>
        <Button variant="outline" on:click={loadPolicies}>Try Again</Button>
      </div>
    {:else if policies.length === 0}
      <div class="flex flex-col items-center justify-center gap-4 py-12 text-center">
        <Clock class="h-12 w-12 text-muted-foreground/50" />
        <div>
          <p class="text-lg font-medium">No retention policies</p>
          <p class="text-sm text-muted-foreground">Create a policy to automatically clean up old data</p>
        </div>
        <Button on:click={openCreateDialog}>
          <Plus class="mr-2 h-4 w-4" />
          Create Policy
        </Button>
      </div>
    {:else}
      <div class="space-y-3">
        {#each policies as policy (policy.id)}
          <div class="rounded-lg border bg-card">
            <!-- Policy Row -->
            <button
              class="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
              on:click={() => toggleExpanded(policy.id)}
            >
              <div class="flex-shrink-0">
                {#if expandedPolicyId === policy.id}
                  <ChevronDown class="h-4 w-4 text-muted-foreground" />
                {:else}
                  <ChevronRight class="h-4 w-4 text-muted-foreground" />
                {/if}
              </div>

              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="font-medium">{policy.name}</span>
                  <Badge variant={policy.is_active ? 'default' : 'secondary'}>
                    {policy.is_active ? 'Active' : 'Paused'}
                  </Badge>
                </div>
                <div class="mt-1 flex items-center gap-4 text-sm text-muted-foreground">
                  <span class="flex items-center gap-1">
                    <Database class="h-3.5 w-3.5" />
                    {policy.database}
                  </span>
                  <span class="flex items-center gap-1">
                    <Table2 class="h-3.5 w-3.5" />
                    {policy.measurement || 'All tables'}
                  </span>
                  <span>{policy.retention_days} days retention</span>
                </div>
              </div>

              <div class="flex items-center gap-2 text-sm text-muted-foreground">
                {#if policy.last_execution_status === 'success'}
                  <CheckCircle class="h-4 w-4 text-green-500" />
                {:else if policy.last_execution_status === 'error'}
                  <XCircle class="h-4 w-4 text-destructive" />
                {:else}
                  <Clock class="h-4 w-4" />
                {/if}
                <span>{formatDate(policy.last_execution_time)}</span>
              </div>
            </button>

            <!-- Expanded Details -->
            {#if expandedPolicyId === policy.id}
              <div class="border-t bg-muted/30 px-4 py-4">
                <div class="mb-4 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                  <div>
                    <p class="text-muted-foreground">Retention Period</p>
                    <p class="font-medium">{policy.retention_days} days</p>
                  </div>
                  <div>
                    <p class="text-muted-foreground">Buffer Period</p>
                    <p class="font-medium">{policy.buffer_days} days</p>
                  </div>
                  <div>
                    <p class="text-muted-foreground">Last Execution</p>
                    <p class="font-medium">{formatDate(policy.last_execution_time)}</p>
                  </div>
                  <div>
                    <p class="text-muted-foreground">Last Deleted</p>
                    <p class="font-medium">{policy.last_deleted_count ?? 'N/A'} records</p>
                  </div>
                </div>

                <div class="flex items-center gap-2">
                  <Button variant="outline" size="sm" on:click={() => openEditDialog(policy)}>
                    <Pencil class="mr-2 h-4 w-4" />
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" on:click={() => togglePolicyActive(policy)}>
                    {policy.is_active ? 'Pause' : 'Activate'}
                  </Button>
                  <Button variant="outline" size="sm" on:click={() => openExecuteDialog(policy)}>
                    <Play class="mr-2 h-4 w-4" />
                    Execute Now
                  </Button>
                  <Button variant="outline" size="sm" class="text-destructive hover:text-destructive" on:click={() => openDeleteDialog(policy)}>
                    <Trash2 class="mr-2 h-4 w-4" />
                    Delete
                  </Button>
                </div>

                <!-- Execution History -->
                <div class="mt-4">
                  <PolicyExecutionHistory {client} policyId={policy.id} type="retention" />
                </div>
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
  <Dialog.Content class="sm:max-w-[500px]">
    <Dialog.Header>
      <Dialog.Title>{editingPolicy ? 'Edit Retention Policy' : 'Create Retention Policy'}</Dialog.Title>
      <Dialog.Description>
        Configure a retention policy to automatically delete old data.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4 py-4">
      {#if formError}
        <div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {formError}
        </div>
      {/if}

      <div class="space-y-2">
        <Label for="name">Policy Name</Label>
        <Input
          id="name"
          placeholder="e.g., logs-30d"
          bind:value={formName}
          disabled={!!editingPolicy}
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

      <div class="space-y-2">
        <Label for="measurement">Measurement (optional)</Label>
        <select
          id="measurement"
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
          bind:value={formMeasurement}
          disabled={!formDatabase || loadingMeasurements}
        >
          <option value="">All measurements</option>
          {#each measurements as m}
            <option value={m}>{m}</option>
          {/each}
        </select>
        <p class="text-xs text-muted-foreground">Leave empty to apply to all measurements in the database</p>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-2">
          <Label for="retention_days">Retention Period (days)</Label>
          <Input
            id="retention_days"
            type="number"
            min="1"
            bind:value={formRetentionDays}
          />
        </div>
        <div class="space-y-2">
          <Label for="buffer_days">Buffer Period (days)</Label>
          <Input
            id="buffer_days"
            type="number"
            min="0"
            bind:value={formBufferDays}
          />
          <p class="text-xs text-muted-foreground">Grace period before deletion</p>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <input
          type="checkbox"
          id="is_active"
          bind:checked={formIsActive}
          class="h-4 w-4 rounded border-input"
        />
        <Label for="is_active" class="cursor-pointer">Enable policy immediately</Label>
      </div>
    </div>

    <Dialog.Footer>
      <Button variant="outline" on:click={() => showCreateDialog = false}>Cancel</Button>
      <Button on:click={handleSave} disabled={isSaving}>
        {#if isSaving}
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        {/if}
        {editingPolicy ? 'Update' : 'Create'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- Delete Confirmation Dialog -->
<Dialog.Root bind:open={showDeleteDialog}>
  <Dialog.Content class="sm:max-w-[400px]">
    <Dialog.Header>
      <Dialog.Title>Delete Retention Policy</Dialog.Title>
      <Dialog.Description>
        Are you sure you want to delete "{deletingPolicy?.name}"? This action cannot be undone.
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
      <Dialog.Title>Execute Retention Policy</Dialog.Title>
      <Dialog.Description>
        Review the dry-run results before executing "{executingPolicy?.name}".
      </Dialog.Description>
    </Dialog.Header>

    <div class="py-4">
      {#if isExecuting && !dryRunResult}
        <div class="flex items-center justify-center py-8">
          <Loader2 class="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      {:else if dryRunResult}
        <div class="space-y-4">
          <div class="rounded-lg bg-muted p-4">
            <h4 class="mb-2 font-medium">Dry-Run Results</h4>
            <div class="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p class="text-muted-foreground">Records to delete</p>
                <p class="text-lg font-semibold">{dryRunResult.deleted_count.toLocaleString()}</p>
              </div>
              <div>
                <p class="text-muted-foreground">Files to delete</p>
                <p class="text-lg font-semibold">{dryRunResult.files_deleted}</p>
              </div>
              <div>
                <p class="text-muted-foreground">Cutoff date</p>
                <p class="font-medium">{formatDate(dryRunResult.cutoff_date)}</p>
              </div>
              <div>
                <p class="text-muted-foreground">Affected measurements</p>
                <p class="font-medium">{dryRunResult.affected_measurements?.length || 0}</p>
              </div>
            </div>
          </div>

          {#if dryRunResult.deleted_count > 0}
            <div class="rounded-md bg-yellow-500/10 p-3 text-sm text-yellow-600 dark:text-yellow-400">
              <AlertCircle class="mb-1 inline h-4 w-4" />
              This will permanently delete {dryRunResult.deleted_count.toLocaleString()} records. This action cannot be undone.
            </div>
          {:else}
            <div class="rounded-md bg-green-500/10 p-3 text-sm text-green-600 dark:text-green-400">
              <CheckCircle class="mb-1 inline h-4 w-4" />
              No records match the retention criteria. Nothing will be deleted.
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="outline" on:click={() => { showExecuteDialog = false; dryRunResult = null; }}>Cancel</Button>
      <Button
        variant="destructive"
        on:click={handleExecute}
        disabled={isExecuting || !dryRunResult || dryRunResult.deleted_count === 0}
      >
        {#if isExecuting}
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        {/if}
        Execute
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
