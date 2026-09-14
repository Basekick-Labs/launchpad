<script lang="ts">
  import type { PageData } from './$types';
  import { invalidateAll } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
    AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  } from '$lib/components/ui/alert-dialog';
  import { timezone, formatDateTime } from '$lib/stores/timezone';
  import { filterDashboards } from '$lib/dashboard/filter';
  import { createDashboard } from '$lib/dashboard/model';
  import { createDashboardRequest, deleteDashboardRequest } from '$lib/cloudApi';
  import { roleAtLeast } from '$lib/roles';
  import type { DashboardSummary } from '$lib/dashboard/model';
  import { Plus, Search, Trash2, LayoutDashboard } from 'lucide-svelte';

  export let data: PageData;

  let query = '';
  let creating = false;
  let deleting: string | null = null;
  let pendingDelete: DashboardSummary | null = null;

  // Everything derived from `data` must be reactive: switching orgs calls
  // invalidateAll(), and a `const` would keep the previous org's answer.
  $: org = data.activeOrg;
  $: role = data.role;
  $: canCreate = role !== null && roleAtLeast(role, 'member');
  $: dashboards = data.dashboards;
  $: filtered = filterDashboards(dashboards, query);

  // Mirrors the server: member-and-above, and either the author or an admin.
  // Gating on anything looser offers a button that 403s.
  function canDelete(d: DashboardSummary): boolean {
    if (role === null || !roleAtLeast(role, 'member')) return false;
    return d.createdBy === data.user.id || roleAtLeast(role, 'admin');
  }

  async function handleCreate() {
    if (!org || creating) return;
    creating = true;
    try {
      // The POST route validates a full model, so send one. instanceId is null
      // until a panel needs an instance — nothing forces a choice up front.
      const model = createDashboard({ title: 'New dashboard', instanceId: null });
      await createDashboardRequest(org.id, model);
      // #35 adds the dashboard view; until it exists, creating navigates
      // nowhere and the new row simply appears at the top of the list.
      await invalidateAll();
      toast.success('Dashboard created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create dashboard');
    } finally {
      creating = false;
    }
  }

  async function handleDelete() {
    if (!org || !pendingDelete) return;
    const target = pendingDelete;
    deleting = target.uid;
    try {
      await deleteDashboardRequest(org.id, target.uid);
      // Awaited before clearing state, or the deleted row flashes back.
      await invalidateAll();
      toast.success(`Deleted ${target.title}`);
      pendingDelete = null;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete dashboard');
    } finally {
      deleting = null;
    }
  }
</script>

<div class="p-6">
  <div class="mb-6 flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Dashboards</h1>
      <p class="text-sm text-muted-foreground">Build and share views over your Arc data</p>
    </div>
    {#if canCreate}
      <Button on:click={handleCreate} disabled={creating}>
        <Plus class="mr-2 h-4 w-4" />
        {creating ? 'Creating...' : 'New dashboard'}
      </Button>
    {/if}
  </div>

  {#if data.loadError}
    <div class="rounded-lg border bg-card p-8 text-center">
      <p class="text-destructive">{data.loadError}</p>
    </div>
  {:else if !org}
    <div class="rounded-lg border bg-card p-12 text-center">
      <p class="mb-2 text-lg font-medium">No organization</p>
      <p class="text-sm text-muted-foreground">Create an organization before adding dashboards.</p>
    </div>
  {:else if dashboards.length === 0}
    <div class="rounded-lg border bg-card p-12 text-center">
      <LayoutDashboard class="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
      <p class="mb-2 text-lg font-medium">No dashboards</p>
      <p class="mb-4 text-sm text-muted-foreground">
        {canCreate
          ? 'Create your first dashboard to start visualizing your data.'
          : 'No dashboards have been created yet.'}
      </p>
      {#if canCreate}
        <Button on:click={handleCreate} disabled={creating}>
          <Plus class="mr-2 h-4 w-4" />
          New dashboard
        </Button>
      {/if}
    </div>
  {:else}
    <div class="relative mb-4 max-w-sm">
      <Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input bind:value={query} placeholder="Search by title or tag" class="pl-8" />
    </div>

    {#if filtered.length === 0}
      <div class="rounded-lg border bg-card p-8 text-center text-muted-foreground">
        No dashboards match “{query}”.
      </div>
    {:else}
      <div class="divide-y rounded-lg border bg-card">
        {#each filtered as dashboard (dashboard.uid)}
          <div class="flex items-center justify-between gap-4 p-4">
            <div class="min-w-0">
              <p class="truncate font-medium">{dashboard.title}</p>
              {#if dashboard.description}
                <p class="truncate text-sm text-muted-foreground">{dashboard.description}</p>
              {/if}
              <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>v{dashboard.version}</span>
                <span>·</span>
                <span>Updated {formatDateTime(dashboard.updatedAt, $timezone)}</span>
                {#if dashboard.instanceIds.length > 0}
                  <span>·</span>
                  <span>{dashboard.instanceIds.length} instance{dashboard.instanceIds.length === 1 ? '' : 's'}</span>
                {/if}
                {#each dashboard.tags as tag}
                  <span class="rounded bg-muted px-1.5 py-0.5">{tag}</span>
                {/each}
              </div>
            </div>
            {#if canDelete(dashboard)}
              <Button
                variant="ghost"
                size="icon"
                title="Delete dashboard"
                disabled={deleting === dashboard.uid}
                on:click={() => (pendingDelete = dashboard)}
              >
                <Trash2 class="h-4 w-4" />
              </Button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<AlertDialog open={pendingDelete !== null} onOpenChange={(o) => { if (!o) pendingDelete = null; }}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete dashboard</AlertDialogTitle>
      <AlertDialogDescription>
        “{pendingDelete?.title}” and its version history will be permanently deleted.
        This cannot be undone.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction on:click={handleDelete} disabled={deleting !== null}>
        {deleting !== null ? 'Deleting...' : 'Delete'}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
