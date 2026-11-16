<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { cancelArcQuery, ClusterApiError, getQueries, getQueryDetail } from '$lib/cloudApi';
  import {
    describeCancel,
    FINISHED_STATUSES,
    matchesFilter,
    NO_FILTER,
    STATUS_LABEL,
    tokenLabel,
    type QueriesView,
    type QueryDetail,
    type QueryFilter,
    type QueryStatus,
    type TrackedQuery,
  } from '$lib/queryManagement';
  import type { CapabilityView } from '$lib/capabilities';
  import { dataAgeMs } from '$lib/cluster';
  import { formatAge, formatCount, formatDurationMs } from '$lib/format';
  import { formatDateTime, timezone } from '$lib/stores/timezone';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Gauge, Pause, Play, RefreshCw, X } from 'lucide-svelte';

  export let orgId: string;
  export let instanceId: string;
  /** The query_management capability: 'disabled' explains how to turn it on instead of loading. */
  export let capability: CapabilityView | null = null;

  const dispatch = createEventDispatcher<{ recheck: void }>();

  const REFRESH_MS = 5000;

  let view: QueriesView | null = null;
  /** Browser time the current view arrived; ages are counted from here. */
  let receivedAt = 0;
  let error: ClusterApiError | null = null;
  let loading = false;
  let autoRefresh = true;
  let now = Date.now();
  let controller: AbortController | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let clockTimer: ReturnType<typeof setInterval> | undefined;

  let filter: QueryFilter = { ...NO_FILTER };

  /** The query whose detail is open, by node and id. */
  let selected: { nodeId: string; id: string } | null = null;
  let detail: QueryDetail | null = null;
  let detailError: string | null = null;
  let detailController: AbortController | null = null;

  /** The query the cancel dialog asks about; null closes it. */
  let confirming: TrackedQuery | null = null;
  let cancelling = false;
  let cancelError: string | null = null;
  /** The last cancel's outcome, kept until the next one. */
  let outcome: { text: string; ok: boolean } | null = null;

  $: disabled = capability?.state === 'disabled';

  let request = 0;

  /** Load the lists. A poll skips while one is in flight; `force` (after a cancel) replaces it. */
  async function refresh(force = false) {
    if (disabled || (loading && !force)) return;
    controller?.abort();
    const c = (controller = new AbortController());
    const mine = ++request;
    loading = true;
    try {
      const v = await getQueries(orgId, instanceId, c.signal);
      if (mine !== request) return;
      view = v;
      receivedAt = Date.now();
      error = null;
    } catch (err) {
      if (c.signal.aborted || mine !== request) return;
      // Keep the last good lists on screen and say the refresh failed.
      error = err instanceof ClusterApiError ? err : new ClusterApiError('error', 'Could not load the queries');
    } finally {
      if (mine === request) loading = false;
    }
  }

  function setAuto(on: boolean) {
    autoRefresh = on;
    clearInterval(refreshTimer);
    if (on) refreshTimer = setInterval(() => document.visibilityState === 'visible' && refresh(), REFRESH_MS);
  }

  // A hidden tab stops polling; coming back refreshes at once.
  function onVisibility() {
    if (document.visibilityState === 'visible' && autoRefresh) refresh();
  }

  onMount(() => {
    setAuto(true);
    clockTimer = setInterval(() => (now = Date.now()), 1000);
    document.addEventListener('visibilitychange', onVisibility);
  });

  onDestroy(() => {
    clearInterval(refreshTimer);
    clearInterval(clockTimer);
    controller?.abort();
    detailController?.abort();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  });

  // The first load, and the one after "Check again" finds it turned on.
  $: if (!disabled && !view && !loading && !error && typeof document !== 'undefined') refresh();

  $: clustered = !!view && !(view.nodes.length === 1 && view.nodes[0].nodeId === 'standalone');
  $: missing = view?.nodes.filter((n) => n.state !== 'on') ?? [];
  $: allOff = !!view && view.nodes.length > 0 && view.nodes.every((n) => n.state === 'off');
  $: sources = new Map(view?.nodes.map((n) => [n.nodeId, n.source]) ?? []);
  $: ageOfView = view ? dataAgeMs(view, receivedAt, now) : 0;
  $: stale = autoRefresh && view !== null && ageOfView > 3 * REFRESH_MS;

  $: active = view?.active.filter((q) => matchesFilter(q, { ...filter, status: null })) ?? [];
  $: history = view?.history.filter((q) => matchesFilter(q, filter)) ?? [];
  $: tokens = [...new Set([...(view?.active ?? []), ...(view?.history ?? [])].map(tokenLabel))].sort();
  $: filtered = filter.node !== null || filter.token !== null || filter.status !== null || filter.search.trim() !== '';

  // Reactive, so the rows that use them update with the view and the clock.
  $: isLaunchpad = (q: TrackedQuery) => view?.launchpadTokenId != null && q.tokenId === view.launchpadTokenId;
  /** Running for: Arc's elapsed time when it answered, plus the view's age since. */
  $: runningFor = (q: TrackedQuery) => q.durationMs + ageOfView;
  const sameQuery = (a: { nodeId: string; id: string } | null, b: { nodeId: string; id: string }) => !!a && a.nodeId === b.nodeId && a.id === b.id;

  // The open query as the lists show it now: a running one that finished
  // moves to the history, and the detail follows it there.
  $: listed = selected ? view?.active.find((q) => sameQuery(selected, q)) ?? view?.history.find((q) => sameQuery(selected, q)) ?? null : null;
  // Only running → finished: a detail read after the list can be newer than it, never older.
  $: if (detail?.query.status === 'running' && listed && listed.status !== 'running') loadDetail(listed);

  async function loadDetail(q: { nodeId: string; id: string }) {
    detailController?.abort();
    const c = (detailController = new AbortController());
    detailError = null;
    try {
      const d = await getQueryDetail(orgId, instanceId, q.nodeId, q.id, c.signal);
      if (sameQuery(selected, q)) detail = d;
    } catch (err) {
      if (c.signal.aborted) return;
      detailError = err instanceof ClusterApiError ? err.message : 'Could not load the query';
    }
  }

  function open(q: TrackedQuery) {
    if (sameQuery(selected, q)) return close();
    selected = { nodeId: q.nodeId, id: q.id };
    detail = null;
    loadDetail(q);
  }

  function close() {
    detailController?.abort();
    selected = null;
    detail = null;
    detailError = null;
  }

  function askCancel(q: TrackedQuery) {
    confirming = q;
    cancelError = null;
  }

  async function confirmCancel() {
    if (!confirming) return;
    const q = confirming;
    cancelling = true;
    cancelError = null;
    try {
      const o = await cancelArcQuery(orgId, instanceId, q.nodeId, q.id);
      outcome = { text: describeCancel(o), ok: o.result === 'cancelled' };
      confirming = null;
      if (sameQuery(selected, q) && o.query) detail = { query: o.query, source: detail?.source ?? sources.get(q.nodeId) ?? '' };
      await refresh(true);
    } catch (err) {
      // The dialog stays open with the reason, so the target is still in view.
      cancelError = err instanceof ClusterApiError ? err.message : 'The cancel could not be sent';
    } finally {
      cancelling = false;
    }
  }

  function onDialogOpenChange(isOpen: boolean) {
    if (!isOpen && !cancelling) confirming = null;
  }

  function setFilter(patch: Partial<QueryFilter>) {
    filter = { ...filter, ...patch };
  }

  function setStatus(value: string) {
    setFilter({ status: FINISHED_STATUSES.find((s) => s === value) ?? null });
  }

  const STATE: Record<string, { label: string; variant: 'secondary' | 'destructive' }> = {
    off: { label: 'query management off', variant: 'secondary' },
    refused: { label: 'refused', variant: 'destructive' },
    unreachable: { label: 'not reachable', variant: 'destructive' },
  };
  const STATUS_TONE: Record<QueryStatus, string> = {
    running: 'text-blue-600 dark:text-blue-400',
    completed: 'text-muted-foreground',
    cancelled: 'text-yellow-700 dark:text-yellow-400',
    failed: 'text-red-600 dark:text-red-400',
    timed_out: 'text-red-600 dark:text-red-400',
  };
  const inputClass = 'h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const code = 'rounded bg-muted px-1 py-0.5 font-mono text-xs';
  const nodeLabel = (id: string) => (id === 'standalone' ? 'this instance' : id);
  const oneLine = (sql: string) => sql.replace(/\s+/g, ' ').trim();
