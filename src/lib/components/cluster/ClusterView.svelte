<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { ClusterApiError, getClusterView, type ClusterViewResponse } from '$lib/cloudApi';
  import {
    clusterSummary,
    describeClusterError,
    heartbeatAge,
    heartbeatStale,
    type ClusterNode,
    type ClusterStatus,
  } from '$lib/cluster';
  import { formatAge } from '$lib/format';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import NodeDetail from './NodeDetail.svelte';
  import { Pause, Play, RefreshCw } from 'lucide-svelte';

  export let orgId: string;
  export let instanceId: string;

  const REFRESH_MS = 15_000;

  let view: ClusterViewResponse | null = null;
  let error: ClusterApiError | null = null;
  let loading = false;
  let autoRefresh = true;
  let lastSuccess: number | null = null;
  let now = Date.now();
  let selectedId: string | null = null;
  /** Bumped after every successful refresh so the node panels refetch with it. */
  let tick = 0;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let clockTimer: ReturnType<typeof setInterval> | undefined;

  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      view = await getClusterView(orgId, instanceId);
      error = null;
      lastSuccess = Date.now();
      tick += 1;
    } catch (err) {
      // Keep the last good view on screen and say it is stale.
      error = err instanceof ClusterApiError ? err : new ClusterApiError('error', 'Could not load the cluster');
    } finally {
      loading = false;
    }
  }

  function setAuto(on: boolean) {
    autoRefresh = on;
    clearInterval(refreshTimer);
    if (on) refreshTimer = setInterval(refresh, REFRESH_MS);
  }

  onMount(() => {
    refresh();
    setAuto(true);
    clockTimer = setInterval(() => (now = Date.now()), 1000);
  });

  onDestroy(() => {
    clearInterval(refreshTimer);
    clearInterval(clockTimer);
  });

  $: status = view?.status.enabled ? (view.status as ClusterStatus) : null;
  $: standaloneReason = view && !view.status.enabled ? view.status.reason : null;
  $: summary = status ? clusterSummary(status) : null;
  $: if (status && (!selectedId || !status.nodes.some((n) => n.id === selectedId))) {
    selectedId = status.localNodeId ?? status.nodes[0]?.id ?? null;
  }
  $: selected = status?.nodes.find((n) => n.id === selectedId) ?? null;
  $: stale = lastSuccess !== null && now - lastSuccess > 2 * REFRESH_MS;

  // Heartbeat ages are measured on Arc's clock (the response Date header);
  // advance them with Launchpad's clock between refreshes.
  function age(node: ClusterNode): number | null {
    if (!view?.serverTime) return null;
    const a = heartbeatAge(node, view.serverTime);
    return a === null ? null : a + (now - view.fetchedAt);
  }

  const STATE_VARIANT: Record<string, 'success' | 'destructive' | 'secondary' | 'outline'> = {
    healthy: 'success',
    unhealthy: 'destructive',
    dead: 'destructive',
    joining: 'secondary',
    leaving: 'secondary',
    unknown: 'outline',
  };
</script>

