<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import {
    getInstance, updateInstance, deleteInstance, getInstanceCapabilities, getInstanceChanges,
    type Instance
  } from '$lib/cloudApi';
  import type { ChangeEntry } from '$lib/changeLog';
  import { describeCapability, enterpriseCapabilities, tierLabel, type CapabilitiesView, type CapabilityState } from '$lib/capabilities';
  import { roleAtLeast } from '$lib/roles';
  import { Button } from '$lib/components/ui/button';
  import { toast } from 'svelte-sonner';
  import {
    ArrowLeft, Trash2, Terminal, Copy, ExternalLink, Pencil, RefreshCw
  } from 'lucide-svelte';
  import { timezone, formatDateTime } from '$lib/stores/timezone';

  export let data: any;

  $: org = data.activeOrg as { id: string; name: string } | undefined;
  $: instanceId = $page.params.id!;
  const canManageInstances = data.currentRole !== 'viewer';
  // License and Enterprise feature state is shown to owners and admins.
  $: isOrgAdmin = roleAtLeast(data.currentRole ?? '', 'admin');

  let capabilities: CapabilitiesView | null = null;

  // Change history (owner/admin): Arc changes made through Launchpad, by whom.
  let changes: ChangeEntry[] = [];
  let changesNext: number | null = null;
  let changesLoading = false;
  let changesError = false;
  let changesRequest = 0;

  async function loadChanges(more = false) {
    if (!org || !isOrgAdmin) return;
    const request = ++changesRequest;
    changesLoading = true;
    try {
      const batch = await getInstanceChanges(org.id, instanceId, more ? changesNext ?? undefined : undefined);
      if (request !== changesRequest) return;
      changes = more ? [...changes, ...batch.changes] : batch.changes;
      changesNext = batch.nextBefore;
      changesError = false;
    } catch {
      if (request !== changesRequest) return;
      if (more) toast.error('Could not load more history');
      else changesError = true;
    } finally {
      if (request === changesRequest) changesLoading = false;
    }
  }

  // Reload when the page is reused for another instance.
  $: if (instanceId && isOrgAdmin) {
    changes = [];
    changesNext = null;
    loadChanges();
  }

  const OUTCOME_CLASS = {
    ok: 'text-muted-foreground',
    error: 'text-destructive',
    unknown: 'text-yellow-600 dark:text-yellow-400',
  } as const;
  let capabilitiesLoading = false;
  let capabilitiesRequest = 0;

  // Fetched after the page renders and never awaited by it: discovery probes
  // Arc and can take seconds when the instance is slow. Only the latest
  // request may write, so a slow response for the pre-edit connection cannot
  // overwrite the current one.
  async function loadCapabilities(refresh = false) {
    if (!org || !isOrgAdmin) return;
    const request = ++capabilitiesRequest;
    capabilitiesLoading = true;
    try {
      const view = await getInstanceCapabilities(org.id, instanceId, { refresh });
      if (request === capabilitiesRequest) capabilities = view;
    } catch {
      // Keep what is shown; a failed background check is not worth a toast.
      if (refresh && request === capabilitiesRequest) toast.error('Could not check Enterprise features');
    } finally {
      if (request === capabilitiesRequest) capabilitiesLoading = false;
    }
  }

  const STATE_DOT: Record<CapabilityState, string> = {
    available: 'bg-green-500',
    disabled: 'bg-muted-foreground',
    unavailable: 'bg-muted-foreground',
    unlicensed: 'bg-muted-foreground/40',
    unknown: 'bg-yellow-500',
  };

  const NOTICE_STYLE = {
    info: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100',
    warning: 'border-yellow-200 bg-yellow-50 text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-100',
    critical: 'border-red-200 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100',
  } as const;

  $: tier = tierLabel(capabilities?.tier ?? null);

  let instance: Instance | null = null;
  // A fresh discovery beats the stored value, which lags an upgrade.
  $: version = (capabilities?.reachable ? capabilities.version : null) ?? instance?.detected_arc_version ?? null;
  let events: any[] = [];
  let loading = true;
  let actionLoading = false;
  let showDeleteConfirm = false;

  // Edit connection state
  let editing = false;
  let editName = '';
  let editEndpoint = '';
  let editToken = '';
  /** '' = same scheme as the endpoint. */
  let editNodeScheme: '' | 'http' | 'https' = '';
  let savingEdit = false;

  function startEdit() {
    if (!instance) return;
    editName = instance.name ?? '';
    editEndpoint = instance.endpoint_url ?? '';
    editToken = '';
    editNodeScheme = instance.node_scheme ?? '';
    editing = true;
  }

  async function saveEdit() {
    if (!org || !instance) return;
    if (!editEndpoint.trim()) { toast.error('Arc server URL is required'); return; }
    savingEdit = true;
    try {
      const payload: { name?: string; endpoint_url?: string; admin_token?: string; node_scheme?: 'http' | 'https' | null } = {
        name: editName.trim(),
        endpoint_url: editEndpoint.trim(),
        node_scheme: editNodeScheme || null,
      };
      // Only send the token when the field was filled — blank keeps the existing one.
      if (editToken.trim()) payload.admin_token = editToken.trim();
      const updated = await updateInstance(org.id, instance.id, payload);
      instance = updated;
      editing = false;
      toast.success(updated.status === 'running' ? 'Connection updated — Arc reachable' : 'Connection updated — Arc is unreachable');
      await loadData();
      loadCapabilities();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      savingEdit = false;
    }
  }

  onMount(() => {
    loadData();
    loadCapabilities();
  });

  async function loadData() {
    if (!org) return;
    loading = true;
    try {
      const result = await getInstance(org!.id, instanceId);
      instance = result.instance;
      events = result.events;
    } catch {
      toast.error('Failed to load instance');
    } finally {
      loading = false;
    }
  }

  async function handleDelete() {
    if (!org || !instance) return;
    actionLoading = true;
    try {
      await deleteInstance(org.id, instance.id);
      toast.success('Instance deleted');
      goto('/instances');
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      actionLoading = false;
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  }
</script>

<div class="p-6">
  <a href="/instances" class="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
    <ArrowLeft class="h-4 w-4" />
    Back to instances
  </a>

  {#if loading}
    <div class="rounded-lg border bg-card p-8 text-center text-muted-foreground">Loading...</div>
  {:else if !instance}
    <div class="rounded-lg border bg-card p-8 text-center text-muted-foreground">Instance not found</div>
  {:else}
    <!-- Header -->
    <div class="mb-6 flex items-start justify-between">
      <div>
        <h1 class="text-2xl font-bold font-mono">{instance.name}</h1>
        <div class="mt-1 flex items-center gap-3">
          <div class="flex items-center gap-1.5">
            <div class="h-2 w-2 rounded-full {instance.status === 'running' ? 'bg-green-500' : 'bg-red-500'}" />
            <span class="text-sm capitalize">{instance.status === 'running' ? 'Running' : 'Unreachable'}</span>
          </div>
          {#if version}
            <span class="text-xs text-muted-foreground">v{version}</span>
          {/if}
          {#if tier}
            <span class="rounded-full border px-2 py-0.5 text-xs font-medium">{tier}</span>
          {/if}
        </div>
      </div>

      <div class="flex items-center gap-2">
        {#if instance.status === 'running'}
          <Button variant="outline" size="sm" href="/instances/{instance.id}/console">
            <Terminal class="mr-2 h-4 w-4" />
            Open Console
          </Button>
        {/if}
        {#if canManageInstances}
          <Button variant="outline" size="sm" on:click={startEdit} disabled={editing}>
            <Pencil class="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button variant="destructive" size="sm" on:click={() => showDeleteConfirm = true} disabled={actionLoading}>
            <Trash2 class="mr-2 h-4 w-4" />
            Delete
          </Button>
        {/if}
      </div>
    </div>

    {#if instance.status !== 'running'}
      <div class="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
        <p class="text-sm font-medium text-red-900 dark:text-red-100">Instance unreachable</p>
        <p class="text-xs text-red-700 dark:text-red-300">The Arc server at the configured endpoint did not respond to a health check. Verify the endpoint URL and admin token.</p>
      </div>
    {/if}

    {#each capabilities?.notices ?? [] as notice (notice.message)}
      <div role="status" class="mb-6 rounded-lg border p-4 text-sm {NOTICE_STYLE[notice.severity]}">{notice.message}</div>
    {/each}

    <!-- Connection Info -->
    <div class="mb-6 rounded-lg border bg-card p-4">
      <h2 class="mb-3 font-semibold">Connection Details</h2>

      {#if editing}
        <div class="space-y-4">
          <div>
            <label for="edit-name" class="mb-1 block text-xs text-muted-foreground">Name</label>
            <input
              id="edit-name"
              type="text"
              bind:value={editName}
              placeholder="Production Arc"
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div>
            <label for="edit-endpoint" class="mb-1 block text-xs text-muted-foreground">Arc server URL</label>
            <input
              id="edit-endpoint"
              type="url"
              bind:value={editEndpoint}
              placeholder="https://arc.example.com:8000"
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div>
            <label for="edit-token" class="mb-1 block text-xs text-muted-foreground">Admin / API token</label>
            <input
              id="edit-token"
              type="password"
              bind:value={editToken}
              placeholder="Leave blank to keep the current token"
              autocomplete="off"
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p class="mt-1 text-xs text-muted-foreground">Use a token with <strong>admin</strong> permission to enable log viewing.</p>
          </div>
          <div>
            <label for="edit-node-scheme" class="mb-1 block text-xs text-muted-foreground">Cluster node scheme</label>
            <select
              id="edit-node-scheme"
              bind:value={editNodeScheme}
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Same as the endpoint</option>
              <option value="https">https</option>
              <option value="http">http</option>
            </select>
            <p class="mt-1 text-xs text-muted-foreground">
              Clusters only. Launchpad reads each node's metrics and logs directly at the address Arc reports for it.
              Choose <strong>http</strong> when the endpoint is an HTTPS load balancer but the nodes serve plain HTTP;
              the token then crosses your internal network unencrypted.
            </p>
          </div>
          <div class="flex items-center gap-2">
            <Button size="sm" on:click={saveEdit} disabled={savingEdit || !editEndpoint.trim()}>
              {savingEdit ? 'Saving...' : 'Save changes'}
            </Button>
            <Button variant="ghost" size="sm" on:click={() => editing = false} disabled={savingEdit}>Cancel</Button>
          </div>
        </div>
      {:else}
        <div class="space-y-3">
          <div>
            <label class="text-xs text-muted-foreground">Endpoint</label>
            <div class="flex items-center gap-2">
              <code class="flex-1 rounded bg-muted px-3 py-1.5 text-sm font-mono">{instance.endpoint_url ?? '—'}</code>
              {#if instance.endpoint_url}
                <Button variant="ghost" size="sm" on:click={() => copyToClipboard(instance?.endpoint_url || '')}>
                  <Copy class="h-4 w-4" />
                </Button>
                <a href="{instance.endpoint_url}/health" target="_blank" rel="noopener">
                  <Button variant="ghost" size="sm">
                    <ExternalLink class="h-4 w-4" />
                  </Button>
                </a>
              {/if}
            </div>
          </div>

          <div>
            <label class="text-xs text-muted-foreground">Arc Version</label>
            <p class="mt-1 text-sm {version ? 'font-mono' : 'text-muted-foreground'}">{version ?? 'Not reported by this Arc instance'}</p>
          </div>

          {#if instance.status === 'running'}
            <div>
              <label class="text-xs text-muted-foreground">Authentication</label>
              <p class="mt-1 text-sm text-muted-foreground">
                To use the API, create a token from the
                <a href="/instances/{instance.id}/console" class="text-primary underline">
                  Tokens tab
                </a>
                in the console.
              </p>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    {#if capabilities?.showEnterprise}
      <!-- Enterprise features: what this instance serves, from Arc itself (#6) -->
      <div class="mb-6 rounded-lg border bg-card p-4">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="font-semibold">Enterprise Features</h2>
          <Button
            variant="ghost"
            size="sm"
            on:click={() => loadCapabilities(true)}
            disabled={capabilitiesLoading}
            title="Check again"
            aria-label="Check Enterprise features again"
            aria-busy={capabilitiesLoading}
          >
            <RefreshCw class="h-4 w-4 {capabilitiesLoading ? 'animate-spin' : ''}" />
          </Button>
        </div>
        <ul class="divide-y">
          {#each enterpriseCapabilities(capabilities) as cap (cap.id)}
            <li class="flex items-center justify-between gap-4 py-2">
              <div class="flex items-center gap-2">
                <div class="h-2 w-2 rounded-full {STATE_DOT[cap.state]}" aria-hidden="true" />
                <span class="text-sm">{cap.label}</span>
              </div>
              <span class="text-right text-xs text-muted-foreground">{describeCapability(cap)}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if isOrgAdmin}
      <!-- Change history: who changed what in Arc through Launchpad -->
      <section class="mb-6 rounded-lg border bg-card" aria-labelledby="change-history-title">
        <div class="border-b px-4 py-3">
          <h2 id="change-history-title" class="font-semibold">Change history</h2>
          <p class="text-xs text-muted-foreground">
            Configuration changes made to this Arc instance through Launchpad, and who made them. SQL and data
            ingestion are not listed. Visible to owners and admins.
          </p>
        </div>
        {#if changesError && changes.length === 0}
          <div class="flex items-center justify-center gap-3 p-4 text-sm text-destructive" role="status">
            Could not load the change history.
            <Button variant="outline" size="sm" on:click={() => loadChanges()}>Retry</Button>
          </div>
        {:else if changes.length === 0}
          <div class="p-4 text-center text-sm text-muted-foreground" aria-live="polite" aria-busy={changesLoading}>
            {changesLoading ? 'Loading…' : 'No changes recorded yet'}
          </div>
        {:else}
          <ul class="divide-y">
            {#each changes as change (change.id)}
              <li class="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="w-14 shrink-0 font-mono text-xs font-semibold">{change.method}</span>
                  <span class="truncate font-mono text-xs" title={change.path}>{change.path}</span>
                  <span class="shrink-0 text-xs {OUTCOME_CLASS[change.outcome]}">
                    {change.status ?? 'no answer'}{change.outcome === 'unknown' ? ' (may have applied, or still running)' : ''}
                  </span>
                  {#if change.dryRun}<span class="shrink-0 text-xs text-muted-foreground">dry run</span>{/if}
                </div>
                <div class="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                  <span>{change.actor ? change.actor.name || change.actor.email : 'Deleted user'}</span>
                  <time datetime={change.createdAt}>{formatDateTime(change.createdAt, $timezone)}</time>
                </div>
              </li>
            {/each}
          </ul>
          {#if changesNext !== null}
            <div class="border-t p-2 text-center">
              <Button variant="ghost" size="sm" on:click={() => loadChanges(true)} disabled={changesLoading}>Load more</Button>
            </div>
          {/if}
        {/if}
      </section>
    {/if}

    <!-- Events -->
    <div class="rounded-lg border bg-card">
      <div class="border-b px-4 py-3">
        <h2 class="font-semibold">Activity</h2>
      </div>
      {#if events.length === 0}
        <div class="p-4 text-center text-sm text-muted-foreground">No activity yet</div>
      {:else}
        <div class="divide-y">
          {#each events as event}
            <div class="flex items-center justify-between px-4 py-2">
              <span class="text-sm capitalize">{event.event_type.replace('_', ' ')}</span>
              <span class="text-xs text-muted-foreground">{formatDateTime(event.created_at, $timezone)}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Delete Confirmation -->
    {#if showDeleteConfirm}
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div class="w-full max-w-sm rounded-lg bg-card p-6 shadow-lg">
          <h3 class="mb-2 text-lg font-bold">Delete Instance</h3>
          <p class="mb-4 text-sm text-muted-foreground">
            Are you sure you want to remove the connection to <strong>{instance.resource_id}</strong>? This removes it from Arc Launchpad only — your Arc instance and its data are not affected.
          </p>
          <div class="flex justify-end gap-2">
            <Button variant="outline" on:click={() => showDeleteConfirm = false}>Cancel</Button>
            <Button variant="destructive" on:click={handleDelete} disabled={actionLoading}>
              {actionLoading ? 'Deleting...' : 'Delete Instance'}
            </Button>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</div>
