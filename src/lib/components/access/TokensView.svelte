<script lang="ts">
  import type { ArcClient } from '$lib/arcClient';
  import TokenManager from '$lib/components/TokenManager.svelte';

  export let client: ArcClient;
  export let arcVersion = '';
  export let orgId: string;
  export let instanceId: string;
  /**
   * Show Arc access control beside the tokens: the instance is Enterprise with
   * RBAC (licensed or not) and the viewer is an owner or admin. Otherwise this
   * is the plain token list, as on OSS.
   */
  export let withAccess = false;

  let selectedTokenId: number | null = null;
  let reloadKey = 0;
</script>

{#if withAccess}
  <div class="grid h-full grid-cols-1 overflow-auto xl:grid-cols-2 xl:overflow-hidden">
    <div class="min-h-0 xl:overflow-auto xl:border-r">
      <TokenManager
        {client}
        {arcVersion}
        selectable
        selectedId={selectedTokenId}
        on:select={(e) => (selectedTokenId = e.detail.id)}
        on:changed={() => (reloadKey += 1)}
      />
    </div>
    <div class="min-h-0 p-4 xl:overflow-auto">
      <!-- Loaded on demand: only admins of RBAC instances see it. -->
      {#await import('./AccessView.svelte') then mod}
        <svelte:component this={mod.default} {orgId} {instanceId} {selectedTokenId} {reloadKey} />
      {/await}
    </div>
  </div>
{:else}
  <TokenManager {client} {arcVersion} />
{/if}