<div class="flex h-full flex-col overflow-auto p-4">
  <div class="mb-4 flex items-center justify-between gap-4">
    <div>
      <h2 class="text-lg font-semibold">Cluster</h2>
      {#if status}
        <p class="text-xs text-muted-foreground">
          {status.clusterName ?? 'Unnamed cluster'} · as seen by <span class="font-mono">{status.localNodeId ?? 'the endpoint'}</span>
        </p>
      {/if}
    </div>
    <div class="flex items-center gap-2">
      {#if lastSuccess}
        <span class="text-xs {stale ? 'text-yellow-600 dark:text-yellow-400' : 'text-muted-foreground'}">
          {stale ? 'Stale · ' : ''}updated {formatAge(now - lastSuccess)}
        </span>
      {/if}
      <Button variant="ghost" size="sm" on:click={() => setAuto(!autoRefresh)} aria-label={autoRefresh ? 'Pause auto-refresh' : 'Resume auto-refresh'}>
        {#if autoRefresh}<Pause class="h-4 w-4" />{:else}<Play class="h-4 w-4" />{/if}
      </Button>
      <Button variant="ghost" size="sm" on:click={refresh} disabled={loading} aria-label="Refresh now">
        <RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
      </Button>
    </div>
  </div>

  {#if error && view}
    <div role="status" class="mb-4 rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-100">
      The last refresh failed ({describeClusterError(error.code)}). Showing what was loaded before.
    </div>
  {/if}

  {#if !view && loading}
    <div class="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading cluster…</div>
  {:else if !view && error}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <p class="text-sm text-destructive">Could not load the cluster: {describeClusterError(error.code)}.</p>
      <Button size="sm" variant="outline" on:click={refresh}>Try again</Button>
    </div>
  {:else if standaloneReason !== null || (view && !view.status.enabled)}
    <div class="rounded-lg border bg-card p-6 text-sm">
      <p class="font-medium">This instance runs as a single node.</p>
      <p class="mt-1 text-muted-foreground">{standaloneReason ?? 'Clustering is not enabled.'}</p>
      <p class="mt-3 text-muted-foreground">Its resource metrics and application logs are on the <strong>Monitoring</strong> tab.</p>
    </div>
  {:else if status && summary}
    <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
      <div class="rounded-lg border bg-card p-3">
        <div class="text-xs text-muted-foreground">Healthy nodes</div>
        <div class="mt-1 text-xl font-semibold {summary.healthy < summary.total ? 'text-destructive' : ''}">{summary.healthy} / {summary.total}</div>
      </div>
      <div class="rounded-lg border bg-card p-3">
        <div class="text-xs text-muted-foreground">Raft leader</div>
        <div class="mt-1 truncate font-mono text-sm">{status.leaderId ?? (status.raftEnabled ? 'No leader (election?)' : 'Raft off')}</div>
      </div>
      <div class="rounded-lg border bg-card p-3">
        <div class="text-xs text-muted-foreground">Primary writer</div>
        <div class="mt-1 truncate font-mono text-sm">{status.primaryWriterId ?? '—'}</div>
      </div>
      <div class="rounded-lg border bg-card p-3">
        <div class="text-xs text-muted-foreground">Active compactor</div>
        <div class="mt-1 truncate font-mono text-sm">{status.activeCompactorId ?? 'None assigned'}</div>
      </div>
      <div class="rounded-lg border bg-card p-3">
        <div class="text-xs text-muted-foreground">Version</div>
        <div class="mt-1 truncate font-mono text-sm {summary.mixedVersions ? 'text-yellow-600 dark:text-yellow-400' : ''}">
          {summary.mixedVersions ? `Mixed: ${summary.versions.join(', ')}` : summary.versions[0] ?? 'Not reported'}
        </div>
      </div>
    </div>

    {#if status.nodes.length === 0}
      <div class="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">Arc reports no nodes for this cluster.</div>
    {:else}
      <div class="mb-4 overflow-x-auto rounded-lg border bg-card">
        <table class="w-full text-sm">
          <thead class="border-b text-left text-xs text-muted-foreground">
            <tr>
              <th class="px-3 py-2 font-medium">Node</th>
              <th class="px-3 py-2 font-medium">Role</th>
              <th class="px-3 py-2 font-medium">State</th>
              <th class="px-3 py-2 font-medium">Version</th>
              <th class="px-3 py-2 font-medium">Last heartbeat</th>
              <th class="px-3 py-2 font-medium">From Launchpad</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            {#each status.nodes as node (node.id)}
              {@const hb = age(node)}
              {@const reach = view?.reachability[node.id]}
              <tr
                class="cursor-pointer hover:bg-accent/50 {node.id === selectedId ? 'bg-accent' : ''}"
                on:click={() => (selectedId = node.id)}
                on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && (selectedId = node.id)}
                tabindex="0"
                aria-selected={node.id === selectedId}
              >
                <td class="px-3 py-2">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="font-mono">{node.name}</span>
                    {#if node.id === status.leaderId}<Badge variant="outline">leader</Badge>{/if}
                    {#if node.id === status.primaryWriterId || node.writerState === 'primary'}<Badge variant="outline">primary</Badge>{/if}
                    {#if node.isActiveCompactor || node.id === status.activeCompactorId}<Badge variant="outline">compactor</Badge>{/if}
                    {#if node.id === status.localNodeId}<Badge variant="secondary">answering</Badge>{/if}
                  </div>
                </td>
                <td class="px-3 py-2 text-muted-foreground">
                  {node.role}{node.writerState && node.writerState !== 'primary' ? ` (${node.writerState})` : ''}{node.raftSuffrage ? ` · raft ${node.raftSuffrage}` : ''}
                </td>
                <td class="px-3 py-2"><Badge variant={STATE_VARIANT[node.state]}>{node.state}</Badge></td>
                <td class="px-3 py-2 font-mono text-xs">{node.version ?? '—'}</td>
                <td class="px-3 py-2 text-xs {heartbeatStale(hb, view?.checkIntervalMs ?? null) ? 'font-medium text-destructive' : 'text-muted-foreground'}">
                  {node.id === status.localNodeId ? 'answering node' : formatAge(hb)}
                </td>
                <td class="px-3 py-2 text-xs">
                  {#if !reach}
                    <span class="text-muted-foreground">—</span>
                  {:else if reach.reachable}
                    <span class="text-green-600 dark:text-green-400">Reachable</span>
                  {:else}
                    <span class="text-destructive">{describeClusterError(reach.error)}</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      {#if selected}
        {#key selected.id}
          <NodeDetail {orgId} {instanceId} node={selected} {tick} reachability={view?.reachability[selected.id] ?? null} />
        {/key}
      {/if}
    {/if}
  {/if}
</div>