</script>

<div class="flex h-full flex-col overflow-auto p-4 [&>*]:shrink-0">
  <div class="mb-4 flex items-start justify-between gap-4">
    <div>
      <h2 class="flex items-center gap-2 text-lg font-semibold"><Gauge class="h-5 w-5" /> Queries</h2>
      <p class="mt-1 max-w-3xl text-xs text-muted-foreground">
        The SQL queries Arc is running now and the ones it finished recently{clustered ? ', on every node' : ''}. Arc keeps them in
        memory{clustered ? ' on the node that runs them' : ''}: a restart clears them, and only the last finished ones are kept
        (<code class={code}>history_size</code>, 100 by default). Queries Launchpad sends (the SQL console, the Log Viewer and
        alerts) use its stored token.
      </p>
    </div>
    {#if !disabled}
      <div class="flex shrink-0 items-center gap-2">
        {#if view}
          <span class="text-xs {stale ? 'text-yellow-600 dark:text-yellow-400' : 'text-muted-foreground'}">
            {stale ? 'Stale · ' : ''}updated {formatAge(ageOfView)}
          </span>
        {/if}
        <Button variant="ghost" size="sm" on:click={() => setAuto(!autoRefresh)} aria-label={autoRefresh ? 'Pause auto-refresh' : 'Resume auto-refresh'}>
          {#if autoRefresh}<Pause class="h-4 w-4" />{:else}<Play class="h-4 w-4" />{/if}
        </Button>
        <Button variant="ghost" size="sm" on:click={() => refresh()} disabled={loading} aria-label="Refresh now">
          <RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
        </Button>
      </div>
    {/if}
  </div>

  {#if disabled || allOff}
    <div class="rounded-lg border bg-card p-6 text-sm">
      <p class="font-medium">Query management is not enabled on this instance</p>
      <p class="mt-2 text-muted-foreground">
        The license includes it, but Arc only tracks queries when it is turned on. Set
        <code class={code}>enabled = true</code> in the <code class={code}>[query_management]</code> section of the instance's
        <code class={code}>arc.toml</code>:
      </p>
      <pre class="mt-3 rounded-md bg-muted p-4 text-xs font-mono">[query_management]
enabled = true
history_size = 100</pre>
      <p class="mt-3 text-xs text-muted-foreground">
        The arc.toml Arc ships has this section commented out: uncomment it rather than adding a second one, which stops Arc
        from starting. Or set <code class={code}>ARC_QUERY_MANAGEMENT_ENABLED=true</code> in Arc's environment, which overrides
        arc.toml. Then restart the Arc server{clustered ? ', on every node' : ''}.
      </p>
      <Button class="mt-4" variant="outline" size="sm" on:click={() => { dispatch('recheck'); view = null; error = null; }}>
        <RefreshCw class="mr-2 h-4 w-4" /> Check again
      </Button>
    </div>
  {:else if !view && error}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <p class="text-sm text-destructive">Could not load the queries: {error.message}.</p>
      <Button size="sm" variant="outline" on:click={() => refresh()}>Try again</Button>
    </div>
  {:else if !view}
    <div class="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading queries…</div>
  {:else}
    {#if error}
      <div role="status" class="mb-3 rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-100">
        The last refresh failed ({error.message}). Showing what was loaded before.
      </div>
    {/if}

    {#if missing.length}
      <div role="status" class="mb-3 rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-100">
        <p class="font-medium">
          {#if clustered}Not shown: the queries of {missing.length} node{missing.length === 1 ? '' : 's'}.{:else}This instance's queries could not be read.{/if}
        </p>
        <ul class="mt-1 space-y-0.5 text-xs">
          {#each missing as n (n.nodeId)}
            <li class="flex flex-wrap items-center gap-1.5">
              {#if clustered}<span class="font-mono">{n.nodeId}</span>{/if}
              <Badge variant={STATE[n.state]?.variant ?? 'secondary'}>{STATE[n.state]?.label ?? n.state}</Badge>
              {n.issue?.message ?? ''}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if outcome}
      <div role="status" class="mb-3 flex items-start justify-between gap-2 rounded-lg border p-3 text-sm {outcome.ok ? 'border-green-200 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-100' : 'bg-card'}">
        <span>{outcome.text}</span>
        <button type="button" class="text-muted-foreground hover:text-foreground" aria-label="Dismiss" on:click={() => (outcome = null)}><X class="h-4 w-4" /></button>
      </div>
    {/if}

    <div class="mb-3 flex flex-wrap items-end gap-2" role="group" aria-label="Filter queries">
      {#if clustered}
        <label class="flex flex-col gap-1 text-xs text-muted-foreground">
          Node
          <select value={filter.node ?? ''} on:change={(e) => setFilter({ node: e.currentTarget.value || null })} class={inputClass}>
            <option value="">All nodes</option>
            {#each view.nodes as n (n.nodeId)}<option value={n.nodeId}>{n.nodeId}</option>{/each}
          </select>
        </label>
      {/if}
      <label class="flex flex-col gap-1 text-xs text-muted-foreground">
        Token
        <select value={filter.token ?? ''} on:change={(e) => setFilter({ token: e.currentTarget.value || null })} class={inputClass}>
          <option value="">All tokens</option>
          {#each tokens as t}<option value={t}>{t}</option>{/each}
        </select>
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted-foreground">
        Finished as
        <select value={filter.status ?? ''} on:change={(e) => setStatus(e.currentTarget.value)} class={inputClass}>
          <option value="">Any status</option>
          {#each FINISHED_STATUSES as s}<option value={s}>{STATUS_LABEL[s]}</option>{/each}
        </select>
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted-foreground">
        Search
        <input value={filter.search} on:input={(e) => setFilter({ search: e.currentTarget.value })} placeholder="SQL, query id or error" maxlength="200" class="{inputClass} w-56" />
      </label>
      {#if filtered}
        <Button type="button" variant="ghost" size="sm" on:click={() => (filter = { ...NO_FILTER })}>Clear</Button>
      {/if}
    </div>

    <section class="mb-4 rounded-lg border bg-card" aria-labelledby="queries-active">
      <h3 id="queries-active" class="border-b px-3 py-2 text-sm font-semibold">
        Running <span class="font-normal text-muted-foreground">{formatCount(active.length)}{filtered ? ` of ${formatCount(view.active.length)}` : ''}</span>
      </h3>
      {#if view.nodes.some((n) => n.activeTruncated)}
        <p class="border-b px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">A node runs more queries than Launchpad lists; the oldest are shown.</p>
      {/if}
      {#if active.length === 0}
        <p class="px-3 py-4 text-sm text-muted-foreground">
          {filtered && view.active.length ? 'No running query matches the filter.' : `No query is running${missing.length ? ' on the nodes that answered' : ''}.`}
        </p>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="border-b text-left text-xs text-muted-foreground">
              <tr>
                {#if clustered}<th class="px-3 py-2 font-medium">Node</th>{/if}
                <th class="px-3 py-2 font-medium">Query</th>
                <th class="px-3 py-2 font-medium">Token</th>
                <th class="px-3 py-2 font-medium">Started</th>
                <th class="px-3 py-2 font-medium">Running for</th>
                <th class="px-3 py-2 font-medium">SQL</th>
                <th class="px-3 py-2"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody class="divide-y">
              {#each active as q (`${q.nodeId}/${q.id}`)}
                <tr class={sameQuery(selected, q) ? 'bg-muted' : ''}>
                  {#if clustered}<td class="px-3 py-2 font-mono text-xs">{q.nodeId}{#if q.forwardedTo}<span class="text-muted-foreground"> → {q.forwardedTo}</span>{/if}</td>{/if}
                  <td class="px-3 py-2">
                    <button type="button" class="font-mono text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={sameQuery(selected, q)} on:click={() => open(q)}>{q.id}</button>
                  </td>
                  <td class="px-3 py-2 text-xs">
                    <span class="font-mono">{tokenLabel(q)}</span>
                    {#if isLaunchpad(q)}<Badge variant="outline" class="ml-1">Launchpad</Badge>{/if}
                  </td>
                  <td class="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{formatDateTime(q.startTime, $timezone)}</td>
                  <td class="whitespace-nowrap px-3 py-2 text-xs font-medium">{formatDurationMs(runningFor(q))}</td>
                  <td class="max-w-md truncate px-3 py-2 font-mono text-xs" title={q.sql}>{oneLine(q.sql)}</td>
                  <td class="px-3 py-2 text-right">
                    <Button variant="outline" size="sm" on:click={() => askCancel(q)}>Cancel…</Button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    {#if selected}
      <section class="mb-4 rounded-lg border bg-card p-4 text-sm" aria-labelledby="query-detail">
        <div class="mb-3 flex items-start justify-between gap-2">
          <h3 id="query-detail" class="font-semibold">
            Query <span class="font-mono">{selected.id}</span>{#if clustered}<span class="font-normal text-muted-foreground"> on <span class="font-mono">{selected.nodeId}</span></span>{/if}
          </h3>
          <button type="button" class="text-muted-foreground hover:text-foreground" aria-label="Close the query detail" on:click={close}><X class="h-4 w-4" /></button>
        </div>
        {#if detailError}
          <p class="text-destructive">{detailError}</p>
        {:else if !detail}
          <p class="text-muted-foreground">Loading…</p>
        {:else}
          {@const d = detail.query}
          <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
            <dt class="text-muted-foreground">Status</dt>
            <dd class="font-medium {STATUS_TONE[d.status]}">{STATUS_LABEL[d.status]}</dd>
            <dt class="text-muted-foreground">Node</dt>
            <dd><span class="font-mono">{nodeLabel(d.nodeId)}</span> <span class="text-muted-foreground">({detail.source})</span></dd>
            {#if d.forwardedTo}
              <dt class="text-muted-foreground">Forwarded to</dt>
              <dd><span class="font-mono">{d.forwardedTo}</span> <span class="text-muted-foreground">(cancelling ends the forward, which stops the query there)</span></dd>
            {/if}
            <dt class="text-muted-foreground">Token</dt>
            <dd><span class="font-mono">{tokenLabel(d)}</span>{d.tokenId !== null ? ` (id ${d.tokenId})` : ''}{isLaunchpad(d) ? ' · Launchpad’s stored token' : ''}</dd>
            <dt class="text-muted-foreground">Client</dt>
            <dd class="font-mono">{d.remoteAddr ?? '—'}</dd>
            <dt class="text-muted-foreground">Started</dt>
            <dd>{formatDateTime(d.startTime, $timezone)}</dd>
            {#if d.endTime}
              <dt class="text-muted-foreground">Ended</dt>
              <dd>{formatDateTime(d.endTime, $timezone)}</dd>
            {/if}
            <dt class="text-muted-foreground">{d.status === 'running' ? 'Running for' : 'Took'}</dt>
            <dd>{formatDurationMs(d.status === 'running' && listed?.status === 'running' ? runningFor(listed) : d.durationMs)}</dd>
            {#if d.rowCount !== null}
              <dt class="text-muted-foreground">Rows</dt>
              <dd>{formatCount(d.rowCount)}</dd>
            {/if}
            {#if d.rowCap !== null}
              <dt class="text-muted-foreground">Row cap</dt>
              <dd>Reached the query governance cap of {formatCount(d.rowCap)} rows: the result may be incomplete.</dd>
            {/if}
            {#if d.error}
              <dt class="text-muted-foreground">{d.status === 'cancelled' ? 'Reason' : 'Error'}</dt>
              <dd class="whitespace-pre-wrap break-words font-mono">{d.error}</dd>
            {/if}
          </dl>
          <pre class="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">{d.sql}</pre>
          {#if d.sqlTruncated}<p class="mt-1 text-xs text-muted-foreground">The SQL is cut short here.</p>{/if}
          {#if d.status === 'running'}
            <Button class="mt-3" variant="outline" size="sm" on:click={() => askCancel(listed ?? d)}>Cancel this query…</Button>
          {/if}
        {/if}
      </section>
    {/if}

    <section class="rounded-lg border bg-card" aria-labelledby="queries-history">
      <h3 id="queries-history" class="border-b px-3 py-2 text-sm font-semibold">
        Recently finished <span class="font-normal text-muted-foreground">{formatCount(history.length)}{filtered ? ` of ${formatCount(view.history.length)}` : ''}</span>
      </h3>
      {#if view.historyTruncated}
        <p class="border-b px-3 py-2 text-xs text-muted-foreground">Showing the newest {formatCount(view.history.length)} across the nodes.</p>
      {/if}
      {#if history.length === 0}
        <p class="px-3 py-4 text-sm text-muted-foreground">
          {filtered && view.history.length ? 'No finished query matches the filter.' : 'No finished query is recorded yet.'}
        </p>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="border-b text-left text-xs text-muted-foreground">
              <tr>
                {#if clustered}<th class="px-3 py-2 font-medium">Node</th>{/if}
                <th class="px-3 py-2 font-medium">Query</th>
                <th class="px-3 py-2 font-medium">Status</th>
                <th class="px-3 py-2 font-medium">Token</th>
                <th class="px-3 py-2 font-medium">Ended</th>
                <th class="px-3 py-2 font-medium">Took</th>
                <th class="px-3 py-2 font-medium text-right">Rows</th>
                <th class="px-3 py-2 font-medium">SQL</th>
              </tr>
            </thead>
            <tbody class="divide-y">
              {#each history as q (`${q.nodeId}/${q.id}`)}
                <tr class={sameQuery(selected, q) ? 'bg-muted' : ''}>
                  {#if clustered}<td class="px-3 py-2 font-mono text-xs">{q.nodeId}</td>{/if}
                  <td class="px-3 py-2">
                    <button type="button" class="font-mono text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={sameQuery(selected, q)} on:click={() => open(q)}>{q.id}</button>
                  </td>
                  <td class="whitespace-nowrap px-3 py-2 text-xs font-medium {STATUS_TONE[q.status]}" title={q.error ?? ''}>{STATUS_LABEL[q.status]}{q.rowCap !== null ? ' · capped' : ''}</td>
                  <td class="px-3 py-2 text-xs">
                    <span class="font-mono">{tokenLabel(q)}</span>
                    {#if isLaunchpad(q)}<Badge variant="outline" class="ml-1">Launchpad</Badge>{/if}
                  </td>
                  <td class="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{q.endTime ? formatDateTime(q.endTime, $timezone) : '—'}</td>
                  <td class="whitespace-nowrap px-3 py-2 text-xs">{formatDurationMs(q.durationMs)}</td>
                  <td class="px-3 py-2 text-right text-xs">{formatCount(q.rowCount)}</td>
                  <td class="max-w-md truncate px-3 py-2 font-mono text-xs" title={q.sql}>{oneLine(q.sql)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}
</div>

<Dialog.Root open={confirming !== null} onOpenChange={onDialogOpenChange}>
  <Dialog.Content class="max-w-xl">
    {#if confirming}
      {@const q = confirming}
      <Dialog.Header>
        <Dialog.Title>Cancel this query?</Dialog.Title>
        <Dialog.Description>
          Arc stops it{clustered ? ` on ${q.nodeId}` : ''} and the client that sent it gets an error. It cannot be resumed.
        </Dialog.Description>
      </Dialog.Header>
      <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt class="text-muted-foreground">Query</dt>
        <dd class="font-mono">{q.id}</dd>
        <dt class="text-muted-foreground">Node</dt>
        <dd><span class="font-mono">{nodeLabel(q.nodeId)}</span> <span class="text-muted-foreground">{sources.get(q.nodeId) ? `(${sources.get(q.nodeId)})` : ''}</span></dd>
        <dt class="text-muted-foreground">Token</dt>
        <dd class="font-mono">{tokenLabel(q)}</dd>
        <dt class="text-muted-foreground">Client</dt>
        <dd class="font-mono">{q.remoteAddr ?? '—'}</dd>
        <dt class="text-muted-foreground">Started</dt>
        <dd>{formatDateTime(q.startTime, $timezone)} · running for {formatDurationMs(runningFor(q))}</dd>
      </dl>
      <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">{q.sql}</pre>
      {#if q.forwardedTo}
        <p class="text-sm text-muted-foreground">
          {q.nodeId} forwarded this query to <span class="font-mono">{q.forwardedTo}</span>. Cancelling ends the forward, which
          stops the query there.
        </p>
      {/if}
      {#if isLaunchpad(q)}
        <p class="text-sm text-muted-foreground">
          Launchpad sent this query with its stored token: a member's SQL console or Log Viewer query, or an alert check.
        </p>
      {/if}
      {#if cancelError}<p class="text-sm text-destructive" role="alert">{cancelError}</p>{/if}
      <Dialog.Footer>
        <Button variant="outline" disabled={cancelling} on:click={() => (confirming = null)}>Keep running</Button>
        <Button variant="destructive" disabled={cancelling} on:click={confirmCancel}>{cancelling ? 'Cancelling…' : 'Cancel query'}</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
