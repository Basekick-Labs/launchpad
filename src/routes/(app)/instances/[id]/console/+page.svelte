<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { getConnectionInfo, getInstanceCapabilities, type ConnectionInfo } from '$lib/cloudApi';
  import { capabilityIn, type CapabilitiesView, type CapabilityId, type CapabilityState } from '$lib/capabilities';
  import { roleAtLeast } from '$lib/roles';
  import { ArcClient, type QueryResult } from '$lib/arcClient';
  import SQLConsole from '$lib/components/SQLConsole.svelte';
  import SchemaExplorer from '$lib/components/SchemaExplorer.svelte';
  import Monitoring from '$lib/components/Monitoring.svelte';
  import TokensView from '$lib/components/access/TokensView.svelte';
  import RetentionPolicies from '$lib/components/RetentionPolicies.svelte';
  import ContinuousQueries from '$lib/components/ContinuousQueries.svelte';
  import Alerts from '$lib/components/Alerts.svelte';
  import MqttSubscriptions from '$lib/components/MqttSubscriptions.svelte';
  import { LogExplorer } from '$lib/components/logs';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    ArrowLeft, Terminal, Activity, FileText, Database,
    Clock, BarChart3, Key, Bell, Radio, Network
  } from 'lucide-svelte';

  export let data: any;

  $: org = data.activeOrg as { id: string; name: string } | undefined;
  $: instanceId = $page.params.id!;

  let connection: ConnectionInfo | null = null;
  let client: ArcClient | null = null;
  let loading = true;
  let error = '';

  type ViewId = 'console' | 'monitoring' | 'logs' | 'retention' | 'continuous-queries' | 'alerts' | 'mqtt' | 'tokens' | 'cluster';
  let activeView: ViewId = 'console';
  /**
   * The tab named in ?view=, kept in the URL so a reload or a shared link opens
   * it. Capability tabs only become visible once discovery answers, so the
   * request waits until the tab exists.
   */
  let requestedView: string | null = $page.url.searchParams.get('view');
  $: if (requestedView && visibleTabs.some((t) => t.id === requestedView)) {
    const id = requestedView;
    requestedView = null;
    setView(id);
  }

  async function setView(id: string) {
    if (!visibleTabs.some((t) => t.id === id)) return;
    activeView = id as ViewId;
    if ($page.url.searchParams.get('view') !== id) {
      const url = new URL($page.url);
      if (id === 'console') url.searchParams.delete('view');
      else url.searchParams.set('view', id);
      goto(url, { replaceState: true, noScroll: true, keepFocus: true });
    }
    if (org && !connection) {
      try {
        connection = await getConnectionInfo(org.id, instanceId);
      } catch { /* ignore */ }
    }
  }

  let statusRowCount: number | null = null;
  let statusColumnCount: number | null = null;
  let statusExecutionTime: number | null = null;

  // A tab with `capability` appears only when the instance serves it (#6).
  // Enterprise views (#7–#14) add an entry here and one in CAPABILITIES.
  interface ConsoleTab {
    id: ViewId;
    label: string;
    icon: typeof Terminal;
    disabled: boolean;
    capability?: CapabilityId;
    /** Capability states that show the tab; default: available only. */
    showWhen?: readonly CapabilityState[];
  }

  const tabs: ConsoleTab[] = [
    { id: 'console', label: 'SQL Console', icon: Terminal, disabled: false },
    { id: 'logs', label: 'Log Viewer', icon: FileText, disabled: false },
    { id: 'monitoring', label: 'Monitoring', icon: Activity, disabled: false },
    { id: 'retention', label: 'Retention', icon: Clock, disabled: false },
    { id: 'continuous-queries', label: 'Continuous Queries', icon: BarChart3, disabled: false },
    { id: 'alerts', label: 'Alerts', icon: Bell, disabled: false },
    { id: 'mqtt', label: 'MQTT', icon: Radio, disabled: false },
    { id: 'tokens', label: 'Tokens', icon: Key, disabled: false },
    // Also shown when licensed but turned off, where it explains the
    // single-node state instead of disappearing.
    { id: 'cluster', label: 'Cluster', icon: Network, disabled: false, capability: 'cluster', showWhen: ['available', 'disabled'] },
  ];

  let capabilities: CapabilitiesView | null = null;
  // Enterprise instances get access control in the Tokens tab (admin-only,
  // like the capability). RBAC is 'available', or 'unlicensed' on an instance
  // that has a license configured (lapsed or failed): tokens can still be in
  // teams there, and removing them is the way out. A plain OSS Arc also
  // answers RBAC as unlicensed, but has no license at all: Tokens only.
  $: rbacServed =
    capabilityIn(capabilities, 'rbac', ['available']) ||
    (capabilityIn(capabilities, 'rbac', ['unlicensed']) && !!capabilities?.showEnterprise);

  // Query governance is on: the Access tab adds Query limits.
  $: governanceServed = capabilityIn(capabilities, 'query_governance', ['available']);

  // Clustering is on (not just licensed): Monitoring then points to the Cluster tab.
  $: clusterServed = capabilityIn(capabilities, 'cluster', ['available']);
  $: visibleTabs = tabs
    .filter((t) => !t.capability || capabilityIn(capabilities, t.capability, t.showWhen ?? ['available']))
    .map((t) => (t.id === 'tokens' && (rbacServed || governanceServed) ? { ...t, label: 'Access' } : t));

  onMount(async () => {
    if (!org) return;
    // Only probe when some tab depends on it and the role could see one
    // (capabilities are admin-only today); never block the console on it.
    if (tabs.some((t) => t.capability) && roleAtLeast(data.currentRole ?? '', 'admin')) {
      getInstanceCapabilities(org.id, instanceId)
        .then((view) => { capabilities = view; })
        .catch(() => { /* capability tabs stay hidden */ });
    }
    try {
      connection = await getConnectionInfo(org!.id, instanceId);
      // Use server-side proxy — it auto-injects admin auth, no client-side token needed
      const proxyBaseUrl = `/api/v1/orgs/${org!.id}/instances/${instanceId}/proxy`;
      client = new ArcClient(proxyBaseUrl, '');
    } catch (err: any) {
      error = err.message;
    } finally {
      loading = false;
    }
  });

  function handleQueryExecuted(event: CustomEvent<{ result: QueryResult | null; query: string; error: string; executionTime?: number }>) {
    const { result, executionTime } = event.detail;
    if (result) {
      statusRowCount = result.rows?.length || 0;
      statusColumnCount = result.columns?.length || 0;
      statusExecutionTime = executionTime || null;
    } else {
      statusRowCount = null;
      statusColumnCount = null;
      statusExecutionTime = null;
    }
  }
