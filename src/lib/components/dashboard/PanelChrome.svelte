<!--
  The frame around every panel: header, state, menu, inspector.

  ## It owns no data and mutates nothing

  Every action is an EVENT. The dashboard page performs the mutation, because it
  owns `panels` and the save flow; a chrome that edited the array would fight the
  grid's layout and the dirty-tracking at once.

  ## It does not own fullscreen either

  `?viewPanel=` is the page's, not the panel's. The grid iterates every panel, so
  a panel cannot exclude itself from the layout — and twenty panels each with a
  window key handler and a URL writer would be twenty racing writers. This
  dispatches `view` and stops.

  ## Header controls sit above the grid's drag handle

  `DashboardGrid` renders a full-width drag handle across the top 2rem of the
  cell, after the slot, so it covers this header. The action cluster is
  `position: relative; z-index: 1`, which paints in the positive stacking step
  and therefore above a `z-index: auto` sibling. Without that the menu simply
  does not open. The title area is deliberately left under the handle — that is
  what makes the header draggable.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { AlertTriangle, Loader2, Info } from 'lucide-svelte';
  import ActionMenu from '$lib/components/ActionMenu.svelte';
  import ActionMenuItem from '$lib/components/ActionMenuItem.svelte';
  import {
    errorToShow,
    failedTargets,
    panelNotices,
    panelView,
    timeOverrideLabel,
  } from '$lib/dashboard/panelState';
  import PanelInspector from './PanelInspector.svelte';
  import type { Panel } from '$lib/dashboard/model';
  import type { PanelResult } from '$lib/dashboard/queryRunner';

  export let panel: Panel;
  export let result: PanelResult | null = null;
  export let inFlight = false;
  /** Interpolated by the host — #31 owns variables, so this is not read from
      `panel.title` directly. */
  export let title: string = panel.title;
  /** False for a viewer: editing controls are hidden AND the API enforces it. */
  export let editable = true;

  const dispatch = createEventDispatcher<{
    view: void;
    edit: void;
    duplicate: void;
    share: void;
    remove: void;
    refresh: void;
  }>();

  let inspecting = false;
  let confirmingRemove = false;

  $: view = panelView(result, inFlight);
  $: failures = failedTargets(result);
  $: notices = panelNotices(result);
  $: shownError = errorToShow(result);
  $: overrideLabel = timeOverrideLabel(panel);
</script>

