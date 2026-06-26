<script lang="ts">
  import { onMount } from 'svelte';
  import { formatIntervalMs } from '$lib/alertManager';
  import type { AlertCondition } from '$lib/alertManager';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import * as Dialog from '$lib/components/ui/dialog';
  import { toast } from 'svelte-sonner';
  import {
    Plus,
    Pencil,
    Trash2,
    Play,
    Loader2,
    RefreshCw,
    ChevronDown,
    ChevronRight,
    Bell,
    BellOff,
    AlertTriangle,
    CheckCircle,
    XCircle,
    Clock,
    Webhook
  } from 'lucide-svelte';
  import IntervalInput from './IntervalInput.svelte';

  export let orgId: string;
  export let instanceId: string;

  interface AlertRule {
    id: string;
    name: string;
    query: string;
    condition: AlertCondition;
    threshold: string;
    check_interval: string;
    webhook_url: string | null;
    enabled: number;
    last_checked_at: string | null;
    last_value: string | null;
    last_error: string | null;
    triggered_count: number;
    created_at: string;
  }

  interface AlertExecution {
    id: string;
    alert_rule_id: string;
    triggered_at: string;
    value: string | null;
    message: string | null;
  }

  const baseUrl = `/api/v1/orgs/${orgId}/instances/${instanceId}/alerts`;

  let alerts: AlertRule[] = [];
  let loading = false;
  let executions: Record<string, AlertExecution[]> = {};
  let expandedAlertId: string | null = null;
  let loadingExecutions: string | null = null;

  // Dialog state
  let showCreateDialog = false;
  let showDeleteDialog = false;
  let editingAlert: AlertRule | null = null;
  let deletingAlert: AlertRule | null = null;

  // Form state
  let formName = '';
  let formQuery = '';
  let formCondition: AlertCondition = 'greater_than';
  let formThreshold = '';
  let formInterval = '5m';
  let formWebhookUrl = '';
  let formEnabled = true;
  let formError = '';
  let isSaving = false;
  let isDeleting = false;

  // Test query state
  let testingAlertId: string | null = null;
  let testResult: { value: unknown; wouldTrigger: boolean; error?: string } | null = null;

  // Test webhook state
  let testingWebhookId: string | null = null;
  let webhookTestResult: { success?: boolean; error?: string } | null = null;

  const conditionOptions: { value: AlertCondition; label: string; symbol: string }[] = [
    { value: 'greater_than', label: 'Greater than', symbol: '>' },
    { value: 'less_than', label: 'Less than', symbol: '<' },
    { value: 'equals', label: 'Equals', symbol: '=' },
    { value: 'not_equals', label: 'Not equals', symbol: '!=' },
    { value: 'contains', label: 'Contains', symbol: '∋' }
  ];

  onMount(() => { loadAlerts(); });

  async function loadAlerts() {
    loading = true;
    try {
      const res = await fetch(baseUrl);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      alerts = data.rules;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load alerts');
    } finally {
      loading = false;
    }
  }

  function openCreateDialog() {
    editingAlert = null;
    formName = '';
    formQuery = "SELECT COUNT(*) FROM your_table WHERE time > now() - INTERVAL '5 minutes'";
    formCondition = 'greater_than';
    formThreshold = '';
    formInterval = '5m';
    formWebhookUrl = '';
    formEnabled = true;
    formError = '';
    showCreateDialog = true;
  }

  function openEditDialog(alert: AlertRule) {
    editingAlert = alert;
    formName = alert.name;
    formQuery = alert.query;
    formCondition = alert.condition;
    formThreshold = alert.threshold;
    formInterval = alert.check_interval;
    formWebhookUrl = alert.webhook_url || '';
    formEnabled = !!alert.enabled;
    formError = '';
    showCreateDialog = true;
  }

  function openDeleteDialog(alert: AlertRule) {
    deletingAlert = alert;
    showDeleteDialog = true;
  }

  async function handleSave() {
    if (!formName.trim()) { formError = 'Name is required'; return; }
    if (!formQuery.trim()) { formError = 'Query is required'; return; }
    if (!formThreshold.trim()) { formError = 'Threshold is required'; return; }

    isSaving = true;
    formError = '';

    const payload = {
      name: formName.trim(),
      query: formQuery.trim(),
      condition: formCondition,
      threshold: formThreshold.trim(),
      check_interval: formInterval,
      webhook_url: formWebhookUrl.trim() || null,
      enabled: formEnabled,
    };

    try {
      let res: Response;
      if (editingAlert) {
        res = await fetch(`${baseUrl}/${editingAlert.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      } else {
        res = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      }
      if (!res.ok) {
        const data = await res.json();
        formError = data.error || 'Failed to save';
        return;
      }
      toast.success(editingAlert ? 'Alert updated' : 'Alert created');
      showCreateDialog = false;
      await loadAlerts();
    } catch (err) {
      formError = err instanceof Error ? err.message : 'Failed to save alert';
    } finally {
      isSaving = false;
    }
  }

  async function handleDelete() {
    if (!deletingAlert) return;
    isDeleting = true;
    try {
      const res = await fetch(`${baseUrl}/${deletingAlert.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      toast.success('Alert deleted');
      showDeleteDialog = false;
      deletingAlert = null;
      await loadAlerts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete alert');
    } finally {
      isDeleting = false;
    }
  }

  async function toggleAlert(alert: AlertRule) {
    try {
      const res = await fetch(`${baseUrl}/${alert.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !alert.enabled }),
      });
      if (!res.ok) throw new Error('Failed to update');
      await loadAlerts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update alert');
    }
  }

  async function testAlert(alert: AlertRule) {
    testingAlertId = alert.id;
    testResult = null;
    try {
      const res = await fetch(`${baseUrl}/${alert.id}/test`, { method: 'POST' });
      testResult = await res.json();
    } catch (err) {
      testResult = { value: null, wouldTrigger: false, error: err instanceof Error ? err.message : 'Test failed' };
    } finally {
      testingAlertId = null;
    }
  }

  async function testWebhook(alert: AlertRule) {
    testingWebhookId = alert.id;
    webhookTestResult = null;
    try {
      const res = await fetch(`${baseUrl}/${alert.id}/test-webhook`, { method: 'POST' });
      webhookTestResult = await res.json();
    } catch (err) {
      webhookTestResult = { error: err instanceof Error ? err.message : 'Request failed' };
    } finally {
      testingWebhookId = null;
    }
  }

  async function toggleExpanded(alertId: string) {
    if (expandedAlertId === alertId) {
      expandedAlertId = null;
      return;
    }
    expandedAlertId = alertId;
    testResult = null;
    webhookTestResult = null;
    if (!executions[alertId]) {
      loadingExecutions = alertId;
      try {
        const res = await fetch(`${baseUrl}/${alertId}/executions`);
        const data = await res.json();
        executions = { ...executions, [alertId]: data.executions };
      } catch { /* ignore */ } finally {
        loadingExecutions = null;
      }
    }
  }

  function getConditionSymbol(condition: AlertCondition): string {
    return conditionOptions.find(c => c.value === condition)?.symbol || condition;
  }
</script>

<div class="flex h-full flex-col">
  <!-- Header -->
  <div class="flex items-center justify-between border-b bg-muted/30 px-6 py-4">
    <div>
      <h2 class="text-lg font-semibold">Alerts</h2>
      <p class="text-sm text-muted-foreground">Monitor your data with automated queries and webhook notifications</p>
    </div>
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" on:click={loadAlerts} disabled={loading}>
        <RefreshCw class="mr-2 h-4 w-4 {loading ? 'animate-spin' : ''}" />
        Refresh
      </Button>
      <Button size="sm" on:click={openCreateDialog}>
        <Plus class="mr-2 h-4 w-4" />
        Create Alert
      </Button>
    </div>
  </div>

  <!-- Content -->
  <div class="flex-1 overflow-auto p-6">
    {#if alerts.length === 0 && !loading}
      <div class="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-12 text-center">
        <Bell class="h-12 w-12 text-muted-foreground/30" />
        <div>
          <p class="text-lg font-medium">No alerts configured</p>
          <p class="text-sm text-muted-foreground">Create an alert to monitor your data and get notified via webhook</p>
        </div>
        <Button on:click={openCreateDialog}>
          <Plus class="mr-2 h-4 w-4" />
          Create Alert
        </Button>
      </div>
    {:else}
      <div class="space-y-3">
        {#each alerts as alert (alert.id)}
          <div class="rounded-lg border bg-card">
            <button
              class="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/50"
              on:click={() => toggleExpanded(alert.id)}
            >
              <div class="flex-shrink-0">
                {#if expandedAlertId === alert.id}
                  <ChevronDown class="h-4 w-4 text-muted-foreground" />
                {:else}
                  <ChevronRight class="h-4 w-4 text-muted-foreground" />
                {/if}
              </div>

              <div class="flex-shrink-0">
                {#if alert.enabled}
                  <Bell class="h-5 w-5 text-primary" />
                {:else}
                  <BellOff class="h-5 w-5 text-muted-foreground" />
                {/if}
              </div>

              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="font-medium">{alert.name}</span>
                  <Badge variant={alert.enabled ? 'default' : 'secondary'}>
                    {alert.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                  {#if alert.triggered_count > 0}
                    <Badge variant="outline" class="border-orange-500 text-orange-500">
                      {alert.triggered_count} triggers
                    </Badge>
                  {/if}
                  {#if alert.webhook_url}
                    <Webhook class="h-3.5 w-3.5 text-muted-foreground" />
                  {/if}
                </div>
                <div class="mt-1 flex items-center gap-4 text-sm text-muted-foreground">
                  <span>{getConditionSymbol(alert.condition)} {alert.threshold}</span>
                  <span class="flex items-center gap-1">
                    <Clock class="h-3.5 w-3.5" />
                    Every {alert.check_interval}
                  </span>
                </div>
              </div>

              <div class="flex items-center gap-2 text-sm text-muted-foreground">
                {#if alert.last_error}
                  <XCircle class="h-4 w-4 text-destructive" />
                {:else if alert.last_checked_at}
                  <CheckCircle class="h-4 w-4 text-green-500" />
                {:else}
                  <Clock class="h-4 w-4" />
                {/if}
                <span>{alert.last_checked_at ? new Date(alert.last_checked_at).toLocaleTimeString() : 'Never checked'}</span>
              </div>
            </button>

            {#if expandedAlertId === alert.id}
              <div class="border-t bg-muted/30 px-4 py-4">
                <div class="mb-4">
                  <p class="mb-2 text-sm font-medium">SQL Query</p>
                  <pre class="overflow-x-auto rounded-md bg-muted p-3 text-xs">{alert.query}</pre>
                </div>

                <div class="mb-4 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                  <div>
                    <p class="text-muted-foreground">Condition</p>
                    <p class="font-medium">{getConditionSymbol(alert.condition)} {alert.threshold}</p>
                  </div>
                  <div>
                    <p class="text-muted-foreground">Check Interval</p>
                    <p class="font-medium">{alert.check_interval}</p>
                  </div>
                  <div>
                    <p class="text-muted-foreground">Last Value</p>
                    <p class="font-medium">{alert.last_value ?? 'N/A'}</p>
                  </div>
                  <div>
                    <p class="text-muted-foreground">Triggered</p>
                    <p class="font-medium">{alert.triggered_count} times</p>
                  </div>
                </div>

                {#if alert.webhook_url}
                  <div class="mb-4 space-y-2">
                    <div class="flex items-center gap-2 text-sm text-muted-foreground">
                      <Webhook class="h-4 w-4 flex-shrink-0" />
                      <span class="truncate font-mono text-xs">{alert.webhook_url}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        class="ml-auto flex-shrink-0"
                        on:click={() => testWebhook(alert)}
                        disabled={testingWebhookId === alert.id}
                      >
                        {#if testingWebhookId === alert.id}
                          <Loader2 class="mr-2 h-3.5 w-3.5 animate-spin" />
                        {:else}
                          <Webhook class="mr-2 h-3.5 w-3.5" />
                        {/if}
                        Test Webhook
                      </Button>
                    </div>
                    {#if webhookTestResult && expandedAlertId === alert.id}
                      <div class="rounded-md p-2 text-xs {webhookTestResult.error ? 'bg-destructive/10 text-destructive' : 'bg-green-500/10 text-green-600 dark:text-green-400'}">
                        {#if webhookTestResult.error}
                          <XCircle class="mb-0.5 inline h-3.5 w-3.5" /> {webhookTestResult.error}
                        {:else}
                          <CheckCircle class="mb-0.5 inline h-3.5 w-3.5" /> Webhook delivered successfully
                        {/if}
                      </div>
                    {/if}
                  </div>
                {/if}

                {#if alert.last_error}
                  <div class="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    <AlertTriangle class="mb-1 inline h-4 w-4" />
                    {alert.last_error}
                  </div>
                {/if}

                {#if testResult && expandedAlertId === alert.id}
                  <div class="mb-4 rounded-md p-3 text-sm {testResult.error ? 'bg-destructive/10' : testResult.wouldTrigger ? 'bg-orange-500/10' : 'bg-green-500/10'}">
                    {#if testResult.error}
                      <XCircle class="mb-1 inline h-4 w-4 text-destructive" />
                      <span class="text-destructive">Error: {testResult.error}</span>
                    {:else if testResult.wouldTrigger}
                      <AlertTriangle class="mb-1 inline h-4 w-4 text-orange-500" />
                      <span class="text-orange-600 dark:text-orange-400">Would trigger! Value: {testResult.value}</span>
                    {:else}
                      <CheckCircle class="mb-1 inline h-4 w-4 text-green-500" />
                      <span class="text-green-600 dark:text-green-400">OK — Value: {testResult.value}</span>
                    {/if}
                  </div>
                {/if}

                <div class="mb-4 flex items-center gap-2">
                  <Button variant="outline" size="sm" on:click={() => openEditDialog(alert)}>
                    <Pencil class="mr-2 h-4 w-4" />
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" on:click={() => toggleAlert(alert)}>
                    {alert.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    on:click={() => testAlert(alert)}
                    disabled={testingAlertId === alert.id}
                  >
                    {#if testingAlertId === alert.id}
                      <Loader2 class="mr-2 h-4 w-4 animate-spin" />
                    {:else}
                      <Play class="mr-2 h-4 w-4" />
                    {/if}
                    Test Now
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    class="text-destructive hover:text-destructive"
                    on:click={() => openDeleteDialog(alert)}
                  >
                    <Trash2 class="mr-2 h-4 w-4" />
                    Delete
                  </Button>
                </div>

                <!-- Execution history -->
                <div>
                  <p class="mb-2 text-sm font-medium text-muted-foreground">Recent Triggers</p>
                  {#if loadingExecutions === alert.id}
                    <div class="py-4 text-center text-sm text-muted-foreground">
                      <Loader2 class="mx-auto h-4 w-4 animate-spin" />
                    </div>
                  {:else if !executions[alert.id] || executions[alert.id].length === 0}
                    <div class="rounded-md border border-dashed py-4 text-center text-sm text-muted-foreground">
                      No triggers yet
                    </div>
                  {:else}
                    <div class="overflow-hidden rounded-md border">
                      <table class="w-full text-sm">
                        <thead class="bg-muted">
                          <tr>
                            <th class="px-3 py-2 text-left font-medium">Time</th>
                            <th class="px-3 py-2 text-left font-medium">Value</th>
                            <th class="px-3 py-2 text-left font-medium">Message</th>
                          </tr>
                        </thead>
                        <tbody>
                          {#each executions[alert.id] as exec}
                            <tr class="border-t hover:bg-muted/50">
                              <td class="whitespace-nowrap px-3 py-2">{new Date(exec.triggered_at).toLocaleString()}</td>
                              <td class="px-3 py-2 font-mono">{exec.value ?? '—'}</td>
                              <td class="px-3 py-2 text-muted-foreground">{exec.message ?? '—'}</td>
                            </tr>
                          {/each}
                        </tbody>
                      </table>
                    </div>
                  {/if}
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
  <Dialog.Content class="sm:max-w-[550px]">
    <Dialog.Header>
      <Dialog.Title>{editingAlert ? 'Edit Alert' : 'Create Alert'}</Dialog.Title>
      <Dialog.Description>
        Configure an alert to monitor your data. The query runs server-side every check interval.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4 py-4">
      {#if formError}
        <div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{formError}</div>
      {/if}

      <div class="space-y-2">
        <Label for="alert-name">Alert Name</Label>
        <Input id="alert-name" placeholder="e.g., high-error-rate" bind:value={formName} />
      </div>

      <div class="space-y-2">
        <Label for="alert-query">SQL Query</Label>
        <textarea
          id="alert-query"
          class="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="SELECT COUNT(*) FROM errors WHERE time > now() - INTERVAL '5 minutes'"
          bind:value={formQuery}
        ></textarea>
        <p class="text-xs text-muted-foreground">Query must return a single value (first column of first row)</p>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-2">
          <Label for="alert-condition">Condition</Label>
          <select
            id="alert-condition"
            class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            bind:value={formCondition}
          >
            {#each conditionOptions as option}
              <option value={option.value}>{option.label} ({option.symbol})</option>
            {/each}
          </select>
        </div>
        <div class="space-y-2">
          <Label for="alert-threshold">Threshold</Label>
          <Input
            id="alert-threshold"
            placeholder={formCondition === 'contains' ? 'text to match' : 'e.g., 100'}
            bind:value={formThreshold}
          />
        </div>
      </div>

      <div class="space-y-2">
        <Label>Check Interval</Label>
        <IntervalInput bind:value={formInterval} mode="alerting" />
        <p class="text-xs text-muted-foreground">Minimum interval is 1 minute</p>
      </div>

      <div class="space-y-2">
        <Label for="alert-webhook">Webhook URL <span class="text-muted-foreground">(optional)</span></Label>
        <Input
          id="alert-webhook"
          placeholder="https://hooks.slack.com/services/..."
          bind:value={formWebhookUrl}
        />
        <p class="text-xs text-muted-foreground">Receives a POST request with alert details when triggered</p>
      </div>

      <div class="flex items-center gap-2">
        <input type="checkbox" id="alert-enabled" bind:checked={formEnabled} class="h-4 w-4 rounded border-input" />
        <Label for="alert-enabled" class="cursor-pointer">Enable alert immediately</Label>
      </div>
    </div>

    <Dialog.Footer>
      <Button variant="outline" on:click={() => showCreateDialog = false}>Cancel</Button>
      <Button on:click={handleSave} disabled={isSaving}>
        {#if isSaving}<Loader2 class="mr-2 h-4 w-4 animate-spin" />{/if}
        {editingAlert ? 'Update' : 'Create'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- Delete Dialog -->
<Dialog.Root bind:open={showDeleteDialog}>
  <Dialog.Content class="sm:max-w-[400px]">
    <Dialog.Header>
      <Dialog.Title>Delete Alert</Dialog.Title>
      <Dialog.Description>
        Are you sure you want to delete "{deletingAlert?.name}"? This action cannot be undone.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" on:click={() => showDeleteDialog = false}>Cancel</Button>
      <Button variant="destructive" on:click={handleDelete} disabled={isDeleting}>
        {#if isDeleting}<Loader2 class="mr-2 h-4 w-4 animate-spin" />{/if}
        Delete
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
