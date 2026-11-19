<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import {
    ClusterApiError,
    createBackup,
    deleteBackup,
    getBackupDetail,
    getBackupProgress,
    getBackups,
    restoreBackup,
  } from '$lib/cloudApi';
  import {
    describeProgress,
    progressPercent,
    restoreImpact,
    type ActionOutcome,
    type BackupDetail,
    type BackupProgress,
    type BackupSummary,
    type BackupsView,
  } from '$lib/backup';
  import { accessProblem, type CapabilityView } from '$lib/capabilities';
  import { describeClusterError } from '$lib/cluster';
  import { formatBytes, formatCount } from '$lib/format';
  import { formatDateTime, timezone } from '$lib/stores/timezone';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as AlertDialog from '$lib/components/ui/alert-dialog';
  import { Archive, Loader2, Plus, RefreshCw } from 'lucide-svelte';

  export let orgId: string;
  export let instanceId: string;
  /** Discovery's answer for `backup`, which says when Arc has backups turned off. */
  export let capability: CapabilityView | null = null;

  const dispatch = createEventDispatcher<{ recheck: void }>();

  /** While an operation runs. Arc updates its progress after each file. */
  const POLL_MS = 2000;

  let view: BackupsView | null = null;
  let progress: BackupProgress | null = null;
  let error: string | null = null;
  let loading = false;
  let controller: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  /** The last action's outcome, until the next one. */
  let notice: { kind: 'ok' | 'warn' | 'error'; text: string } | null = null;
  let busy = false;

  // The backup routes' messages say what failed (a backup Arc does not have,
  // Arc's own reason); the shared auth check's ('Forbidden') do not.
  const message = (err: unknown, what: string) =>
    err instanceof ClusterApiError ? (err.code === 'forbidden' || err.code === 'error' ? describeClusterError(err.code) : err.message) : `Could not ${what}`;

  async function load() {
    controller?.abort();
    const ctl = (controller = new AbortController());
    loading = true;
    try {
      view = await getBackups(orgId, instanceId, ctl.signal);
      progress = view.progress;
      error = null;
    } catch (err) {
      if (!ctl.signal.aborted) error = message(err, 'load backups');
    } finally {
      if (controller === ctl) loading = false;
    }
  }

  /** Follow a running operation; reload the list once it ends, since a backup adds one. */
  async function poll() {
    if (destroyed || progress?.status !== 'running') return;
    if (document.visibilityState === 'visible') {
      try {
        const p = (await getBackupProgress(orgId, instanceId)).progress;
        if (destroyed) return;
        const ended = p.status !== 'running';
        progress = p;
        if (ended) {
          await load();
          return;
        }
      } catch {
        // Keep the last progress on screen; the next poll tries again.
      }
    }
    pollTimer = setTimeout(poll, POLL_MS);
  }
  $: if (progress?.status === 'running' && pollTimer === undefined) pollTimer = setTimeout(poll, POLL_MS);
  $: if (progress?.status !== 'running' && pollTimer !== undefined) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function checkAgain() {
    dispatch('recheck');
    load();
  }

  onMount(load);
  onDestroy(() => {
    destroyed = true;
    controller?.abort();
    detailController?.abort();
    clearTimeout(pollTimer);
  });

  $: running = progress?.status === 'running';
  $: percent = progress ? progressPercent(progress) : null;
  $: clustered = view?.node.clustered ?? false;
  $: off = capability?.state === 'disabled';

  function show(o: ActionOutcome) {
    notice = { kind: o.result === 'done' ? 'ok' : 'error', text: o.message };
  }

  async function act(run: () => Promise<ActionOutcome>, what: string) {
    busy = true;
    notice = null;
    try {
      const o = await run();
      show(o);
      return o;
    } catch (err) {
      notice = { kind: 'error', text: message(err, what) };
      return null;
    } finally {
      busy = false;
      await load();
    }
  }

  // ---- Detail

  let selected: string | null = null;
  let detail: BackupDetail | null = null;
  let detailError: string | null = null;
  let detailController: AbortController | null = null;

  async function loadDetail(id: string): Promise<BackupDetail | null> {
    detailController?.abort();
    const ctl = (detailController = new AbortController());
    detail = null;
    detailError = null;
    try {
      const d = (await getBackupDetail(orgId, instanceId, id, ctl.signal)).backup;
      if (detailController === ctl) detail = d;
      return d;
    } catch (err) {
      if (detailController === ctl && !ctl.signal.aborted) detailError = message(err, 'load the backup');
      return null;
    }
  }

  function toggle(id: string) {
    selected = selected === id ? null : id;
    if (selected) loadDetail(selected);
  }

  // ---- Create

  let createOpen = false;
  let includeMetadata = true;
  let includeConfig = false;

  async function confirmCreate() {
    await act(() => createBackup(orgId, instanceId, { includeMetadata, includeConfig }), 'start the backup');
    // Closed whatever happened: the outcome is shown above the list.
    createOpen = false;
  }

  // ---- Delete

  let deleteTarget: BackupSummary | null = null;
  let deleteOpen = false;

  function askDelete(b: BackupSummary) {
    deleteTarget = b;
    deleteOpen = true;
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    const o = await act(() => deleteBackup(orgId, instanceId, id), 'delete the backup');
    deleteOpen = false;
    if (o?.result === 'done' && selected === id) selected = null;
  }

  // ---- Restore

  let restoreTarget: BackupSummary | null = null;
  let restoreDetail: BackupDetail | null = null;
  let restoreOpen = false;
  let restoreData = true;
  let restoreMetadata = false;
  let restoreConfig = false;

  async function askRestore(b: BackupSummary) {
    restoreTarget = b;
    restoreDetail = null;
    restoreOpen = true;
    selected = b.id;
    const d = await loadDetail(b.id);
    if (restoreTarget?.id !== b.id) return;
    restoreDetail = d;
    restoreData = true;
    // Arc's own defaults: the metadata on a standalone node, never the config.
    restoreMetadata = !!d?.hasMetadata && !clustered;
    restoreConfig = false;
  }

  $: impact = restoreDetail ? restoreImpact(restoreDetail, { restoreData, restoreMetadata, restoreConfig }, clustered) : [];
  $: restoreBlocked = !restoreDetail || (!restoreData && !restoreMetadata && !restoreConfig) || restoreDetail.unavailableTargets.length > 0;

  async function confirmRestore() {
    if (!restoreTarget || restoreBlocked) return;
    const id = restoreTarget.id;
    const o = await act(() => restoreBackup(orgId, instanceId, id, { restoreData, restoreMetadata, restoreConfig }), 'start the restore');
    restoreOpen = false;
    if (o?.result === 'done') {
      const mode = o.mode ? ` Arc runs it as a ${o.mode}.` : '';
      const restart = o.restartRequired ? ' Restart Arc once it completes: the restored metadata or configuration applies only then.' : '';
      notice = { kind: o.restartRequired ? 'warn' : 'ok', text: `${o.message}${mode}${restart}` };
    }
  }

  const when = (iso: string | null, tz: 'utc' | 'local') => (iso ? formatDateTime(iso, tz) : '—');
  const nodeLabel = (v: BackupsView) => (v.node.clustered ? `primary writer ${v.node.nodeId} (${v.node.source})` : v.node.source);
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center justify-between border-b px-4 py-3">
    <div>
      <h2 class="text-lg font-semibold">Backups</h2>
      <p class="text-sm text-muted-foreground">
        Backups Arc writes to its own backup destination.{#if view} Run on {nodeLabel(view)}.{/if}
      </p>
    </div>
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" on:click={load} disabled={loading} aria-label="Reload backups">
        <RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
      </Button>
      {#if view}
        <Button size="sm" on:click={() => (createOpen = true)} disabled={running || busy}>
          <Plus class="mr-2 h-4 w-4" />
          Create Backup
        </Button>
      {/if}
    </div>
  </div>

  <div class="flex-1 space-y-4 overflow-auto p-4">
    {#if notice}
      <p
        class="rounded-lg border p-3 text-sm {notice.kind === 'ok' ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-100' : notice.kind === 'warn' ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100' : 'border-destructive/40 bg-destructive/10'}"
        role={notice.kind === 'error' ? 'alert' : 'status'}
      >
        {notice.text}
      </p>
    {/if}

    {#if !view && error && off}
      <div class="flex flex-col items-center justify-center gap-4 py-12 text-center">
        <Archive class="h-12 w-12 text-muted-foreground/30" />
        <div>
          <p class="text-lg font-medium">Backups Not Available</p>
          <p class="mt-2 max-w-md text-sm text-muted-foreground">
            Backups are turned off on this Arc server. To turn them on, set <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">enabled = true</code> in the
            <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">[backup]</code> section of the instance's <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">arc.toml</code>:
          </p>
          <pre class="mt-4 rounded-md bg-muted p-4 text-left font-mono text-xs">[backup]
enabled = true</pre>
          <p class="mt-4 text-xs text-muted-foreground">
            The arc.toml Arc ships already has a <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">[backup]</code> section: change its <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">enabled</code> line
            rather than adding a second <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">[backup]</code>, which stops Arc from starting.
            Or set <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">ARC_BACKUP_ENABLED=true</code> in Arc's environment, which overrides arc.toml. Then restart the Arc server.
          </p>
        </div>
        <Button variant="outline" on:click={checkAgain}>
          <RefreshCw class="mr-2 h-4 w-4" />
          Check Again
        </Button>
      </div>
    {:else if !view && error}
      <div class="flex flex-col items-center justify-center gap-4 py-12 text-center">
        <p class="text-destructive" role="alert">{accessProblem(capability) ?? error}</p>
        <Button variant="outline" on:click={checkAgain}>Try Again</Button>
      </div>
    {:else if !view}
      <p class="py-12 text-center text-sm text-muted-foreground">Loading backups…</p>
    {:else}
      {#if error}
        <p class="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">Could not reload: {error}. Showing what was loaded before.</p>
      {/if}

      {#if progress}
        <section class="rounded-lg border bg-card p-4 text-sm" aria-labelledby="backup-progress">
          <div class="flex items-center justify-between gap-2">
            <h3 id="backup-progress" class="font-semibold">{running ? 'Running now' : 'Last operation'}</h3>
            {#if progress.status !== 'idle'}
              <Badge variant={progress.status === 'failed' ? 'destructive' : progress.status === 'completed' ? 'success' : 'secondary'}>{progress.status}</Badge>
            {/if}
          </div>
          <p class="mt-1">{describeProgress(progress)}</p>
          {#if progress.status !== 'idle'}
            {#if running}
              <div class="mt-3 h-2 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-label="{progress.operation} progress">
                <div class="h-full bg-primary transition-all" style="width: {percent ?? 0}%" />
              </div>
            {/if}
            <p class="mt-2 text-xs text-muted-foreground">
              {formatCount(progress.processedFiles)} of {formatCount(progress.totalFiles)} files{#if progress.totalBytes}, {formatBytes(progress.processedBytes)} of {formatBytes(progress.totalBytes)}{/if}{#if progress.skippedFiles}, {formatCount(progress.skippedFiles)} skipped{/if}
              · started {when(progress.startedAt, $timezone)}{#if progress.completedAt} · ended {when(progress.completedAt, $timezone)}{/if}
              {#if progress.mode} · {progress.mode}{/if}
              {#if progress.scope.length} · databases {progress.scope.join(', ')}{/if}
            </p>
          {/if}
          <p class="mt-2 text-xs text-muted-foreground">Arc keeps only the running or last operation, in memory: a restart of Arc clears it.</p>
        </section>
      {/if}

      {#each view.notes as note}
        <p class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100" role="note">{note}</p>
      {/each}
      {#if view.incompleteRuns.length}
        <p class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100" role="note">
          Not listed, because they did not land on every destination they were written to:
          {view.incompleteRuns.map((r) => `${r.id}${r.missingTargets.length ? ` (missing on ${r.missingTargets.join(', ')})` : ''}`).join('; ')}.
        </p>
      {/if}

      {#if view.backups.length === 0}
        <div class="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <Archive class="h-12 w-12 text-muted-foreground/50" />
          <p class="text-lg font-medium">No backups</p>
          <p class="text-sm text-muted-foreground">Arc's backup destination holds no backup of this instance.</p>
        </div>
      {:else}
        <div class="overflow-x-auto rounded-lg border">
          <table class="w-full text-sm">
            <thead class="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" class="px-3 py-2 font-medium">Backup</th>
                <th scope="col" class="px-3 py-2 font-medium">Created</th>
                <th scope="col" class="px-3 py-2 font-medium">Contents</th>
                <th scope="col" class="px-3 py-2 text-right font-medium">Files</th>
                <th scope="col" class="px-3 py-2 text-right font-medium">Size</th>
                <th scope="col" class="px-3 py-2"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {#each view.backups as b (b.id)}
                <tr class="border-t {selected === b.id ? 'bg-accent/40' : ''}">
                  <td class="px-3 py-2">
                    <button class="font-mono text-xs underline-offset-2 hover:underline" on:click={() => toggle(b.id)} aria-expanded={selected === b.id}>{b.id}</button>
                    {#if b.targets.length}<div class="text-xs text-muted-foreground">on {b.targets.join(', ')}</div>{/if}
                  </td>
                  <td class="whitespace-nowrap px-3 py-2">{when(b.createdAt, $timezone)}</td>
                  <td class="px-3 py-2">
                    {b.scope.length ? `${b.scope.join(', ')}` : `${b.databaseCount} database${b.databaseCount === 1 ? '' : 's'}`}
                    {#if b.scope.length}<Badge variant="outline" class="ml-1">scoped</Badge>{/if}
                    {#if b.missingFiles}<Badge variant="destructive" class="ml-1">{b.missingFiles} missing</Badge>{/if}
                    {#if b.partialView}<Badge variant="outline" class="ml-1" title="Not every destination answered: counts are lower bounds">partial view</Badge>{/if}
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums">{formatCount(b.totalFiles)}</td>
                  <td class="px-3 py-2 text-right tabular-nums">{formatBytes(b.totalBytes)}</td>
                  <td class="whitespace-nowrap px-3 py-2 text-right">
                    <Button variant="outline" size="sm" on:click={() => askRestore(b)} disabled={running || busy}>Restore</Button>
                    <Button variant="ghost" size="sm" class="text-destructive" on:click={() => askDelete(b)} disabled={running || busy}>Delete</Button>
                  </td>
                </tr>
                {#if selected === b.id}
                  <tr class="border-t bg-muted/20">
                    <td colspan="6" class="px-3 py-3">
                      {#if detailError}
                        <p class="text-sm text-destructive" role="alert">{detailError}</p>
                      {:else if !detail || detail.id !== b.id}
                        <p class="text-sm text-muted-foreground">Loading…</p>
                      {:else}
                        <div class="space-y-2 text-sm">
                          <p class="text-xs text-muted-foreground">
                            Written by Arc {detail.version ?? 'of an unknown version'} · holds {detail.hasMetadata ? 'Arc\'s metadata' : 'no metadata'} and {detail.hasConfig ? 'arc.toml' : 'no arc.toml'}
                            {#if detail.scope.length} · scoped to {detail.scope.join(', ')}{/if}
                          </p>
                          {#if detail.missingFiles}
                            <p class="text-destructive">
                              Incomplete: {detail.missingFiles} data {detail.missingFiles === 1 ? 'file was' : 'files were'} not stored.{#if detail.skippedSample.length} Among them: <span class="font-mono text-xs">{detail.skippedSample.join(', ')}</span>{/if}
                            </p>
                          {/if}
                          {#if detail.unavailableTargets.length}
                            <p class="text-destructive">Arc refuses to restore it until these destinations answer and hold their part of it again: {detail.unavailableTargets.join(', ')}.</p>
                          {/if}
                          {#if detail.databases.length}
                            <ul class="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                              {#each detail.databases as db (db.name)}
                                <li class="rounded border bg-card px-2 py-1">
                                  <span class="font-medium">{db.name}</span>
                                  <span class="text-xs text-muted-foreground">· {formatCount(db.fileCount)} files · {formatBytes(db.sizeBytes)}</span>
                                  {#if db.measurements.length}
                                    <div class="text-xs text-muted-foreground">{db.measurements.map((m) => m.name).join(', ')}</div>
                                  {/if}
                                </li>
                              {/each}
                            </ul>
                          {/if}
                          {#if detail.truncated}<p class="text-xs text-muted-foreground">The backup holds more databases or measurements than Launchpad lists.</p>{/if}
                        </div>
                      {/if}
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
        {#if view.truncated}<p class="text-xs text-muted-foreground">Arc holds more backups than Launchpad lists; the oldest are not shown.</p>{/if}
      {/if}
    {/if}
  </div>
</div>

<Dialog.Root bind:open={createOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Create Backup</Dialog.Title>
      <Dialog.Description>
        A backup of the whole instance, written to Arc's backup destination{view ? ` by ${nodeLabel(view)}` : ''}. Arc runs one backup or restore at a time.
      </Dialog.Description>
    </Dialog.Header>
    <div class="space-y-3 text-sm">
      <label class="flex items-start gap-2">
        <input type="checkbox" bind:checked={includeMetadata} class="mt-0.5 h-4 w-4 rounded border-input" />
        <span>Arc's metadata<span class="block text-xs text-muted-foreground">Tokens, retention policies, continuous queries and the audit log.</span></span>
      </label>
      <label class="flex items-start gap-2">
        <input type="checkbox" bind:checked={includeConfig} class="mt-0.5 h-4 w-4 rounded border-input" />
        <span>arc.toml<span class="block text-xs text-muted-foreground">It holds the credentials of any remote backup destination, which would then be stored with the backup.</span></span>
      </label>
    </div>
    <Dialog.Footer>
      <Button variant="outline" on:click={() => (createOpen = false)} disabled={busy}>Cancel</Button>
      <Button on:click={confirmCreate} disabled={busy || running}>
        {#if busy}<Loader2 class="mr-2 h-4 w-4 animate-spin" />{/if}
        Start Backup
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={deleteOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete Backup</AlertDialog.Title>
      <AlertDialog.Description>
        {#if deleteTarget}
          Delete <span class="font-mono">{deleteTarget.id}</span>, created {when(deleteTarget.createdAt, $timezone)}
          ({formatCount(deleteTarget.totalFiles)} files, {formatBytes(deleteTarget.totalBytes)}){deleteTarget.targets.length ? ` on ${deleteTarget.targets.join(', ')}` : ''}?
          Arc removes it from its backup destination; it cannot be restored afterwards.
        {/if}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={busy}>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action on:click={confirmDelete} disabled={busy}>
        {#if busy}<Loader2 class="mr-2 h-4 w-4 animate-spin" />{/if}
        Delete Backup
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<Dialog.Root bind:open={restoreOpen}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Restore Backup</Dialog.Title>
      <Dialog.Description>
        {#if restoreTarget}
          Restore <span class="font-mono">{restoreTarget.id}</span>, created {when(restoreTarget.createdAt, $timezone)}, onto
          {view ? nodeLabel(view) : 'this instance'}.
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    {#if !restoreDetail}
      <p class="text-sm {detailError ? 'text-destructive' : 'text-muted-foreground'}">{detailError ?? 'Reading the backup…'}</p>
    {:else}
      <div class="space-y-3 text-sm">
        <label class="flex items-start gap-2">
          <input type="checkbox" bind:checked={restoreData} class="mt-0.5 h-4 w-4 rounded border-input" />
          <span>Data<span class="block text-xs text-muted-foreground">{formatCount(restoreDetail.totalFiles)} files, {formatBytes(restoreDetail.totalBytes)}.</span></span>
        </label>
        {#if restoreDetail.hasMetadata && !clustered}
          <label class="flex items-start gap-2">
            <input type="checkbox" bind:checked={restoreMetadata} class="mt-0.5 h-4 w-4 rounded border-input" />
            <span>Arc's metadata<span class="block text-xs text-muted-foreground">Tokens, retention policies, continuous queries and the audit log.</span></span>
          </label>
        {/if}
        {#if restoreDetail.hasConfig && !clustered}
          <label class="flex items-start gap-2">
            <input type="checkbox" bind:checked={restoreConfig} class="mt-0.5 h-4 w-4 rounded border-input" />
            <span>arc.toml</span>
          </label>
        {/if}
        {#if clustered}
          <p class="text-xs text-muted-foreground">On a cluster only data is restored: Arc's metadata and arc.toml hold each node's own tokens, tier records and identity.</p>
        {/if}
        {#if restoreDetail.unavailableTargets.length}
          <p class="text-destructive" role="alert">Arc refuses this restore until these destinations answer and hold their part of the backup again: {restoreDetail.unavailableTargets.join(', ')}.</p>
        {:else if impact.length}
          <div class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100" role="note">
            <p class="font-medium">What this restore does</p>
            <ul class="mt-1 list-disc space-y-1 pl-5">
              {#each impact as line}<li>{line}</li>{/each}
            </ul>
          </div>
        {/if}
      </div>
    {/if}
    <Dialog.Footer>
      <Button variant="outline" on:click={() => (restoreOpen = false)} disabled={busy}>Cancel</Button>
      <Button variant="destructive" on:click={confirmRestore} disabled={busy || running || restoreBlocked}>
        {#if busy}<Loader2 class="mr-2 h-4 w-4 animate-spin" />{/if}
        Restore
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
