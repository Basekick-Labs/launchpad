<script lang="ts">
  import { onMount } from 'svelte';
  import { type Instance } from '$lib/cloudApi';
  import { Server, Activity, Cpu, HardDrive, Users, Upload, Search, X, Check, Copy } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';

  export let data: any;

  $: org = data.activeOrg;
  $: instances = (data.instances || []) as Instance[];
  $: running = instances.filter(i => i.status === 'running').length;
  $: unreachable = instances.filter(i => i.status !== 'running').length;

  const canManageInstances = data.currentRole !== 'viewer';

  // Getting started
  let showGettingStarted = false;
  let copiedStep: number | null = null;

  onMount(() => {
    const dismissed = localStorage.getItem('arc-getting-started-dismissed');
    showGettingStarted = !dismissed;
  });

  function dismissGettingStarted() {
    localStorage.setItem('arc-getting-started-dismissed', 'true');
    showGettingStarted = false;
  }

  $: firstRunning = instances.find(i => i.status === 'running');
  $: endpoint = firstRunning?.endpoint_url ?? 'https://your-arc-server:8000';
  $: writeSnippet = `curl -X POST ${endpoint}/api/v1/write/line-protocol \\
  -H "Authorization: Bearer $ARC_TOKEN" \\
  -H "X-Arc-Database: mydb" \\
  --data-binary 'events user="alice",action="login"'`;

  async function copySnippet() {
    await navigator.clipboard.writeText(writeSnippet);
    copiedStep = 0;
    setTimeout(() => { copiedStep = null; }, 2000);
  }
</script>

