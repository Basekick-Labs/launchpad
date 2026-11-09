<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { ClusterApiError, getGovernance, getTokenQueryUsage } from '$lib/cloudApi';
  import {
    isUnlimited,
    LIMIT_FIELDS,
    LIMIT_INFO,
    limitText,
    usageLines,
    type GovernanceView,
    type LimitField,
    type NodeUsage,
    type TokenPolicyView,
  } from '$lib/governance';
  import { describeClusterError } from '$lib/cluster';
  import { formatAge } from '$lib/format';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { RefreshCw } from 'lucide-svelte';

  export let orgId: string;
  export let instanceId: string;
  /** Token to show usage for (from the Tokens section). */
  export let focusTokenId: number | null = null;

  const dispatch = createEventDispatcher<{ openToken: number }>();

  let view: GovernanceView | null = null;
  let error: string | null = null;
  let loading = false;
  let now = Date.now();
  let selected: number | null = focusTokenId;
  let usage: NodeUsage[] | null = null;
  let usageError: string | null = null;
  let usageFor: number | null = null;
  let viewAbort: AbortController | null = null;
  let usageAbort: AbortController | null = null;

  const failure = (err: unknown, what: string) => (err instanceof ClusterApiError ? describeClusterError(err.code) : `Could not load ${what}`);
  const aborted = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

  async function load() {
    viewAbort?.abort();
    const ctl = (viewAbort = new AbortController());
    loading = true;
    try {
      view = await getGovernance(orgId, instanceId, ctl.signal);
      error = null;
    } catch (err) {
      if (!aborted(err)) error = failure(err, 'query limits');
    } finally {
      if (viewAbort === ctl) {
        loading = false;
        now = Date.now();
      }
    }
  }
  load();

  async function loadUsage(tokenId: number) {
    usageAbort?.abort();
    const ctl = (usageAbort = new AbortController());
    usageFor = tokenId;
    usage = null;
    usageError = null;
    try {
      const u = await getTokenQueryUsage(orgId, instanceId, tokenId, ctl.signal);
      if (usageAbort === ctl) usage = u;
    } catch (err) {
      if (usageAbort === ctl && !aborted(err)) usageError = failure(err, 'usage');
    }
  }
  function reload() {
    load();
    if (selected !== null) loadUsage(selected);
  }
  onDestroy(() => {
    viewAbort?.abort();
    usageAbort?.abort();
  });

  $: if (focusTokenId !== null) selected = focusTokenId;
  $: if (selected !== null && selected !== usageFor) loadUsage(selected);

  $: tokenName = new Map((view?.tokens ?? []).map((t) => [t.id, t.name]));
  $: clustered = (view?.nodes.length ?? 0) > 1;
  $: launchpadId = view?.launchpadTokenId ?? null;
  $: launchpadPolicy = view?.policies.find((p) => p.tokenId === launchpadId) ?? null;
  /** Node defaults that limit something, which apply to every token without a policy (Launchpad's included). */
  $: defaultsOn = view?.nodes.filter((n) => n.defaults && !isUnlimited(n.defaults)) ?? [];
  $: defaultsUnknown = view?.nodes.some((n) => n.state === 'on' && !n.defaultsKnown) ?? false;
  /** A policy whose token is not in Arc's list (Arc keeps policies of deleted tokens). */
  $: orphanSelected = selected !== null && !!view?.tokensLoaded && !tokenName.has(selected);

  function name(id: number): string {
    return tokenName.get(id) ?? (view?.tokensLoaded ? `token ${id} (deleted)` : `token ${id}`);
  }
  /** Where a limit differs: each node's value. */
  function perNode(p: TokenPolicyView, field: LimitField): string {
    return Object.entries(p.byNode)
      .map(([node, l]) => `${node}: ${l ? limitText(field, l[field]) : 'no policy'}`)
      .join(' · ');
  }

  const STATE: Record<string, { label: string; variant: 'success' | 'secondary' | 'destructive' | 'outline' }> = {
    on: { label: 'on', variant: 'success' },
    off: { label: 'off', variant: 'secondary' },
    refused: { label: 'refused', variant: 'destructive' },
    unreachable: { label: 'not reachable', variant: 'destructive' },
  };
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between gap-2">
    <div>
      <h3 class="font-semibold">Query limits</h3>
      <p class="text-xs text-muted-foreground">
        Arc limits how much each token can query: rates, quotas, rows per query and query time. 0 means unlimited. Admin tokens
        are limited too.{#if clustered} Arc keeps limits on each node separately, and each node counts on its own: a limit of X
        per node allows about X × nodes across the cluster.{/if}
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      {#if view}<span class="text-xs text-muted-foreground">loaded {formatAge(now - view.loadedAt)}</span>{/if}
      <Button variant="ghost" size="sm" on:click={reload} disabled={loading} aria-label="Reload query limits">
        <RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
      </Button>
    </div>
  </div>

  {#if !view && error}
    <p class="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">Could not load query limits: {error}.</p>
  {:else if !view}
    <p class="py-6 text-center text-sm text-muted-foreground">Loading query limits…</p>
  {:else}
    {#if error}
      <p class="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">Could not reload: {error}. Showing what was loaded {formatAge(now - view.loadedAt)}.</p>
    {/if}
    {#if view.truncated}
      <p class="text-xs text-muted-foreground">A node holds more policies than Launchpad shows; the list is cut short.</p>
    {/if}
    {#if launchpadId !== null}
      <div class="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100" role="note">
        Launchpad connects with <strong class="font-mono">{name(launchpadId)}</strong>: the console, the data explorer and alerts
        all query with it, for every member. Limits on it slow down or cut off queries for everyone, and alerts report
        "Throttled by Arc query governance".
        {#if launchpadPolicy}
          It has its own limits{launchpadPolicy.inSync ? '' : launchpadPolicy.unknownOn.length ? ', not known on every node' : ', different per node'}.
        {:else if defaultsOn.length}
          It has no policy of its own, so the server defaults below apply to it.
        {:else if defaultsUnknown || view.nodes.some((n) => n.servesQueries && n.state !== 'on')}
          It has no policy of its own on the nodes that answered; whether server defaults limit it is not known.
        {:else}
          It is not limited.
        {/if}
      </div>
    {/if}

    {#if clustered || view.nodes.some((n) => n.state !== 'on')}
      <div class="flex flex-wrap gap-2 text-xs" aria-label="Governance per node">
        {#each view.nodes as n (n.nodeId)}
          <span class="inline-flex items-center gap-1.5 rounded border px-2 py-1">
            <span class="font-mono">{n.nodeId === 'standalone' ? 'this instance' : n.nodeId}</span>
            <Badge variant={STATE[n.state].variant}>{STATE[n.state].label}</Badge>
            {#if n.issue}<span class="text-muted-foreground">{n.issue.message}</span>{/if}
            {#if n.state === 'on' && !n.defaultsKnown}<span class="text-muted-foreground">(server defaults could not be read)</span>{/if}
            {#if !n.servesQueries}<span class="text-muted-foreground">(compactor: never applies limits)</span>{/if}
          </span>
        {/each}
      </div>
    {/if}

    {#if defaultsOn.length}
      <section class="rounded-lg border bg-card p-4 text-sm" aria-labelledby="gov-defaults">
        <h4 id="gov-defaults" class="font-semibold">Server defaults</h4>
        <p class="text-xs text-muted-foreground">Set in Arc's configuration; they apply to every token without its own policy.</p>
        <ul class="mt-2 space-y-1">
          {#each defaultsOn as n (n.nodeId)}
            <li>
              {#if clustered}<span class="font-mono text-xs">{n.nodeId}: </span>{/if}
              {LIMIT_FIELDS.filter((f) => n.defaults?.[f]).map((f) => `${LIMIT_INFO[f].label} ${limitText(f, n.defaults?.[f] ?? 0)}`).join(' · ')}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section class="rounded-lg border bg-card p-4" aria-labelledby="gov-policies">
      <h4 id="gov-policies" class="mb-2 font-semibold">Tokens with their own limits</h4>
      {#if view.policies.length === 0}
        <p class="text-sm text-muted-foreground">No token has its own limits{defaultsOn.length ? '; the server defaults apply to all' : ''}{view.nodes.some((n) => n.servesQueries && n.state !== 'on') ? ' on the nodes that answered' : ''}.</p>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" class="py-1 pr-3 font-medium">Token</th>
                {#each LIMIT_FIELDS as f}<th scope="col" class="py-1 pr-3 font-medium">{LIMIT_INFO[f].label}</th>{/each}
                {#if clustered}<th scope="col" class="py-1 font-medium">Nodes</th>{/if}
              </tr>
            </thead>
            <tbody class="divide-y">
              {#each view.policies as p (p.tokenId)}
                <tr class={p.tokenId === selected ? 'bg-accent' : ''}>
                  <th scope="row" class="py-1.5 pr-3 text-left font-normal">
                    <button type="button" class="font-mono underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-pressed={p.tokenId === selected} on:click={() => (selected = p.tokenId)}>{name(p.tokenId)}</button>
                    {#if p.tokenId === launchpadId}<Badge variant="outline">Launchpad</Badge>{/if}
                  </th>
                  {#each LIMIT_FIELDS as f}
                    <td class="py-1.5 pr-3 text-xs">
                      {#if p.shared[f] !== null}{limitText(f, p.shared[f] ?? 0)}{:else}<span class="font-medium text-yellow-700 dark:text-yellow-400">differs</span><span class="block text-muted-foreground">{perNode(p, f)}</span>{/if}
                    </td>
                  {/each}
                  {#if clustered}
                    <td class="py-1.5 text-xs">
                      {#if p.inSync}<span class="text-green-700 dark:text-green-400">same on all</span>{:else if p.unknownOn.length && LIMIT_FIELDS.every((f) => p.shared[f] !== null)}<span class="text-muted-foreground">not known on {p.unknownOn.join(', ')}</span>{:else}<span class="font-medium text-yellow-700 dark:text-yellow-400">differs between nodes</span>{/if}
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section class="rounded-lg border bg-card p-4" aria-labelledby="gov-usage">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h4 id="gov-usage" class="font-semibold">Limits and usage of a token</h4>
        <label class="flex items-center gap-2 text-sm">
          <span class="text-muted-foreground">Token</span>
          <select class="h-8 rounded-md border border-input bg-background px-2 text-sm" bind:value={selected}>
            <option value={null}>Choose a token…</option>
            {#each view.tokens as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
            {#if selected !== null && (orphanSelected || !view.tokensLoaded)}<option value={selected}>{name(selected)}</option>{/if}
          </select>
        </label>
      </div>
      {#if selected !== null}
        <p class="mt-1 text-xs">
          <button type="button" class="underline-offset-2 hover:underline" on:click={() => selected !== null && dispatch('openToken', selected)}>Open {name(selected)} in Tokens</button>
        </p>
        {#if usageError}
          <p class="mt-2 text-sm text-destructive">{usageError}</p>
        {:else if !usage}
          <p class="mt-2 text-sm text-muted-foreground">Loading…</p>
        {:else}
          <div class="mt-3 space-y-4">
            {#each usage as n (n.nodeId)}
              <div class="rounded-md border p-3">
                {#if clustered}<p class="mb-2 font-mono text-xs">{n.nodeId}{n.source ? ` · ${n.source}` : ''}</p>{/if}
                {#if n.state !== 'on' || !n.usage || !n.effective}
                  <p class="text-sm text-muted-foreground">{n.issue?.message ?? 'Not available'}</p>
                {:else}
                  <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <h5 class="text-xs font-semibold uppercase text-muted-foreground">Configured limits</h5>
                      <p class="text-xs text-muted-foreground">
                        {n.effective.from === 'policy' ? "The token's own policy" : n.effective.from === 'defaults' ? 'Server defaults (no policy of its own)' : 'No limits'}
                      </p>
                      <dl class="mt-1 grid grid-cols-2 gap-x-3 text-sm">
                        {#each LIMIT_FIELDS as f}
                          <dt class="text-muted-foreground">{LIMIT_INFO[f].label}</dt>
                          <dd>{limitText(f, n.effective.limits[f])}</dd>
                        {/each}
                      </dl>
                    </div>
                    <div>
                      <h5 class="text-xs font-semibold uppercase text-muted-foreground">Current usage</h5>
                      <p class="text-xs text-muted-foreground">Counted in memory on this node; resets when the node restarts.</p>
                      <ul class="mt-1 space-y-1 text-sm">
                        {#each usageLines(n.effective.limits, n.usage) as line (line.field)}
                          <li class="flex justify-between gap-2">
                            <span class="text-muted-foreground">{LIMIT_INFO[line.field].label}</span>
                            <span class={line.state === 'exhausted' ? 'font-medium text-destructive' : line.state === 'near' ? 'text-yellow-700 dark:text-yellow-400' : ''}>
                              {#if line.state === 'unlimited'}not tracked{:else}{(line.used ?? 0).toLocaleString('en-US')} of {line.limit.toLocaleString('en-US')}{line.state === 'exhausted' ? ' (limit reached)' : line.state === 'near' ? ' (near the limit)' : ''}{/if}
                            </span>
                          </li>
                        {/each}
                      </ul>
                      {#if n.usage.hourResetAt || n.usage.dayResetAt}
                        <p class="mt-1 text-xs text-muted-foreground">Hourly quota resets on the hour, daily at midnight UTC. Rates are rolling windows.</p>
                      {/if}
                    </div>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </section>

    <p class="text-xs text-muted-foreground">
      Viewing only for now: setting limits, applied to every node with a preview, follows in the next release.
    </p>
  {/if}
</div>
