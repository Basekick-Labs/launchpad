<script lang="ts">
  import { goto } from '$app/navigation';
  import { createInstance } from '$lib/cloudApi';
  import { Button } from '$lib/components/ui/button';
  import { ArrowLeft } from 'lucide-svelte';

  export let data: any;
  $: org = data.activeOrg;

  let instanceName = '';
  let endpointUrl = '';
  let adminToken = '';
  let loading = false;
  let error = '';

  async function handleCreate() {
    if (!org) { error = 'No organization found.'; return; }
    if (!endpointUrl.trim()) { error = 'Arc server URL is required.'; return; }
    error = '';
    loading = true;
    try {
      const instance = await createInstance(org.id, {
        name: instanceName.trim() || undefined,
        endpoint_url: endpointUrl.trim(),
        admin_token: adminToken.trim() || undefined,
      });
      goto(`/instances/${instance.id}`);
    } catch (err: any) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
</script>

<div class="mx-auto max-w-2xl px-8 py-8">
  <div class="mb-8">
    <a href="/instances" class="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft class="h-4 w-4" />
      Back to instances
    </a>
    <h1 class="text-2xl font-bold">Connect an Arc server</h1>
    <p class="mt-1 text-sm text-muted-foreground">
      Point Launchpad at an existing Arc database server to query and manage it.
    </p>
  </div>

  {#if error}
    <div class="mb-6 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
  {/if}

  <div class="space-y-6">
    <section>
      <label for="instance-name" class="mb-1 block text-sm font-semibold">Name</label>
      <p class="mb-2 text-xs text-muted-foreground">Optional label to identify this server.</p>
      <input
        id="instance-name"
        type="text"
        bind:value={instanceName}
        placeholder="Production Arc"
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </section>

    <section>
      <label for="endpoint-url" class="mb-1 block text-sm font-semibold">Arc server URL</label>
      <p class="mb-2 text-xs text-muted-foreground">Base URL of the Arc HTTP API, e.g. https://arc.example.com:8000</p>
      <input
        id="endpoint-url"
        type="url"
        bind:value={endpointUrl}
        placeholder="https://arc.example.com:8000"
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </section>

    <section>
      <label for="admin-token" class="mb-1 block text-sm font-semibold">Admin / API token</label>
      <p class="mb-2 text-xs text-muted-foreground">
        A bearer token with access to this Arc server. Stored securely and used to authenticate queries.
      </p>
      <input
        id="admin-token"
        type="password"
        bind:value={adminToken}
        placeholder="arc_..."
        autocomplete="off"
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </section>

    <div class="border-t pt-6">
      <Button size="lg" on:click={handleCreate} disabled={loading || !endpointUrl.trim()}>
        {loading ? 'Connecting...' : 'Connect'}
      </Button>
    </div>
  </div>
</div>
