<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import type { ArcClient } from '$lib/arcClient';
  import type { RbacSnapshot } from '$lib/rbac';
  import TokenManager from '$lib/components/TokenManager.svelte';

  export let client: ArcClient;
  export let arcVersion = '';
  export let orgId: string;
  export let instanceId: string;
  /**
   * Show Arc access control: the instance is Enterprise with RBAC and the
   * viewer is an owner or admin. Otherwise this is the plain token list, as
   * on OSS.
   */
  export let withAccess = false;

  type Section = 'tokens' | 'teams';
  /** Sub-section, kept in the URL (?section=teams) like the console tab. */
  let section: Section = $page.url.searchParams.get('section') === 'teams' ? 'teams' : 'tokens';
  let selectedTokenId: number | null = null;
  let focusTeamId: number | null = null;
  let reloadKey = 0;
  /** One load shared by both sections and the token list. */
  let snapshot: RbacSnapshot | null = null;

  function show(next: Section) {
    section = next;
    const url = new URL($page.url);
    if (next === 'tokens') url.searchParams.delete('section');
    else url.searchParams.set('section', next);
    goto(url, { replaceState: true, noScroll: true, keepFocus: true });
  }
  function openToken(id: number) {
    selectedTokenId = id;
    show('tokens');
  }
  function openTeam(id: number) {
    focusTeamId = id;
    show('teams');
  }

  // Team names per token, for the token cards.
  $: teamsByToken = snapshot
    ? Object.fromEntries(
        Object.entries(snapshot.memberships).map(([tokenId, teamIds]) => [
          tokenId,
          teamIds.map((id) => snapshot?.teams.find((t) => t.id === id)?.name ?? snapshot?.teamNames[id] ?? `team ${id}`),
        ]),
      )
    : null;

  const SECTIONS: Array<{ id: Section; label: string }> = [
    { id: 'tokens', label: 'Tokens' },
    { id: 'teams', label: 'Teams & roles' },
  ];
</script>

{#if withAccess}
  <div class="flex h-full flex-col">
    <nav class="flex gap-1 border-b px-4 pt-2" aria-label="Access sections">
      {#each SECTIONS as s (s.id)}
        <button
          type="button"
          aria-current={section === s.id ? 'page' : undefined}
          on:click={() => show(s.id)}
          class="-mb-px border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
            {section === s.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
        >{s.label}</button>
      {/each}
    </nav>

    {#await import('./AccessView.svelte') then mod}
      {#if section === 'tokens'}
        <div class="grid min-h-0 flex-1 grid-cols-1 overflow-auto xl:grid-cols-2 xl:overflow-hidden">
          <div class="min-h-0 xl:overflow-auto xl:border-r">
            <TokenManager
              {client}
              {arcVersion}
              selectable
              selectedId={selectedTokenId}
              {teamsByToken}
              on:select={(e) => (selectedTokenId = e.detail.id)}
              on:changed={() => (reloadKey += 1)}
            />
          </div>
          <div class="min-h-0 p-4 xl:overflow-auto">
            <svelte:component this={mod.default} section="tokens" {orgId} {instanceId} {selectedTokenId} {reloadKey} bind:snapshot on:openTeam={(e) => openTeam(e.detail)} />
          </div>
        </div>
      {:else}
        <div class="min-h-0 flex-1 overflow-auto p-4">
          <svelte:component this={mod.default} section="teams" {orgId} {instanceId} {focusTeamId} {reloadKey} bind:snapshot on:openToken={(e) => openToken(e.detail)} />
        </div>
      {/if}
    {/await}
  </div>
{:else}
  <TokenManager {client} {arcVersion} />
{/if}
