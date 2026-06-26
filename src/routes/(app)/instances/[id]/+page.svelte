<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import {
    getInstance, updateInstance, deleteInstance, type Instance
  } from '$lib/cloudApi';
  import { Button } from '$lib/components/ui/button';
  import { toast } from 'svelte-sonner';
  import {
    ArrowLeft, Trash2, Terminal, Copy, ExternalLink, Pencil
  } from 'lucide-svelte';
  import { timezone, formatDateTime } from '$lib/stores/timezone';

  export let data: any;

  $: org = data.activeOrg as { id: string; name: string } | undefined;
  $: instanceId = $page.params.id!;
  const canManageInstances = data.currentRole !== 'viewer';

  let instance: Instance | null = null;
  let events: any[] = [];
  let loading = true;
  let actionLoading = false;
  let showDeleteConfirm = false;

  // Edit connection state
  let editing = false;
  let editName = '';
  let editEndpoint = '';
  let editToken = '';
  let savingEdit = false;

  function startEdit() {
    if (!instance) return;
    editName = instance.name ?? '';
    editEndpoint = instance.endpoint_url ?? '';
    editToken = '';
    editing = true;
  }

  async function saveEdit() {
    if (!org || !instance) return;
    if (!editEndpoint.trim()) { toast.error('Arc server URL is required'); return; }
    savingEdit = true;
    try {
      const payload: { name?: string; endpoint_url?: string; admin_token?: string } = {
        name: editName.trim(),
        endpoint_url: editEndpoint.trim(),
      };
      // Only send the token when the field was filled — blank keeps the existing one.
      if (editToken.trim()) payload.admin_token = editToken.trim();
      const updated = await updateInstance(org.id, instance.id, payload);
      instance = updated;
      editing = false;
      toast.success(updated.status === 'running' ? 'Connection updated — Arc reachable' : 'Connection updated — Arc is unreachable');
      await loadData();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      savingEdit = false;
    }
  }

  onMount(() => {
    loadData();
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
          {#if instance.arc_version}
            <span class="text-xs text-muted-foreground">v{instance.arc_version}</span>
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
            <p class="mt-1 text-sm font-mono">{instance.arc_version || 'Unknown'}</p>
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