</script>

<div class="flex h-full flex-col">
  <!-- Console Header -->
  <header class="flex items-center justify-between border-b bg-card px-4 py-2">
    <div class="flex items-center gap-3">
      <a href="/instances/{instanceId}" class="text-muted-foreground hover:text-foreground">
        <ArrowLeft class="h-4 w-4" />
      </a>
      {#if connection?.url}
        <div class="flex items-center gap-2">
          <div class="h-2 w-2 rounded-full {connection.status === 'running' ? 'bg-green-500' : 'bg-red-500'}" />
          <span class="font-mono text-sm">{new URL(connection.url).hostname}</span>
        </div>
      {/if}
    </div>

    <!-- Tabs -->
    <div class="flex items-center gap-1">
      {#each visibleTabs as tab}
        <button
          class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors
            {tab.disabled ? 'text-muted-foreground/40 cursor-not-allowed' : activeView === tab.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}"
          on:click={() => !tab.disabled && setView(tab.id)}
          title={tab.disabled ? 'Available on paid plans' : ''}
        >
          <svelte:component this={tab.icon} class="h-3.5 w-3.5" />
          {tab.label}
        </button>
      {/each}
    </div>
  </header>

  <!-- Content -->
  <div class="flex-1 overflow-hidden">
    {#if loading}
      <div class="flex h-full items-center justify-center text-muted-foreground">Connecting to instance...</div>
    {:else if error}
      <div class="flex h-full items-center justify-center">
        <div class="text-center">
          <p class="text-destructive">{error}</p>
          <Button class="mt-4" href="/instances/{instanceId}">Back to instance</Button>
        </div>
      </div>
    {:else if client}
      {#if activeView === 'console'}
        <SQLConsole {client} on:queryExecuted={handleQueryExecuted} />
      {:else if activeView === 'monitoring'}
        <Monitoring {client} onOpenCluster={clusterServed ? () => setView('cluster') : null} />
      {:else if activeView === 'logs'}
        <LogExplorer {client} />
      {:else if activeView === 'retention'}
        <RetentionPolicies {client} />
      {:else if activeView === 'continuous-queries'}
        <ContinuousQueries {client} />
      {:else if activeView === 'alerts'}
        <Alerts orgId={org?.id ?? ''} {instanceId} />
      {:else if activeView === 'mqtt'}
        <MqttSubscriptions {client} currentRole={data.currentRole ?? 'viewer'} />
      {:else if activeView === 'cluster' && org}
        <!-- Loaded on demand: only admins of clustered instances open it. Keyed so
             switching instances starts from a clean view. -->
        {#await import('$lib/components/cluster/ClusterView.svelte') then mod}
          {#key instanceId}
            <svelte:component this={mod.default} orgId={org.id} {instanceId} />
          {/key}
        {/await}
      {:else if activeView === 'tokens' && org}
        {#key instanceId}
          <TokensView {client} arcVersion={connection?.arc_version ?? ''} orgId={org.id} {instanceId} withAccess={rbacServed} withLimits={governanceServed} />
        {/key}
      {/if}
    {/if}
  </div>

  <!-- Status Bar -->
  {#if client}
    <StatusBar
      isConnected={true}
      connectionName={connection?.resource_id || ''}
      connectionUrl={connection?.url || ''}
      rowCount={statusRowCount}
      columnCount={statusColumnCount}
      executionTime={statusExecutionTime}
    />
  {/if}
</div>