<div class="p-6">
  <!-- Header -->
  <div class="mb-5 flex items-center justify-between">
    <div>
      <h1 class="text-xl font-bold">Dashboard</h1>
      <p class="text-sm text-muted-foreground">Welcome back, {data.user.first_name || data.user.email}</p>
    </div>
    {#if canManageInstances}
      <Button size="sm" href="/instances/new">Connect Instance</Button>
    {/if}
  </div>

  <!-- Getting Started -->
  {#if showGettingStarted}
    <div class="relative mb-5 rounded-lg border bg-card p-5">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="font-semibold">Getting started with Arc</h2>
        <button on:click={dismissGettingStarted} class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
          <X class="h-4 w-4" />
        </button>
      </div>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
        <!-- Step 1: Connect Instance -->
        <div class="rounded-lg border p-4">
          <div class="mb-3 flex items-center gap-3">
            <div class="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold {instances.length > 0 ? 'bg-green-500/10 text-green-500' : 'bg-primary/10 text-primary'}">
              {#if instances.length > 0}
                <Check class="h-4 w-4" />
              {:else}
                1
              {/if}
            </div>
            <div class="flex items-center gap-2">
              <Server class="h-4 w-4 text-muted-foreground" />
              <span class="text-sm font-medium">Connect an Instance</span>
            </div>
          </div>
          <p class="mb-3 text-xs text-muted-foreground">Connect your first Arc server to start ingesting and querying data.</p>
          {#if instances.length === 0}
            {#if canManageInstances}
              <Button size="sm" href="/instances/new">Connect Instance</Button>
            {:else}
              <p class="text-xs text-muted-foreground italic">Ask your admin to connect an instance.</p>
            {/if}
          {:else}
            <p class="text-xs text-green-600">Instance connected</p>
          {/if}
        </div>

        <!-- Step 2: Send Data -->
        <div class="rounded-lg border p-4">
          <div class="mb-3 flex items-center gap-3">
            <div class="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">2</div>
            <div class="flex items-center gap-2">
              <Upload class="h-4 w-4 text-muted-foreground" />
              <span class="text-sm font-medium">Send Data</span>
            </div>
          </div>
          <p class="mb-3 text-xs text-muted-foreground">Ingest data using the HTTP write API.</p>
          <div class="relative">
            <pre class="rounded bg-muted p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">{writeSnippet}</pre>
            <button on:click={() => copySnippet()} class="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground transition-colors">
              {#if copiedStep === 0}
                <Check class="h-3.5 w-3.5 text-green-500" />
              {:else}
                <Copy class="h-3.5 w-3.5" />
              {/if}
            </button>
          </div>
        </div>

        <!-- Step 3: Query Data -->
        <div class="rounded-lg border p-4">
          <div class="mb-3 flex items-center gap-3">
            <div class="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">3</div>
            <div class="flex items-center gap-2">
              <Search class="h-4 w-4 text-muted-foreground" />
              <span class="text-sm font-medium">Query Your Data</span>
            </div>
          </div>
          <p class="mb-3 text-xs text-muted-foreground">Use the built-in SQL console to explore and query your data in real time.</p>
          {#if firstRunning}
            <Button size="sm" variant="outline" href="/instances/{firstRunning.id}/console">Open Console</Button>
          {:else if instances.length > 0}
            <p class="text-xs text-muted-foreground italic">A reachable instance is needed to access the console.</p>
          {:else}
            <p class="text-xs text-muted-foreground italic">Connect an instance first to access the console.</p>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <!-- Stats row -->
  <div class="mb-5 flex flex-wrap gap-3">
    <div class="flex items-center gap-2.5 rounded-lg border bg-card px-4 py-2.5">
      <Server class="h-4 w-4 text-muted-foreground" />
      <span class="text-sm font-semibold">{instances.length}</span>
      <span class="text-xs text-muted-foreground">Total</span>
    </div>
    <div class="flex items-center gap-2.5 rounded-lg border bg-card px-4 py-2.5">
      <Activity class="h-4 w-4 text-green-500" />
      <span class="text-sm font-semibold">{running}</span>
      <span class="text-xs text-muted-foreground">Running</span>
    </div>
    <div class="flex items-center gap-2.5 rounded-lg border bg-card px-4 py-2.5">
      <Cpu class="h-4 w-4 text-muted-foreground" />
      <span class="text-sm font-semibold">{unreachable}</span>
      <span class="text-xs text-muted-foreground">Unreachable</span>
    </div>
    <a href="/team" class="flex items-center gap-2.5 rounded-lg border bg-card px-4 py-2.5 hover:bg-accent/50 transition-colors cursor-pointer">
      <Users class="h-4 w-4 text-muted-foreground" />
      <span class="text-sm font-semibold">{data.memberCount}</span>
      <span class="text-xs text-muted-foreground">Members</span>
    </a>
    <div class="flex items-center gap-2.5 rounded-lg border bg-card px-4 py-2.5">
      <HardDrive class="h-4 w-4 text-muted-foreground" />
      <span class="text-sm font-semibold truncate max-w-[160px]">{org?.name || '—'}</span>
      <span class="text-xs text-muted-foreground">Org</span>
    </div>
  </div>

  <!-- Instances -->
  <div class="rounded-lg border bg-card">
    <div class="border-b px-4 py-3">
      <h2 class="font-semibold">Instances</h2>
    </div>

    {#if instances.length === 0}
      <div class="p-8 text-center">
        <p class="text-muted-foreground">No instances yet</p>
        {#if canManageInstances}
          <Button class="mt-4" href="/instances/new">Connect your first instance</Button>
        {/if}
      </div>
    {:else}
      <div class="divide-y">
        {#each instances as instance}
          <a href="/instances/{instance.id}" class="flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors">
            <div class="flex items-center gap-3">
              <div class="h-2 w-2 rounded-full {instance.status === 'running' ? 'bg-green-500' : 'bg-gray-400'}" />
              <div>
                <p class="text-sm font-medium">{instance.name || instance.endpoint_url || instance.resource_id}</p>
                <p class="text-xs text-muted-foreground capitalize">{instance.status}</p>
              </div>
            </div>
            <div class="font-mono text-xs text-muted-foreground">
              {instance.endpoint_url ?? '—'}
            </div>
          </a>
        {/each}
      </div>
    {/if}
  </div>
</div>