<div class="panel" class:transparent={panel.transparent}>
  <header>
    <div class="titles">
      <h3 title={title}>{title || 'Untitled panel'}</h3>
      {#if overrideLabel}
        <!-- A panel silently showing week-old data beside panels showing the
             last hour is a live misreading hazard. -->
        <span class="badge muted" title="This panel overrides the dashboard time range">
          {overrideLabel}
        </span>
      {/if}
    </div>

    <!-- Above the grid's drag handle; see the note at the top of this file. -->
    <div class="actions">
      {#if view.busy}
        <Loader2 class="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Loading" />
      {/if}

      {#if panel.description}
        <span class="icon" title={panel.description}>
          <Info class="h-3.5 w-3.5" />
        </span>
      {/if}

      {#if notices.length > 0}
        <button
          type="button"
          class="icon warn"
          title={notices.map((n) => n.message).join('\n')}
          on:click={() => (inspecting = true)}
        >
          <AlertTriangle class="h-3.5 w-3.5" />
        </button>
      {/if}

      {#if failures.length > 0 && view.body !== 'error'}
        <!-- A partly-failed panel reports `success`, so this badge is driven by
             the targets, not the panel status — otherwise one series goes
             missing from a chart that looks entirely healthy. -->
        <button
          type="button"
          class="icon err"
          title={`${failures.length} of ${result?.targets.length} queries failed`}
          on:click={() => (inspecting = true)}
        >
          <AlertTriangle class="h-3.5 w-3.5" />
        </button>
      {/if}

      <ActionMenu>
        <ActionMenuItem on:click={() => dispatch('view')}>View</ActionMenuItem>
        <ActionMenuItem on:click={() => (inspecting = true)}>Inspect</ActionMenuItem>
        <ActionMenuItem on:click={() => dispatch('refresh')}>Refresh</ActionMenuItem>
        <ActionMenuItem on:click={() => dispatch('share')}>Share</ActionMenuItem>
        {#if editable}
          <ActionMenuItem on:click={() => dispatch('edit')}>Edit</ActionMenuItem>
          <ActionMenuItem on:click={() => dispatch('duplicate')}>Duplicate</ActionMenuItem>
          <ActionMenuItem destructive on:click={() => (confirmingRemove = true)}>
            Remove
          </ActionMenuItem>
        {/if}
      </ActionMenu>
    </div>
  </header>

  <div class="body">
    {#if view.body === 'pending'}
      <div class="centred muted">
        <Loader2 class="h-4 w-4 animate-spin" />
      </div>
    {:else if view.body === 'idle'}
      <div class="centred muted">
        {shownError?.message ?? 'This panel has no query yet.'}
      </div>
    {:else if view.body === 'error'}
      <!-- Rendered as data, never thrown: Svelte 4 has no error boundary, so a
           thrown error would take the whole dashboard down with it. Clamped,
           because a panel can be three rows tall and Arc's message can be a
           multi-line parser error — the full text is in the inspector. -->
      <div class="centred error">
        <AlertTriangle class="h-4 w-4" />
        <p class="clamp">{shownError?.message ?? 'Query failed.'}</p>
        <button type="button" class="link" on:click={() => dispatch('refresh')}>Retry</button>
        <button type="button" class="link" on:click={() => (inspecting = true)}>Details</button>
      </div>
    {:else if view.body === 'empty'}
      <div class="centred muted">No data</div>
    {:else}
      <slot {result} />
    {/if}
  </div>
</div>

{#if inspecting}
  <div
    class="drawer-scrim"
    role="button"
    tabindex="-1"
    aria-label="Close inspector"
    on:click={() => (inspecting = false)}
    on:keydown={(e) => e.key === 'Escape' && (inspecting = false)}
  ></div>
  <aside class="drawer" aria-label="Query inspector">
    <header class="drawer-head">
      <strong>{title || 'Untitled panel'}</strong>
      <button type="button" class="link" on:click={() => (inspecting = false)}>Close</button>
    </header>
    <PanelInspector {result} {title} open={inspecting} />
  </aside>
{/if}

{#if confirmingRemove}
  <div class="drawer-scrim" aria-hidden="true"></div>
  <div class="confirm" role="alertdialog" aria-modal="true" aria-label="Remove panel">
    <p>Remove <strong>{title || 'this panel'}</strong>?</p>
    <div class="confirm-actions">
      <button type="button" class="link" on:click={() => (confirmingRemove = false)}>Cancel</button>
      <button
        type="button"
        class="danger"
        on:click={() => {
          confirmingRemove = false;
          dispatch('remove');
        }}
      >
        Remove
      </button>
    </div>
  </div>
{/if}

<style>
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    min-height: 0;
    border: 1px solid hsl(var(--border));
    border-radius: 0.5rem;
    background: hsl(var(--card));
    /* Deliberately NOT overflow:hidden — the action menu is absolutely
       positioned inside this box, and a three-row panel would clip it. */
  }
  .panel.transparent {
    border-color: transparent;
    background: transparent;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    height: 2rem;
    padding: 0 0.25rem 0 0.6rem;
    flex: none;
  }

  .titles { display: flex; align-items: center; gap: 0.4rem; min-width: 0; }
  h3 {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    flex: none;
    /* The whole point — see the file header. */
    position: relative;
    z-index: 1;
  }

  .icon {
    display: inline-flex;
    padding: 0.2rem;
    border: 0;
    background: transparent;
    color: hsl(var(--muted-foreground));
    cursor: pointer;
  }
  .icon.warn { color: hsl(var(--warning, 38 92% 50%)); }
  .icon.err { color: hsl(var(--destructive)); }

  .badge {
    font-size: 0.6875rem;
    padding: 0.05rem 0.35rem;
    border-radius: 9999px;
    border: 1px solid hsl(var(--border));
    white-space: nowrap;
  }
  .muted { color: hsl(var(--muted-foreground)); }

  .body { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 0 0.6rem 0.6rem; }

  .centred {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    height: 100%;
    font-size: 0.8125rem;
    text-align: center;
  }
  .error { color: hsl(var(--destructive)); }
  .clamp {
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }

  .link {
    border: 0;
    background: transparent;
    color: hsl(var(--muted-foreground));
    font-size: 0.75rem;
    text-decoration: underline;
    cursor: pointer;
  }
  .danger {
    border: 0;
    border-radius: 0.375rem;
    padding: 0.3rem 0.7rem;
    background: hsl(var(--destructive));
    color: hsl(var(--destructive-foreground));
    font-size: 0.8125rem;
    cursor: pointer;
  }

  .drawer-scrim { position: fixed; inset: 0; background: hsl(0 0% 0% / 0.4); z-index: 40; border: 0; }
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(38rem, 100vw);
    z-index: 50;
    overflow: auto;
    padding: 1rem;
    background: hsl(var(--background));
    border-left: 1px solid hsl(var(--border));
  }
  .drawer-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }

  .confirm {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 50;
    padding: 1.25rem;
    border-radius: 0.5rem;
    background: hsl(var(--background));
    border: 1px solid hsl(var(--border));
    min-width: 18rem;
  }
  .confirm-actions { display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 1rem; }
</style>
