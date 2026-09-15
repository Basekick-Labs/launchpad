<!--
  The dashboard view page. This is the host: three merged modules left contracts
  they cannot enforce themselves and this file owns all of them.

  ## URL writes go through `goto`, not shallow routing

  `pushState`/`replaceState` from `$app/navigation` do NOT update `$page.url` —
  they set `page.state` and the address bar, and store the PRE-push URL under an
  internal key, so after a Back `$page.url` is the original load URL while the
  bar shows the popped entry. Reading the range back from `$page.url` would then
  apply the wrong one.

  `goto` is correct here and costs nothing, because SvelteKit tracks `url` and
  individual search params PER LOAD NODE and re-runs only what actually used
  them. `+page.server.ts` reads neither, so a range change issues zero requests.
  That is a contract: if the server load ever reads `event.url`, every zoom
  becomes a database round trip.

  ## One writer for five parameters

  `from`, `to`, `refresh`, `kiosk`, `viewPanel` share one string, so each write
  merges into the LIVE search params rather than a captured copy — two writes in
  a tick would otherwise clobber each other.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { browser } from '$app/environment';
  import { Button } from '$lib/components/ui/button';
  import { Plus, Save, RefreshCw, Loader2, Maximize2 } from 'lucide-svelte';
  import DashboardGrid from '$lib/components/dashboard/DashboardGrid.svelte';
  import PanelChrome from '$lib/components/dashboard/PanelChrome.svelte';
  import {
    applyResult,
    baselineOf,
    resolveEditPanel,
    buildRunContext,
    canSave,
    isDirty,
    resolveViewPanel,
  } from '$lib/dashboard/dashboardState';
  import {
    getEditPanel,
    getViewPanel,
    initialRange,
    initialRefresh,
    isKiosk,
    mergeDashboardParams,
    withSearch,
  } from '$lib/dashboard/dashboardUrl';
  import { createRefreshScheduler } from '$lib/dashboard/refreshScheduler';
  import { createTimeRangeStore, isAbsolute, resolveRange } from '$lib/dashboard/timeRange';
  import { createProxyTransport, createQueryRunner, type PanelResult } from '$lib/dashboard/queryRunner';
  import { resolveTimezone } from '$lib/dashboard/macros';
  import { findSlot, toItems } from '$lib/dashboard/gridEngine';
  import { duplicatePanel } from '$lib/dashboard/panelState';
  import { applyEdit, beginEdit } from '$lib/dashboard/panelEditor';
  import { loadPanel } from '$lib/dashboard/panelRegistry';
  import { createPanel, type Dashboard, type Panel } from '$lib/dashboard/model';
  import type { PageData } from './$types';

  export let data: PageData;

  // --- model vs view state -------------------------------------------------

  /** The MODEL. Reassigned (never mutated) so dirty-tracking re-runs. */
  let dashboard: Dashboard = data.record.model;
  let version = data.record.version;
  let baseline = baselineOf(dashboard);

  $: dirty = isDirty(dashboard, baseline);
  $: editable = canSave(data.role, data.record.createdBy, data.user.id);

  // --- range, refresh, kiosk, fullscreen: view state, never the model ------

  const range = createTimeRangeStore(
    initialRange(new URLSearchParams(browser ? location.search : ''), dashboard.time),
    { writeUrl: (params) => writeUrl({ from: params.from, to: params.to }) },
  );

  let refreshInterval = initialRefresh(
    new URLSearchParams(browser ? location.search : ''),
    dashboard.time.refresh,
  );

  $: kiosk = isKiosk($page.url.searchParams);
  $: editing = resolveEditPanel(dashboard.panels, getEditPanel($page.url.searchParams), editable);

  /** The in-progress copy. Page-owned, so an editor remount does not lose it. */
  let draft: Panel | null = null;
  let editorComponent: unknown = null;

  // Open and close follow the URL, so a link and browser Back both work.
  $: if (editing && (!draft || draft.id !== editing.id)) {
    draft = beginEdit(editing);
    void loadEditor();
  }
  $: if (!editing && draft) draft = null;

  async function loadEditor(): Promise<void> {
    if (editorComponent) return;
    // Lazy: this pulls CodeMirror, which is over a megabyte in the console
    // route's chunk. A static import would land it on the dashboard route.
    editorComponent = (await import('$lib/components/dashboard/PanelEditor.svelte')).default;
  }

  function openEditor(panel: Panel): void {
    writeUrl({ editPanel: panel.id, viewPanel: null });
  }

  function applyDraft(next: Panel): void {
    dashboard = { ...dashboard, panels: applyEdit(dashboard.panels, next) };
    draft = null;
    writeUrl({ editPanel: null });
    // The edit may have changed the query, so re-run just this panel.
    const updated = dashboard.panels.find((p) => p.id === next.id);
    if (updated) void runPanel(updated, true);
  }

  /** Typed handlers: a dynamic `svelte:component` loses event typing. */
  function onDraftApply(e: CustomEvent<Panel>): void {
    applyDraft(e.detail);
  }
  function onDraftChange(e: CustomEvent<Panel>): void {
    draft = e.detail;
  }

  function discardDraft(): void {
    // Nothing to restore: the original was never touched.
    draft = null;
    writeUrl({ editPanel: null });
  }
  $: viewPanel = resolveViewPanel(dashboard.panels, getViewPanel($page.url.searchParams));

  /** Resolved once per tick and RETAINED — see the runner's from/to contract. */
  let ctx = buildRunContext({ orgId: data.record.orgId, from: 0, to: 0, timezone: 'UTC' });
  let results: Record<string, PanelResult> = {};
  let inFlight: Record<string, boolean> = {};
  /**
   * Per-panel VIEW state, owned here because PanelChrome unmounts its slot on
   * every state change — component-local state would not survive, and series
   * colours would shuffle whenever one was filtered out. Never dirties the
   * dashboard.
   */
  let panelSlots: Record<string, Record<string, number>> = {};

  /** Curried so the handler carries a type: `svelte:component` with a dynamic
      `this` loses event typing, and an inline annotation is a parse error. */
  function rememberSlots(panelId: string) {
    return (e: CustomEvent<Record<string, number>>) => {
      panelSlots = { ...panelSlots, [panelId]: e.detail };
    };
  }

  /** Lazily loaded, so uPlot stays out of this route's chunk. */
  const renderers: Record<string, unknown> = {};
  async function ensureRenderer(type: string): Promise<void> {
    if (type in renderers) return;
    renderers[type] = await loadPanel(type as never);
    // Reassign so the template re-renders once the chunk has arrived.
    renderers[type] = renderers[type];
  }

  const runner = createQueryRunner({ transport: createProxyTransport() });

  const scheduler = createRefreshScheduler({
    onTick: () => runAll(),
    isHidden: () => (browser ? document.hidden : true),
  });

  // --- url -----------------------------------------------------------------

  /** Re-reads the live params every time; never closes over a snapshot. */
  function writeUrl(changes: Parameters<typeof mergeDashboardParams>[1]): void {
    if (!browser) return;
    const next = withSearch(
      location.pathname,
      mergeDashboardParams(new URLSearchParams(location.search), changes),
    );
    void goto(next, { replaceState: false, noScroll: true, keepFocus: true });
  }

  // Back/forward: the URL is the source of truth, so feed it back in. The
  // store's own guard stops this looping.
  $: if (browser) range.applyFromUrl({
    from: $page.url.searchParams.get('from'),
    to: $page.url.searchParams.get('to'),
  });

  // --- running -------------------------------------------------------------

  function resolveNow() {
    const resolved = resolveRange($range, {
      timezone: resolveTimezone(dashboard.time.timezone),
      weekStart: dashboard.time.weekStart,
      nowDelay: dashboard.time.nowDelay,
    });
    ctx = buildRunContext({
      orgId: data.record.orgId,
      from: resolved.from,
      to: resolved.to,
      // Resolved CLIENT-side: 'browser' on the server is the server's zone.
      timezone: resolveTimezone(dashboard.time.timezone),
      minInterval: dashboard.minInterval,
    });
    return ctx;
  }

  async function runPanel(panel: Panel, noCache = false): Promise<void> {
    // The runner does not abort a previous run of the same panel — it overwrites
    // the controller, leaving the old request running and unreachable. Cancel
    // first, or every range change leaks a request per panel.
    runner.cancelPanel(panel.id);
    inFlight = { ...inFlight, [panel.id]: true };
    try {
      const result = await runner.runPanel(dashboard, panel, ctx, { noCache });
      results = applyResult(results, result, runner.isCurrent);
    } finally {
      inFlight = { ...inFlight, [panel.id]: false };
    }
  }

  /** One resolution, every panel — which is what makes dedupe and the cache work. */
  function runAll(noCache = false): void {
    resolveNow();
    for (const panel of dashboard.panels) void runPanel(panel, noCache);
  }

  // A range change re-runs everything against one fresh resolution.
  let lastRangeKey = '';
  $: if (browser && `${$range.from}|${$range.to}` !== lastRangeKey) {
    lastRangeKey = `${$range.from}|${$range.to}`;
    runAll();
  }

  // An absolute range cannot produce new rows, so refreshing it is pure load.
  $: if (browser) {
    if (isAbsolute($range)) scheduler.pause();
    else scheduler.set(refreshInterval);
  }

  function setRefresh(value: string): void {
    refreshInterval = value;
    writeUrl({ refresh: value });
    if (!isAbsolute($range)) scheduler.set(value);
  }

  // --- editing -------------------------------------------------------------

  function addPanel(): void {
    const slot = findSlot(toItems(dashboard.panels), 12, 8);
    if (!slot) {
      saveMessage = 'No room for another panel.';
      return;
    }
    dashboard = {
      ...dashboard,
      panels: [...dashboard.panels, createPanel({ type: 'timeseries', gridPos: slot })],
    };
  }

  function onGridChange(panels: Panel[]): void {
    // Reassign the whole dashboard: mutating `.panels` in place would not
    // re-run the dirty check, so a drag would silently not dirty.
    dashboard = { ...dashboard, panels };
  }

  function onRemove(panel: Panel): void {
    dashboard = { ...dashboard, panels: dashboard.panels.filter((p) => p.id !== panel.id) };
    runner.cancelPanel(panel.id);
  }

  function onDuplicate(panel: Panel): void {
    const copy = duplicatePanel(dashboard.panels, panel.id);
    if (!copy) {
      saveMessage = 'No room to duplicate that panel.';
      return;
    }
    dashboard = { ...dashboard, panels: [...dashboard.panels, copy] };
  }

  function onShare(panel: Panel): void {
    if (!browser) return;
    // Absolute instants, so the recipient sees what the sender saw — a relative
    // range would show them different data.
    const resolved = resolveRange($range, { timezone: resolveTimezone(dashboard.time.timezone) });
    const search = mergeDashboardParams(new URLSearchParams(location.search), {
      viewPanel: panel.id,
      from: String(resolved.from),
      to: String(resolved.to),
    });
    void navigator.clipboard?.writeText(`${location.origin}${withSearch(location.pathname, search)}`);
    saveMessage = 'Link copied.';
  }

  // --- saving --------------------------------------------------------------

  let saving = false;
  let saveMessage = '';
  let conflict = false;

  async function save(): Promise<void> {
    if (!editable || saving) return;
    saving = true;
    saveMessage = '';
    conflict = false;
    try {
      const res = await fetch(
        `/api/v1/orgs/${data.record.orgId}/dashboards/${data.record.uid}?expectedVersion=${version}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dashboard),
        },
      );
      const body = await res.json().catch(() => ({}));

      if (res.status === 409) {
        // A real outcome, not an error: someone else saved. The API returns
        // their version so this can say more than "reload".
        conflict = true;
        saveMessage = `Someone else saved this dashboard (version ${body.currentVersion ?? '?'}).`;
        return;
      }
      if (!res.ok) {
        saveMessage = body.error ?? 'Could not save.';
        return;
      }

      // Adopt the SERVER's model and version. Validation normalises on write —
      // it clamps refresh, narrows off-grid panels, renames duplicate ids — so
      // keeping the model we sent would leave the dashboard permanently dirty,
      // and keeping the old version would make the next save a spurious 409.
      dashboard = body.dashboard.model;
      version = body.dashboard.version;
      baseline = baselineOf(dashboard);
      saveMessage =
        body.warnings?.length > 0
          ? `Saved with ${body.warnings.length} adjustment${body.warnings.length === 1 ? '' : 's'}.`
          : 'Saved.';
    } catch (err) {
      saveMessage = 'Could not reach the server.';
      console.error('Dashboard save failed:', err);
    } finally {
      saving = false;
    }
  }

  // --- lifecycle -----------------------------------------------------------

  beforeNavigate((nav) => {
    // Our own URL writes are same-route navigations; without this check picking
    // a time range would prompt "you have unsaved changes".
    if (nav.to?.url.pathname === nav.from?.url.pathname) return;
    if (!dirty) return;
    // Must be synchronous — a custom modal cannot be awaited here. For a tab
    // close SvelteKit turns this into the browser's native dialog, which shows
    // ITS message, not ours.
    if (!confirm('This dashboard has unsaved changes. Leave anyway?')) nav.cancel();
  });

  onMount(() => {
    range.syncInitialUrl();
    runAll();
    const onVisible = () => scheduler.resume();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });

  onDestroy(() => {
    scheduler.stop();
    // cancelAll aborts in flight work; dispose also clears the per-panel
    // generation map, which otherwise grows by one entry per panel of every
    // dashboard this session visits.
    runner.dispose();
  });
</script>

<svelte:head><title>{dashboard.title} — Arc Launchpad</title></svelte:head>

{#if !kiosk}
  <header class="toolbar">
    <div class="left">
      <h1>{dashboard.title}</h1>
      {#if dirty}<span class="dot" title="Unsaved changes"></span>{/if}
    </div>

    <div class="right">
      <!-- A minimal preset control. #26 replaces this with the real picker; the
           range STATE and its URL round-trip are what this page owns. -->
      <select
        aria-label="Time range"
        value={$range.from}
        on:change={(e) => range.set({ from: e.currentTarget.value, to: 'now' })}
      >
        {#each ['now-5m', 'now-1h', 'now-6h', 'now-24h', 'now-7d', 'now-30d'] as preset}
          <option value={preset}>{preset.replace('now-', 'Last ')}</option>
        {/each}
      </select>

      <select
        aria-label="Refresh interval"
        value={refreshInterval}
        on:change={(e) => setRefresh(e.currentTarget.value)}
      >
        <option value="">Off</option>
        {#each ['10s', '30s', '1m', '5m'] as r}<option value={r}>{r}</option>{/each}
      </select>

      <Button variant="outline" size="sm" on:click={() => runAll(true)} aria-label="Refresh now">
        <RefreshCw class="h-4 w-4" />
      </Button>

      {#if editable}
        <Button variant="outline" size="sm" on:click={addPanel}>
          <Plus class="mr-1 h-4 w-4" /> Add panel
        </Button>
        <Button size="sm" disabled={!dirty || saving} on:click={save}>
          {#if saving}<Loader2 class="mr-1 h-4 w-4 animate-spin" />{:else}<Save class="mr-1 h-4 w-4" />{/if}
          Save
        </Button>
      {/if}

      <Button variant="ghost" size="sm" on:click={() => writeUrl({ kiosk: true })} aria-label="Kiosk mode">
        <Maximize2 class="h-4 w-4" />
      </Button>
    </div>
  </header>

  {#if saveMessage}
    <p class="notice" class:conflict role="status">
      {saveMessage}
      {#if conflict}
        <button type="button" class="link" on:click={() => location.reload()}>Reload</button>
      {/if}
    </p>
  {/if}
{/if}

{#if draft && editorComponent}
  <div class="editor-overlay">
    <svelte:component
      this={editorComponent}
      {dashboard}
      {draft}
      {ctx}
      {runner}
      on:apply={onDraftApply}
      on:discard={discardDraft}
      on:change={onDraftChange}
    />
  </div>
{:else if viewPanel}
  <!-- Exactly one PanelChrome, and the grid is NOT mounted. Rendering an
       overlay above a live grid would give the same panel id two instances,
       whose generations invalidate each other; filtering the grid's panels down
       to one would make a drag emit a one-panel array and delete the rest. -->
  <div class="fullscreen">
    <PanelChrome
      panel={viewPanel}
      result={results[viewPanel.id] ?? null}
      inFlight={inFlight[viewPanel.id] ?? false}
      {editable}
      on:view={() => writeUrl({ viewPanel: null })}
      on:refresh={() => runPanel(viewPanel, true)}
      on:share={() => onShare(viewPanel)}
      on:remove={() => {
        onRemove(viewPanel);
        writeUrl({ viewPanel: null });
      }}
      on:duplicate={() => onDuplicate(viewPanel)}
      on:edit={() => openEditor(viewPanel)}
    />
  </div>
{:else if dashboard.panels.length === 0}
  <div class="empty">
    <p>This dashboard has no panels yet.</p>
    {#if editable}<Button on:click={addPanel}><Plus class="mr-1 h-4 w-4" /> Add panel</Button>{/if}
  </div>
{:else}
  <DashboardGrid
    panels={dashboard.panels}
    editable={editable && !kiosk}
    on:change={(e) => onGridChange(e.detail.panels)}
    on:nospace={() => (saveMessage = 'No room for that change.')}
    let:panel
  >
    <PanelChrome
      {panel}
      result={results[panel.id] ?? null}
      inFlight={inFlight[panel.id] ?? false}
      {editable}
      on:view={() => writeUrl({ viewPanel: panel.id })}
      on:refresh={() => runPanel(panel, true)}
      on:share={() => onShare(panel)}
      on:remove={() => onRemove(panel)}
      on:duplicate={() => onDuplicate(panel)}
      on:edit={() => openEditor(panel)}
      let:result
    >
      {#await ensureRenderer(panel.type) then _}
        {#if renderers[panel.type]}
          <svelte:component
        this={renderers[panel.type]}
        {result}
        fieldConfig={panel.fieldConfig}
        from={ctx.from}
        to={ctx.to}
        timezone={ctx.timezone}
        priorSlots={panelSlots[panel.id] ?? {}}
        on:slots={rememberSlots(panel.id)}
      />
        {:else}
          <p class="unsupported">No renderer for a “{panel.type}” panel yet.</p>
        {/if}
      {/await}
    </PanelChrome>
  </DashboardGrid>
{/if}

<svelte:window
  on:keydown={(e) => {
    if (e.key !== 'Escape') return;
    // Precedence: the grid and the panel chrome handle Escape for their own
    // in-progress interactions, so this only acts on page-level modes. The
    // editor is excluded deliberately — Escape there belongs to CodeMirror, and
    // silently discarding a draft would be data loss.
    if (draft) return;
    if (viewPanel) writeUrl({ viewPanel: null });
    else if (kiosk) writeUrl({ kiosk: false });
  }}
/>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    padding: 0 0 0.75rem;
  }
  .left { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
  h1 { margin: 0; font-size: 1.125rem; font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 9999px; background: hsl(var(--primary)); }
  .right { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  select {
    height: 2rem;
    border-radius: 0.375rem;
    border: 1px solid hsl(var(--border));
    background: hsl(var(--background));
    padding: 0 0.5rem;
    font-size: 0.8125rem;
  }
  .notice {
    margin: 0 0 0.75rem;
    font-size: 0.8125rem;
    color: hsl(var(--muted-foreground));
  }
  .notice.conflict { color: hsl(var(--destructive)); }
  .link { border: 0; background: transparent; text-decoration: underline; cursor: pointer; font: inherit; }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 4rem 1rem;
    color: hsl(var(--muted-foreground));
  }
  .fullscreen { height: calc(100vh - 8rem); }
  .editor-overlay { height: calc(100vh - 8rem); }
  .unsupported {
    display: flex; height: 100%; align-items: center; justify-content: center;
    font-size: 0.8125rem; color: hsl(var(--muted-foreground)); text-align: center;
  }
</style>
