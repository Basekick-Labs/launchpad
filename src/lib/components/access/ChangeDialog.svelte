<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import {
    describeChange,
    IMPACT_TEXT,
    permissionText,
    previewChange,
    type Grant,
    type RbacChange,
    type RbacSnapshot,
  } from '$lib/rbac';

  /** The change to confirm; null closes the dialog. */
  export let change: RbacChange | null;
  export let snapshot: RbacSnapshot;
  export let busy = false;

  const dispatch = createEventDispatcher<{ confirm: RbacChange; cancel: void }>();

  $: preview = change ? previewChange(snapshot, change) : null;
  $: destructive = !!change && change.kind.endsWith('.delete');
  /** Widening access, or deleting, needs an explicit acknowledgement. */
  $: needsAck = !!preview && (preview.widensAccess || destructive);
  let ack = false;
  $: change, (ack = false);

  const teamName = (id: number) => snapshot.teams.find((t) => t.id === id)?.name ?? snapshot.teamNames[id] ?? `team ${id}`;
  const scope = (g: Grant) => `${g.databasePattern}${g.measurementPattern ? ` / ${g.measurementPattern}` : ' (all measurements)'}`;
  function onOpenChange(open: boolean) {
    if (!open && !busy) dispatch('cancel');
  }
</script>

<Dialog.Root open={change !== null} onOpenChange={onOpenChange}>
  <Dialog.Content class="max-h-[85vh] max-w-2xl overflow-y-auto">
    {#if change && preview}
      <Dialog.Header>
        <Dialog.Title>Review this change</Dialog.Title>
        <Dialog.Description>{describeChange(snapshot, change)}</Dialog.Description>
      </Dialog.Header>

      {#if preview.cascade}
        <p class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          This also deletes
          {preview.cascade.teams} team{preview.cascade.teams === 1 ? '' : 's'},
          {preview.cascade.roles} role{preview.cascade.roles === 1 ? '' : 's'},
          {preview.cascade.measurementPermissions} measurement permission{preview.cascade.measurementPermissions === 1 ? '' : 's'}
          and {preview.cascade.memberships} token membership{preview.cascade.memberships === 1 ? '' : 's'}. It cannot be undone.
        </p>
      {/if}

      <div class="space-y-3">
        <h3 class="text-sm font-semibold">Effect on tokens</h3>
        {#if preview.impacts.length === 0}
          <p class="text-sm text-muted-foreground">No token's access changes.</p>
        {:else}
          <ul class="space-y-3">
            {#each preview.impacts as impact (impact.tokenId)}
              <li class="rounded-md border p-3 text-sm">
                <div class="font-mono font-medium">{impact.tokenName}</div>
                {#each impact.flags as flag}
                  <p class="mt-1 {flag === 'no_effect_admin' ? 'text-muted-foreground' : flag === 'switches_to_rbac' || flag === 'narrowed_to_measurements' ? '' : 'font-medium text-destructive'}">
                    {IMPACT_TEXT[flag]}{flag === 'reverts_to_token_permissions' ? `: ${permissionText(impact.after.ownPermissions)}` : ''}.
                  </p>
                {/each}
                {#if impact.gained.length}
                  <p class="mt-1 text-xs">Gains:
                    {#each impact.gained as g, i}{i ? '; ' : ''}{permissionText(g.permissions)} on {scope(g)} (via {teamName(g.teamId)}){/each}
                  </p>
                {/if}
                {#if impact.lost.length}
                  <p class="mt-1 text-xs">Loses:
                    {#each impact.lost as g, i}{i ? '; ' : ''}{permissionText(g.permissions)} on {scope(g)}{/each}
                  </p>
                {/if}
                {#if !impact.flags.length && !impact.gained.length && !impact.lost.length}
                  <p class="mt-1 text-xs text-muted-foreground">No change to what it can access.</p>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      {#if needsAck}
        <label class="flex items-start gap-2 text-sm">
          <input type="checkbox" bind:checked={ack} class="mt-0.5" />
          <span>
            {preview.widensAccess ? 'I understand this gives some tokens more access.' : 'I understand this cannot be undone.'}
          </span>
        </label>
      {/if}

      <Dialog.Footer>
        <Button variant="outline" on:click={() => dispatch('cancel')} disabled={busy}>Cancel</Button>
        <Button
          variant={destructive || preview.widensAccess ? 'destructive' : 'default'}
          disabled={busy || (needsAck && !ack)}
          on:click={() => change && dispatch('confirm', change)}
        >
          {busy ? 'Applying…' : 'Apply change'}
        </Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
