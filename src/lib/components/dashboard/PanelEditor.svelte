<!--
  The panel editor: preview on top, query below, options on the right.

  Lazily loaded by the dashboard page, and that is load-bearing rather than
  tidy: this pulls CodeMirror, which is 1148 KB in the console route's chunk.
  A static import would take the dashboard route from 209 KB toward a megabyte —
  a fivefold regression on the page users sit on all day.

  ## The draft runs under its own id

  `queryRunner` keys `generations` and `panelControllers` on `panel.id`, and its
  `cancelPanel` is called by the page before every re-run. Sharing the id with
  the grid's panel means a refresh tick aborts the preview's query mid-flight and
  then invalidates its generation — a permanently blank preview with nothing
  logged. `panel.id` is not part of the request key, so a prefixed id separates
  the bookkeeping and still shares the cache.

  ## The preview is not a PanelChrome

  `PanelChrome` renders its slot only in the `content` state, so an error
  unmounts the chart. The acceptance criterion is that the previous data stays
  visible, so this keeps `lastGood` and `attempt` apart and overlays the error.
-->
<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Loader2, Play, Plus, Trash2, Copy } from 'lucide-svelte';
  import SqlEditor from './SqlEditor.svelte';
  import {
    addTarget,
    canAddTarget,
    completionHints,
    draftRunId,
    duplicateTarget,
    editEffect,
    removeTarget,
    sqlByteLength,
    sqlWithinLimit,
    switchPanelType,
    visualisationChoices,
  } from '$lib/dashboard/panelEditor';
  import { errorToShow } from '$lib/dashboard/panelState';
  import { loadPanel } from '$lib/dashboard/panelRegistry';
  import { effectiveBounds, type PanelResult, type QueryRunner, type RunContext } from '$lib/dashboard/queryRunner';
  import { LIMITS, type Dashboard, type Panel, type PanelType } from '$lib/dashboard/model';
  import { UNITS } from '$lib/dashboard/units';

  export let dashboard: Dashboard;
  /** The DRAFT. The original stays in `dashboard.panels` untouched. */
  export let draft: Panel;
  export let ctx: RunContext;
  export let runner: QueryRunner;

  const dispatch = createEventDispatcher<{ apply: Panel; discard: void; change: Panel }>();

  let lastGood: PanelResult | null = null;
  let attempt: PanelResult | null = null;
  let running = false;
  let activeRefId = draft.targets[0]?.refId ?? 'A';
  let renderer: unknown = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const runId = draftRunId(draft.id);

  $: activeTarget = draft.targets.find((t) => t.refId === activeRefId) ?? draft.targets[0];
  $: hints = completionHints(dashboard);
  $: bytes = sqlByteLength(activeTarget?.sql ?? '');
  $: overLimit = !sqlWithinLimit(activeTarget?.sql ?? '');
  $: bounds = effectiveBounds(draft, ctx);
  $: previewError = errorToShow(attempt);
  $: choices = visualisationChoices();

  /** Field-config controls, which every panel type reads. */
  $: unit = draft.fieldConfig.defaults.unit ?? '';
  $: decimals = draft.fieldConfig.defaults.decimals ?? null;

  async function loadRenderer(type: PanelType): Promise<void> {
    renderer = await loadPanel(type);
  }
  $: void loadRenderer(draft.type);

  /** The last state a query was actually issued for. */
  let ranFor: Panel = structuredClone(draft);

  async function run(force = false): Promise<void> {
    if (overLimit) return;
    running = true;
    try {
      // Cancel the previous preview run explicitly: the runner overwrites its
      // controller without aborting, so an in-flight query would otherwise keep
      // going and hold a concurrency permit.
      runner.cancelPanel(runId);
      const result = await runner.runPanel(
        dashboard,
        { ...draft, id: runId },
        ctx,
        { noCache: force, maxDataPoints: draft.maxDataPoints },
      );
      if (result.cancelled) return;
      attempt = result;
      // Only a successful result replaces what is on screen, so an error leaves
      // the previous data visible.
      if (result.status !== 'error') lastGood = result;
      ranFor = structuredClone(draft);
    } finally {
      running = false;
    }
  }

  /**
   * An edit either needs the rows again or only a redraw. Deciding it from the
   * request keys rather than "did the SQL change" is what keeps `Min interval`
   * and `Max data points` honest — both move the expanded SQL.
   */
  function onDraftChanged(): void {
    dispatch('change', draft);
    const effect = editEffect(dashboard, ranFor, draft, ctx, {
      maxDataPoints: draft.maxDataPoints,
    });
    if (effect === 'redraw') return;
    if (debounce) clearTimeout(debounce);
    // Typing should not issue a request per keystroke.
    debounce = setTimeout(() => void run(), 600);
  }

  function setSql(sql: string): void {
    draft = {
      ...draft,
      targets: draft.targets.map((t) => (t.refId === activeRefId ? { ...t, sql } : t)),
    };
    onDraftChanged();
  }

  function patchDefaults(patch: Record<string, unknown>): void {
    draft = {
      ...draft,
      fieldConfig: {
        ...draft.fieldConfig,
        defaults: { ...draft.fieldConfig.defaults, ...patch },
      },
    };
    onDraftChanged();
  }

  function patchPanel(patch: Partial<Panel>): void {
    draft = { ...draft, ...patch };
    onDraftChanged();
  }

  function changeType(type: PanelType): void {
    draft = switchPanelType(draft, type);
    onDraftChanged();
  }

  onMount(() => void run());
  onDestroy(() => {
    if (debounce) clearTimeout(debounce);
    // The draft's own runner identity must be released, or its query outlives
    // the editor.
    runner.cancelPanel(runId);
  });
