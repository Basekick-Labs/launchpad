<!--
  The query inspector: what was actually sent, what came back, and how long it
  took. This is the panel users open when they suspect a query is misbehaving,
  so it must not show them a cleaned-up version of either.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { inspectorRows, csvFilename } from '$lib/dashboard/panelState';
  import { toCsvChunks } from '$lib/csv';
  import { downloadBlob } from '$lib/download';
  import type { PanelResult, TargetResult } from '$lib/dashboard/queryRunner';

  export let result: PanelResult | null = null;
  export let title = '';
  export let open = false;

  /** Up to ten targets, so they are tabbed rather than stacked. */
  $: targets = result?.targets ?? [];
  let activeRefId = '';
  $: if (targets.length > 0 && !targets.some((t) => t.refId === activeRefId)) {
    activeRefId = targets[0].refId;
  }
  $: active = targets.find((t) => t.refId === activeRefId);
  $: table = active ? inspectorRows(active) : { columns: [], rows: [] };

  /** First 100 rows; the CSV carries everything. */
  $: preview = table.rows.slice(0, 100);

  function download(target: TargetResult): void {
    const { columns, rows } = inspectorRows(target);
    downloadBlob(
      toCsvChunks(columns, rows, { bom: true }),
      csvFilename(title, target.refId),
      'text/csv;charset=utf-8',
    );
  }
</script>

{#if open}
  <div class="inspector">
    <div class="tabs" role="tablist">
      {#each targets as t (t.refId)}
        <button
          type="button"
          role="tab"
          aria-selected={t.refId === activeRefId}
          class="tab"
          class:active={t.refId === activeRefId}
          on:click={() => (activeRefId = t.refId)}
        >
          {t.refId}
          {#if t.error}<span class="dot" aria-label="failed"></span>{/if}
        </button>
      {/each}
    </div>

    {#if active}
      <section>
        <h4>Query</h4>
        {#if active.executedSql}
          <!-- The EXECUTED SQL, after macro and variable expansion — showing the
               template would defeat the purpose of the panel. -->
          <pre>{active.executedSql}</pre>
        {:else}
          <p class="muted">Not executed — {active.error?.message ?? 'no query configured'}</p>
        {/if}
        <p class="muted">
          {#if active.cached}
            Served from cache
          {:else}
            {active.durationMs} ms
          {/if}
          · {table.rows.length} row{table.rows.length === 1 ? '' : 's'}
        </p>
      </section>

      {#if active.error}
        <section>
          <h4>Error</h4>
          <!-- `message` only. QueryError.detail may carry upstream response
               bodies and is documented as never rendered. -->
          <p class="err">{active.error.message}</p>
          <p class="muted">{active.error.kind}{active.error.status ? ` · ${active.error.status}` : ''}</p>
        </section>
      {/if}

      {#if table.rows.length > 0}
        <section>
          <div class="rows-head">
            <h4>Rows</h4>
            <Button variant="outline" size="sm" on:click={() => download(active)}>
              Download CSV
            </Button>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>{#each table.columns as c}<th>{c}</th>{/each}</tr>
              </thead>
              <tbody>
                {#each preview as row}
                  <tr>{#each row as cell}<td>{cell === null || cell === undefined ? '' : String(cell)}</td>{/each}</tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if table.rows.length > preview.length}
            <p class="muted">Showing {preview.length} of {table.rows.length}. The CSV has all of them.</p>
          {/if}
        </section>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .inspector { display: flex; flex-direction: column; gap: 1rem; font-size: 0.8125rem; }
  .tabs { display: flex; gap: 0.25rem; flex-wrap: wrap; }
  .tab {
    display: inline-flex; align-items: center; gap: 0.35rem;
    padding: 0.25rem 0.6rem; border-radius: 0.375rem; border: 1px solid hsl(var(--border));
    background: transparent; font-size: 0.75rem; cursor: pointer;
  }
  .tab.active { background: hsl(var(--muted)); }
  .dot { width: 6px; height: 6px; border-radius: 9999px; background: hsl(var(--destructive)); }
  h4 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em;
       color: hsl(var(--muted-foreground)); margin: 0 0 0.35rem; }
  pre {
    margin: 0; padding: 0.6rem; border-radius: 0.375rem; background: hsl(var(--muted));
    overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-size: 0.75rem;
  }
  .muted { color: hsl(var(--muted-foreground)); margin: 0.35rem 0 0; font-size: 0.75rem; }
  .err { color: hsl(var(--destructive)); margin: 0; word-break: break-word; }
  .rows-head { display: flex; align-items: center; justify-content: space-between; }
  .table-wrap { overflow: auto; max-height: 18rem; border: 1px solid hsl(var(--border)); border-radius: 0.375rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid hsl(var(--border));
           white-space: nowrap; font-variant-numeric: tabular-nums; }
  th { position: sticky; top: 0; background: hsl(var(--background)); }
</style>
