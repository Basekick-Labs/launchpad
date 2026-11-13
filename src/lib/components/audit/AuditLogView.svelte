<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { ClusterApiError, getAuditEvents, getAuditStats } from '$lib/cloudApi';
  import {
    AUDIT_RANGES,
    eventTone,
    inputToIso,
    KNOWN_EVENT_TYPES,
    rangeBounds,
    type AuditEvent,
    type AuditFilter,
    type AuditNodeStatus,
    type AuditPage,
    type AuditRangeId,
    type AuditStats,
    type EventTone,
  } from '$lib/auditLog';
  import type { CapabilityView } from '$lib/capabilities';
  import { describeClusterError } from '$lib/cluster';
  import { formatAge, formatCount } from '$lib/format';
  import { formatDateTime, timezone } from '$lib/stores/timezone';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { ChevronDown, ChevronRight, RefreshCw, ShieldCheck } from 'lucide-svelte';

  export let orgId: string;
  export let instanceId: string;
  /** The audit_log capability: 'disabled' explains how to turn it on instead of loading. */
  export let capability: CapabilityView | null = null;

  const dispatch = createEventDispatcher<{ recheck: void }>();

  // The form, and the filter last applied (what the list shows).
  let range: AuditRangeId | 'custom' = '24h';
  let customSince = '';
  let customUntil = '';
  let eventType = '';
  let actor = '';
  let database = '';
  let node = '';
  /** The filter of the list shown, which "Load older events" continues. */
  let applied: AuditFilter | null = null;
  let formError: string | null = null;

  let page: AuditPage | null = null;
  let events: AuditEvent[] = [];
  let next: string | null = null;
  /** Nodes left out of what is shown, by id: from the first page and any older one. */
  let missing = new Map<string, AuditNodeStatus>();
  /** Where each node's events came from (host:port), for the detail rows. */
  let sources = new Map<string, string>();
  let error: string | null = null;
  let loading = false;
  let loadingMore = false;
  let moreError: string | null = null;
  let stats: AuditStats | null = null;
  /** The node the counts are for; null for every node. */
  let statsNode: string | null = null;
  let statsError: string | null = null;
  let expanded: string | null = null;
  let now = Date.now();

  let listAbort: AbortController | null = null;
  let statsAbort: AbortController | null = null;

  $: disabled = capability?.state === 'disabled';
  $: allNodes = page?.allNodes ?? [];
  $: clustered = allNodes.length > 1 || (allNodes.length === 1 && allNodes[0] !== 'standalone');
  $: typeSuggestions = [...new Set([...(stats?.byType.map((s) => s.eventType) ?? []), ...KNOWN_EVENT_TYPES])].sort();

  const failure = (err: unknown) => (err instanceof ClusterApiError ? describeClusterError(err.code) : 'Something went wrong');
  const aborted = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';
  const key = (e: AuditEvent) => `${e.nodeId}:${e.id}`;

  function sourcesOf(nodes: AuditNodeStatus[], known: Map<string, string>): Map<string, string> {
    for (const n of nodes) if (n.source) known.set(n.nodeId, n.source);
    return known;
  }

  /** The form as a filter; a message when the custom window is not usable. */
  function filterFromForm(): AuditFilter | string {
    let bounds: { since: string | null; until: string | null };
    if (range === 'custom') {
      bounds = { since: customSince ? inputToIso(customSince, $timezone) : null, until: customUntil ? inputToIso(customUntil, $timezone) : null };
      if ((customSince && !bounds.since) || (customUntil && !bounds.until)) return 'Enter a valid start and end time';
      if (bounds.since && bounds.until && bounds.since > bounds.until) return 'The start is after the end';
    } else {
      bounds = rangeBounds(range, Date.now());
    }
    return {
      eventType: eventType.trim() || null,
      actor: actor.trim() || null,
      database: database.trim() || null,
      node: node || null,
      ...bounds,
    };
  }

  async function load() {
    const f = filterFromForm();
    if (typeof f === 'string') {
      formError = f;
      return;
    }
    formError = null;
    listAbort?.abort();
    const ctl = (listAbort = new AbortController());
    loading = true;
    // A reload replaces the list, so an older page still loading is dropped.
    loadingMore = false;
    moreError = null;
    loadStats(f);
    try {
      const p = await getAuditEvents(orgId, instanceId, f, null, ctl.signal);
      if (listAbort !== ctl) return;
      // Only now: a failed reload keeps the list, and its cursor, of the previous filter.
      applied = f;
      page = p;
      events = p.events;
      next = p.next;
      missing = new Map(p.nodes.filter((n) => n.state !== 'on').map((n) => [n.nodeId, n]));
      sources = sourcesOf(p.nodes, new Map());
      expanded = null;
      error = null;
    } catch (err) {
      if (listAbort === ctl && !aborted(err)) error = failure(err);
    } finally {
      if (listAbort === ctl) {
        loading = false;
        now = Date.now();
      }
    }
  }

  async function loadMore() {
    if (!applied || !next || loadingMore) return;
    const ctl = (listAbort = new AbortController());
    loadingMore = true;
    try {
      const p = await getAuditEvents(orgId, instanceId, applied, next, ctl.signal);
      if (listAbort !== ctl) return;
      // An event written while paging can shift a node's offsets by one: never list it twice.
      const seen = new Set(events.map(key));
      events = [...events, ...p.events.filter((e) => !seen.has(key(e)))];
      next = p.next;
      for (const n of p.nodes) if (n.state !== 'on' && !missing.has(n.nodeId)) missing.set(n.nodeId, n);
      missing = missing;
      sources = sourcesOf(p.nodes, sources);
      moreError = null;
    } catch (err) {
      if (listAbort === ctl && !aborted(err)) moreError = failure(err);
    } finally {
      if (listAbort === ctl) loadingMore = false;
    }
  }

  async function loadStats(f: AuditFilter) {
    statsAbort?.abort();
    const ctl = (statsAbort = new AbortController());
    try {
      const s = await getAuditStats(orgId, instanceId, { since: f.since, node: f.node }, ctl.signal);
      if (statsAbort === ctl) {
        stats = s;
        statsNode = f.node;
        statsError = null;
      }
    } catch (err) {
      if (statsAbort === ctl && !aborted(err)) {
        stats = null;
        statsError = failure(err);
      }
    }
  }

  function clearFilters() {
    eventType = '';
    actor = '';
    database = '';
    node = '';
    range = '24h';
    load();
  }

  function filterByType(type: string) {
    eventType = type;
    load();
  }

  // Also once "Check again" finds audit logging turned on.
  let started = false;
  $: if (!disabled && !started) {
    started = true;
    load();
  }
  onDestroy(() => {
    listAbort?.abort();
    statsAbort?.abort();
  });

  const TONE: Record<EventTone, string> = {
    failure: 'text-red-600 dark:text-red-400',
    error: 'text-yellow-700 dark:text-yellow-400',
    change: 'text-blue-600 dark:text-blue-400',
    read: 'text-muted-foreground',
  };
  const STATE: Record<string, { label: string; variant: 'secondary' | 'destructive' }> = {
    off: { label: 'audit off', variant: 'secondary' },
    refused: { label: 'refused', variant: 'destructive' },
    unreachable: { label: 'not reachable', variant: 'destructive' },
  };
  const inputClass = 'h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const code = 'rounded bg-muted px-1 py-0.5 font-mono text-xs';
  const nodeLabel = (id: string) => (id === 'standalone' ? 'this instance' : id);
