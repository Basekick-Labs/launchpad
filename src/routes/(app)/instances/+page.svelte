<script lang="ts">
  import { onMount } from 'svelte';
  import { listInstances, type Instance } from '$lib/cloudApi';
  import { Button } from '$lib/components/ui/button';
  import { timezone, formatDateTime } from '$lib/stores/timezone';
  import { Plus } from 'lucide-svelte';

  export let data: any;

  let instances: Instance[] = [];
  let loading = true;

  $: org = data.activeOrg;
  const canManageInstances = data.currentRole !== 'viewer';

  onMount(async () => {
    if (org) {
      try {
        instances = await listInstances(org.id);
      } catch {
        // ignore
      }
    }
    loading = false;
  });

  function statusColor(status: string): string {
    switch (status) {
      case 'running': return 'bg-green-500';
      case 'unreachable': return 'bg-gray-400';
      default: return 'bg-yellow-500';
    }
  }
</script>

<div class="p-6">
  <div class="mb-6 flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Instances</h1>
      <p class="text-sm text-muted-foreground">Manage your connected Arc servers</p>
    </div>
    {#if canManageInstances}
      <Button href="/instances/new">
        <Plus class="mr-2 h-4 w-4" />
        Connect Instance
      </Button>
    {/if}
  </div>

  {#if loading}
    <div class="rounded-lg border bg-card p-8 text-center text-muted-foreground">Loading...</div>
  {:else if instances.length === 0}
    <div class="rounded-lg border bg-card p-12 text-center">
      <p class="mb-2 text-lg font-medium">No instances</p>
      <p class="mb-4 text-sm text-muted-foreground">
        {canManageInstances ? 'Connect your first Arc server to get started.' : 'No instances have been connected yet.'}
      </p>
      {#if canManageInstances}
        <Button href="/instances/new">
          <Plus class="mr-2 h-4 w-4" />
          Connect Instance
        </Button>
      {/if}
    </div>
  {:else}
    <div class="rounded-lg border bg-card">
      <table class="w-full">
        <thead>
          <tr class="border-b text-left text-xs text-muted-foreground">
            <th class="px-4 py-3 font-medium">Status</th>
            <th class="px-4 py-3 font-medium">Endpoint</th>
            <th class="px-4 py-3 font-medium">Version</th>
            <th class="px-4 py-3 font-medium">Created</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          {#each instances as instance}
            <tr class="hover:bg-muted/50 transition-colors cursor-pointer" on:click={() => window.location.href = `/instances/${instance.id}`}>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <div class="h-2 w-2 rounded-full {statusColor(instance.status)}" />
                  <span class="text-sm capitalize">{instance.status}</span>
                </div>
              </td>
              <td class="px-4 py-3">
                <span class="font-mono text-sm">{instance.endpoint_url ?? '—'}</span>
              </td>
              <td class="px-4 py-3 text-sm text-muted-foreground">
                {instance.arc_version ? `v${instance.arc_version}` : '—'}
              </td>
              <td class="px-4 py-3 text-sm text-muted-foreground">
                {formatDateTime(instance.created_at, $timezone)}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