</script>

<section class="editor" aria-label="Panel editor">
  <header>
    <input
      class="title"
      value={draft.title}
      placeholder="Panel title"
      maxlength={LIMITS.maxTitleLength}
      on:input={(e) => patchPanel({ title: e.currentTarget.value })}
    />
    <div class="actions">
      <Button variant="ghost" size="sm" on:click={() => dispatch('discard')}>Discard</Button>
      <Button size="sm" on:click={() => dispatch('apply', draft)}>Apply</Button>
    </div>
  </header>

  <div class="panes">
    <div class="left">
      <div class="preview">
        {#if renderer}
          <svelte:component
            this={renderer}
            result={lastGood}
            fieldConfig={draft.fieldConfig}
            from={bounds.from}
            to={bounds.to}
            timezone={ctx.timezone}
          />
        {:else}
          <p class="muted">No renderer for a “{draft.type}” panel yet.</p>
        {/if}

        {#if previewError}
          <!-- Over the previous chart, not instead of it. Arc's own message. -->
          <p class="error" role="status">{previewError.message}</p>
        {/if}
      </div>

      <div class="query">
        <div class="targets">
          {#each draft.targets as t (t.refId)}
            <button
              type="button"
              class="tab"
              class:active={t.refId === activeRefId}
              on:click={() => (activeRefId = t.refId)}
            >{t.refId}</button>
          {/each}
          <button
            type="button"
            class="tab"
            disabled={!canAddTarget(draft)}
            title={canAddTarget(draft) ? 'Add a query' : `At most ${LIMITS.maxTargetsPerPanel} queries`}
            on:click={() => { draft = addTarget(draft); activeRefId = draft.targets[draft.targets.length - 1].refId; onDraftChanged(); }}
          ><Plus class="h-3 w-3" /></button>
          {#if draft.targets.length > 1}
            <button type="button" class="tab" title="Remove this query"
              on:click={() => { draft = removeTarget(draft, activeRefId); activeRefId = draft.targets[0].refId; onDraftChanged(); }}
            ><Trash2 class="h-3 w-3" /></button>
          {/if}
          <button type="button" class="tab" disabled={!canAddTarget(draft)} title="Duplicate this query"
            on:click={() => { draft = duplicateTarget(draft, activeRefId); onDraftChanged(); }}
          ><Copy class="h-3 w-3" /></button>

          <span class="spacer"></span>
          <span class="bytes" class:over={overLimit}>
            {bytes.toLocaleString('en-US')} / {LIMITS.maxSqlBytes.toLocaleString('en-US')} bytes
          </span>
          <Button variant="outline" size="sm" disabled={running || overLimit} on:click={() => run(true)}>
            {#if running}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Play class="h-3 w-3" />{/if}
            Run
          </Button>
        </div>

        {#if activeTarget}
          <SqlEditor
            value={activeTarget.sql}
            {hints}
            on:change={(e) => setSql(e.detail)}
            on:run={() => run(true)}
          />
        {/if}

        {#if overLimit}
          <p class="error">This query is over the {LIMITS.maxSqlBytes.toLocaleString('en-US')}-byte limit and cannot be saved.</p>
        {/if}
      </div>
    </div>

    <aside class="options" aria-label="Panel options">
      <h3>Visualisation</h3>
      <div class="types">
        {#each choices as c}
          <button
            type="button"
            class="type"
            class:active={c.type === draft.type}
            disabled={!c.available}
            title={c.available ? c.type : `The ${c.type} panel is not built yet`}
            on:click={() => changeType(c.type)}
          >{c.type}{#if !c.available}<span class="soon">soon</span>{/if}</button>
        {/each}
      </div>

      <h3>Field</h3>
      <label>Unit
        <select value={unit} on:change={(e) => patchDefaults({ unit: e.currentTarget.value || undefined })}>
          <option value="">None</option>
          {#each UNITS as u}<option value={u.id}>{u.label}</option>{/each}
        </select>
      </label>
      <label>Decimals
        <input type="number" min="0" max="10" value={decimals ?? ''}
          on:input={(e) => patchDefaults({ decimals: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value) })} />
      </label>
      <label>Min
        <input type="number" value={draft.fieldConfig.defaults.min ?? ''}
          on:input={(e) => patchDefaults({ min: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value) })} />
      </label>
      <label>Max
        <input type="number" value={draft.fieldConfig.defaults.max ?? ''}
          on:input={(e) => patchDefaults({ max: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value) })} />
      </label>
      <label>Display name
        <input value={draft.fieldConfig.defaults.displayName ?? ''}
          on:input={(e) => patchDefaults({ displayName: e.currentTarget.value || undefined })} />
      </label>

      <h3>Query options</h3>
      <label>Min interval
        <input placeholder="e.g. 5m" value={draft.interval ?? ''}
          on:input={(e) => patchPanel({ interval: e.currentTarget.value || undefined })} />
      </label>
      <label>Max data points
        <input type="number" min="1" value={draft.maxDataPoints ?? ''}
          on:input={(e) => patchPanel({ maxDataPoints: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value) })} />
      </label>
      <label>Relative time
        <input placeholder="e.g. now-7d" value={draft.timeFrom ?? ''}
          on:input={(e) => patchPanel({ timeFrom: e.currentTarget.value || undefined })} />
      </label>
      <label>Time shift
        <input placeholder="e.g. 1d" value={draft.timeShift ?? ''}
          on:input={(e) => patchPanel({ timeShift: e.currentTarget.value || undefined })} />
      </label>
    </aside>
  </div>
</section>

<style>
  .editor { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 0.5rem; }
  header { display: flex; align-items: center; gap: 1rem; flex: none; }
  .title {
    flex: 1; min-width: 0; height: 2rem; padding: 0 0.5rem; font-size: 0.9375rem; font-weight: 500;
    border: 1px solid transparent; border-radius: 0.375rem; background: transparent;
  }
  .title:hover, .title:focus { border-color: hsl(var(--border)); background: hsl(var(--background)); }
  .actions { display: flex; gap: 0.5rem; flex: none; }

  /* Fixed panes. Draggable dividers are polish and were cut deliberately. */
  .panes { display: flex; gap: 0.75rem; flex: 1; min-height: 0; }
  .left { display: flex; flex-direction: column; gap: 0.5rem; flex: 1; min-width: 0; }
  .preview {
    position: relative; flex: 1 1 55%; min-height: 10rem;
    border: 1px solid hsl(var(--border)); border-radius: 0.5rem; padding: 0.5rem;
  }
  .query { display: flex; flex-direction: column; gap: 0.4rem; flex: 1 1 45%; min-height: 0; }
  .targets { display: flex; align-items: center; gap: 0.25rem; flex-wrap: wrap; }
  .spacer { flex: 1; }
  .tab {
    padding: 0.2rem 0.5rem; border: 1px solid hsl(var(--border)); border-radius: 0.375rem;
    background: transparent; font-size: 0.75rem; cursor: pointer;
  }
  .tab.active { background: hsl(var(--muted)); }
  .tab:disabled { opacity: 0.4; cursor: not-allowed; }
  .bytes { font-size: 0.6875rem; color: hsl(var(--muted-foreground)); font-variant-numeric: tabular-nums; }
  .bytes.over { color: hsl(var(--destructive)); }

  .options {
    width: 16rem; flex: none; overflow: auto; padding-left: 0.75rem;
    border-left: 1px solid hsl(var(--border)); display: flex; flex-direction: column; gap: 0.5rem;
  }
  .options h3 {
    margin: 0.5rem 0 0; font-size: 0.6875rem; text-transform: uppercase;
    letter-spacing: 0.04em; color: hsl(var(--muted-foreground));
  }
  .options label { display: flex; flex-direction: column; gap: 0.15rem; font-size: 0.75rem; }
  .options input, .options select {
    height: 1.75rem; padding: 0 0.35rem; font-size: 0.75rem;
    border: 1px solid hsl(var(--border)); border-radius: 0.25rem; background: hsl(var(--background));
  }
  .types { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .type {
    display: inline-flex; align-items: center; gap: 0.25rem;
    padding: 0.2rem 0.45rem; border: 1px solid hsl(var(--border)); border-radius: 0.375rem;
    background: transparent; font-size: 0.6875rem; cursor: pointer;
  }
  .type.active { background: hsl(var(--muted)); }
  .type:disabled { opacity: 0.45; cursor: not-allowed; }
  .soon { font-size: 0.5625rem; color: hsl(var(--muted-foreground)); }

  .muted {
    display: flex; height: 100%; align-items: center; justify-content: center;
    font-size: 0.8125rem; color: hsl(var(--muted-foreground));
  }
  .error {
    margin: 0.35rem 0 0; font-size: 0.75rem; color: hsl(var(--destructive)); word-break: break-word;
  }
  .preview .error {
    position: absolute; left: 0.5rem; right: 0.5rem; bottom: 0.5rem;
    background: hsl(var(--background) / 0.92); padding: 0.35rem 0.5rem; border-radius: 0.25rem;
    border: 1px solid hsl(var(--destructive) / 0.4);
  }
</style>