</script>

<div class="flex h-full flex-col overflow-auto p-4">
  <div class="mb-4 flex items-start justify-between gap-4">
    <div>
      <h2 class="flex items-center gap-2 text-lg font-semibold"><ShieldCheck class="h-5 w-5" /> Audit log</h2>
      <p class="mt-1 max-w-3xl text-xs text-muted-foreground">
        Arc Enterprise's record of the API requests made to this instance: who (the Arc token) did what, to which database,
        and how Arc answered. It is not the data you ingest (<strong>Log Viewer</strong>) nor Arc's own application logs
        (<strong>Monitoring</strong>{clustered ? ', or per node in Cluster' : ''}). Changes made through Launchpad show Launchpad's
        token as the actor; the instance page's Change history says which member made them.
      </p>
    </div>
    {#if !disabled}
      <div class="flex shrink-0 items-center gap-2">
        {#if page}<span class="text-xs text-muted-foreground">loaded {formatAge(now - page.loadedAt)}</span>{/if}
        <Button variant="ghost" size="sm" on:click={load} disabled={loading} aria-label="Reload audit events">
          <RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
        </Button>
      </div>
    {/if}
  </div>

  {#if disabled}
    <div class="rounded-lg border bg-card p-6 text-sm">
      <p class="font-medium">Audit logging is not enabled on this instance</p>
      <p class="mt-2 text-muted-foreground">
        The license includes it, but Arc only records audit events when it is turned on. Set
        <code class={code}>enabled = true</code> in the <code class={code}>[audit_log]</code> section of the instance's
        <code class={code}>arc.toml</code>:
      </p>
      <pre class="mt-3 rounded-md bg-muted p-4 text-xs font-mono">[audit_log]
enabled = true
retention_days = 90
include_reads = false</pre>
      <p class="mt-3 text-xs text-muted-foreground">
        The arc.toml Arc ships already has an <code class={code}>[audit_log]</code> section: change its lines rather than adding
        a second one, which stops Arc from starting. Or set <code class={code}>ARC_AUDIT_LOG_ENABLED=true</code> in Arc's
        environment, which overrides arc.toml. <code class={code}>include_reads = true</code> also records GET requests, which
        is high volume. Then restart the Arc server{clustered ? ', on every node' : ''}.
      </p>
      <Button class="mt-4" variant="outline" size="sm" on:click={() => dispatch('recheck')}>
        <RefreshCw class="mr-2 h-4 w-4" /> Check again
      </Button>
    </div>
  {:else}
    <form class="mb-3 flex flex-wrap items-end gap-2" on:submit|preventDefault={load} aria-label="Filter audit events">
      <label class="flex flex-col gap-1 text-xs text-muted-foreground">
        Time
        <select bind:value={range} class={inputClass}>
          {#each AUDIT_RANGES as r}<option value={r.id}>{r.label}</option>{/each}
          <option value="custom">Custom…</option>
        </select>
      </label>
      {#if range === 'custom'}
        <label class="flex flex-col gap-1 text-xs text-muted-foreground">
          From ({$timezone === 'utc' ? 'UTC' : 'local'})
          <input type="datetime-local" bind:value={customSince} class={inputClass} />
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted-foreground">
          To
          <input type="datetime-local" bind:value={customUntil} class={inputClass} />
        </label>
      {/if}
      <label class="flex flex-col gap-1 text-xs text-muted-foreground">
        Event type
        <input bind:value={eventType} list="audit-event-types" placeholder="Any" maxlength="128" class="{inputClass} w-44" />
        <datalist id="audit-event-types">
          {#each typeSuggestions as t}<option value={t} />{/each}
        </datalist>
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted-foreground">
        Actor (token name)
        <input bind:value={actor} placeholder="Any" maxlength="128" class="{inputClass} w-36" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted-foreground">
        Database
        <input bind:value={database} placeholder="Any" maxlength="128" class="{inputClass} w-32" />
      </label>
      {#if clustered}
        <label class="flex flex-col gap-1 text-xs text-muted-foreground">
          Node
          <select bind:value={node} class={inputClass}>
            <option value="">All nodes</option>
            {#each allNodes as id}<option value={id}>{id}</option>{/each}
          </select>
        </label>
      {/if}
      <Button type="submit" size="sm" disabled={loading}>Apply</Button>
      <Button type="button" variant="ghost" size="sm" on:click={clearFilters} disabled={loading}>Clear</Button>
      <p class="w-full text-xs text-muted-foreground">Actor, database and event type match exactly.</p>
      {#if formError}<p class="w-full text-xs text-destructive" role="alert">{formError}</p>{/if}
    </form>

    {#if stats || statsError}
      <section class="mb-3 rounded-lg border bg-card p-3 text-sm" aria-labelledby="audit-summary">
        <h3 id="audit-summary" class="text-xs font-semibold uppercase text-muted-foreground">
          Events since {stats ? formatDateTime(stats.since, $timezone) : '…'}{statsNode ? ` on ${statsNode}` : clustered ? ', all nodes' : ''}
        </h3>
        {#if statsError}
          <p class="mt-1 text-xs text-muted-foreground">Could not count events: {statsError}.</p>
        {:else if stats}
          {#if stats.byType.length === 0}
            <p class="mt-1 text-xs text-muted-foreground">No events recorded since then{stats.nodes.some((n) => n.state !== 'on') ? ' on the nodes that answered' : ''}.</p>
          {:else}
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <span class="mr-1 font-semibold">{formatCount(stats.total)}</span>
              {#each stats.byType.slice(0, 12) as s (s.eventType)}
                <button
                  type="button"
                  class="rounded-md border px-2 py-0.5 font-mono text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {applied?.eventType === s.eventType ? 'border-primary' : ''}"
                  title="Show only {s.eventType}"
                  on:click={() => filterByType(s.eventType)}
                >{s.eventType} <span class="text-muted-foreground">{formatCount(s.count)}</span></button>
              {/each}
              {#if stats.byType.length > 12}<span class="text-xs text-muted-foreground">and {stats.byType.length - 12} more types</span>{/if}
            </div>
            <p class="mt-1 text-xs text-muted-foreground">Counted from that time to now; the other filters do not apply to these totals.</p>
          {/if}
        {/if}
      </section>
    {/if}

    {#if missing.size}
      <div class="mb-3 rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-100" role="status">
        {#if clustered}
          <p>Events from {missing.size === 1 ? 'this node are' : 'these nodes are'} not included. Arc keeps audit events on each node separately.</p>
        {:else}
          <p>Arc did not return its audit log.</p>
        {/if}
        <ul class="mt-1 space-y-0.5 text-xs">
          {#each [...missing.values()] as n (n.nodeId)}
            <li class="flex flex-wrap items-center gap-1.5">
              <span class="font-mono">{nodeLabel(n.nodeId)}</span>
              {#if STATE[n.state]}<Badge variant={STATE[n.state].variant}>{STATE[n.state].label}</Badge>{/if}
              {#if n.issue}<span>{n.issue.message}</span>{/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if !page && error}
      <div class="flex flex-col items-center gap-3 py-10 text-center">
        <p class="text-sm text-destructive">Could not load the audit log: {error}.</p>
        <Button size="sm" variant="outline" on:click={load}>Try again</Button>
      </div>
    {:else if !page}
      <p class="py-10 text-center text-sm text-muted-foreground">Loading audit events…</p>
    {:else}
      {#if error}
        <p class="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">
          Could not reload: {error}. Showing what was loaded {formatAge(now - page.loadedAt)}.
        </p>
      {/if}
      {#if events.length === 0 && !clustered && missing.size}
        <!-- The only node did not answer: the notice above says why. -->
      {:else if events.length === 0}
        <div class="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          <p>No audit events match these filters{missing.size ? ' on the nodes that answered' : ''}.</p>
          <p class="mt-1 text-xs">
            Arc records every request except GET requests, which it records only with
            <code class={code}>include_reads = true</code> in <code class={code}>[audit_log]</code>.
          </p>
        </div>
      {:else}
        <div class="overflow-x-auto rounded-lg border bg-card">
          <table class="w-full text-sm">
            <thead class="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" class="w-6 px-2 py-2"><span class="sr-only">Details</span></th>
                <th scope="col" class="px-2 py-2 font-medium">Time</th>
                {#if clustered}<th scope="col" class="px-2 py-2 font-medium">Node</th>{/if}
                <th scope="col" class="px-2 py-2 font-medium">Event</th>
                <th scope="col" class="px-2 py-2 font-medium">Actor</th>
                <th scope="col" class="px-2 py-2 font-medium">Request</th>
                <th scope="col" class="px-2 py-2 font-medium">Database</th>
                <th scope="col" class="px-2 py-2 font-medium">Status</th>
                <th scope="col" class="px-2 py-2 text-right font-medium">Duration</th>
              </tr>
            </thead>
            <tbody class="divide-y">
              {#each events as e (key(e))}
                {@const open = expanded === key(e)}
                <tr class={open ? 'bg-accent/50' : ''}>
                  <td class="px-2 py-1.5">
                    <button
                      type="button"
                      class="rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-expanded={open}
                      aria-label="{open ? 'Hide' : 'Show'} details"
                      on:click={() => (expanded = open ? null : key(e))}
                    >
                      {#if open}<ChevronDown class="h-4 w-4" />{:else}<ChevronRight class="h-4 w-4" />{/if}
                    </button>
                  </td>
                  <td class="whitespace-nowrap px-2 py-1.5 text-xs text-muted-foreground">{formatDateTime(e.timestamp, $timezone)}</td>
                  {#if clustered}<td class="px-2 py-1.5 font-mono text-xs">{e.nodeId}</td>{/if}
                  <td class="px-2 py-1.5 font-mono text-xs {TONE[eventTone(e)]}">{e.eventType}</td>
                  <td class="px-2 py-1.5 font-mono text-xs">{e.actor}</td>
                  <td class="max-w-md truncate px-2 py-1.5 font-mono text-xs" title="{e.method} {e.path}">{e.method} {e.path}</td>
                  <td class="px-2 py-1.5 font-mono text-xs">{e.database ?? ''}</td>
                  <td class="px-2 py-1.5 text-xs {e.statusCode !== null && e.statusCode >= 400 ? 'font-medium text-destructive' : ''}">{e.statusCode ?? '—'}</td>
                  <td class="whitespace-nowrap px-2 py-1.5 text-right text-xs text-muted-foreground">{e.durationMs !== null ? `${formatCount(e.durationMs)} ms` : '—'}</td>
                </tr>
                {#if open}
                  <tr class="bg-accent/30">
                    <td></td>
                    <td colspan={clustered ? 8 : 7} class="px-2 pb-3 pt-1">
                      <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-xs">
                        <dt class="text-muted-foreground">Time (Arc)</dt><dd class="font-mono">{e.timestamp}</dd>
                        <dt class="text-muted-foreground">Recorded by</dt>
                        <dd class="font-mono">{nodeLabel(e.nodeId)}{sources.has(e.nodeId) ? ` · ${sources.get(e.nodeId)}` : ''} · entry {e.id}</dd>
                        <dt class="text-muted-foreground">Request</dt><dd class="break-all font-mono">{e.method} {e.path}</dd>
                        {#if e.measurement}<dt class="text-muted-foreground">Measurement</dt><dd class="font-mono">{e.measurement}</dd>{/if}
                        <dt class="text-muted-foreground">Client address</dt><dd class="font-mono">{e.ipAddress ?? '—'}</dd>
                        <dt class="text-muted-foreground">User agent</dt><dd class="break-all font-mono">{e.userAgent ?? '—'}</dd>
                        {#each e.detail ?? [] as [k, v]}
                          <dt class="text-muted-foreground">{k}</dt><dd class="break-all font-mono">{v}</dd>
                        {/each}
                      </dl>
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      <div class="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{formatCount(events.length)} event{events.length === 1 ? '' : 's'} shown, newest first</span>
        {#if next}
          <Button variant="outline" size="sm" on:click={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load older events'}
          </Button>
        {:else if events.length}
          <span>No older events{applied?.since ? ' in this window' : ''}.</span>
        {/if}
      </div>
      {#if moreError}<p class="mt-2 text-xs text-destructive" role="alert">Could not load older events: {moreError}.</p>{/if}
    {/if}
  {/if}
</div>
