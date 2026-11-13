<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import type { ArcClient } from '$lib/arcClient';
  import type { RbacSnapshot } from '$lib/rbac';
  import type { CapabilityView } from '$lib/capabilities';
  import TokenManager from '$lib/components/TokenManager.svelte';

  export let client: ArcClient;
  export let arcVersion = '';
  export let orgId: string;
  export let instanceId: string;
  export let currentRole = 'viewer';
  /** Token management in Arc, from capability discovery (see TokenManager). */
  export let capability: CapabilityView | null = null;
  /**
   * Show Arc access control: the instance is Enterprise with RBAC and the
   * viewer is an owner or admin. Otherwise this is the plain token list, as
   * on OSS.
   */
  export let withAccess = false;
  /** Arc query governance is available: adds the Query limits section. */
  export let withLimits = false;

  type Section = 'tokens' | 'teams' | 'limits';
  /** Sub-section, kept in the URL (?section=…) like the console tab. */
  const requested = $page.url.searchParams.get('section');
  let section: Section = requested === 'teams' || requested === 'limits' ? requested : 'tokens';
  let limitsTokenId: number | null = null;
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
  function openLimits(tokenId: number) {
    limitsTokenId = tokenId;
    show('limits');
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

  $: SECTIONS = [
    { id: 'tokens' as const, label: 'Tokens' },
    ...(withAccess ? [{ id: 'teams' as const, label: 'Teams & roles' }] : []),
    ...(withLimits ? [{ id: 'limits' as const, label: 'Query limits' }] : []),
  ];
  // A section not offered (yet: capabilities load after mount) shows Tokens
  // without forgetting what the URL asked for.
  $: shown = SECTIONS.some((s) => s.id === section) ? section : 'tokens';
  // AccessView only when RBAC is on; Query limits alone does not need it.
  $: accessModule = withAccess ? import('./AccessView.svelte') : Promise.resolve(null);
</script>

{#if withAccess || withLimits}
  <div class="flex h-full flex-col">
    <nav class="flex gap-1 border-b px-4 pt-2" aria-label="Access sections">
      {#each SECTIONS as s (s.id)}
        <button
          type="button"
          aria-current={shown === s.id ? 'page' : undefined}
          on:click={() => show(s.id)}
          class="-mb-px border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
            {shown === s.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
        >{s.label}</button>
      {/each}
    </nav>

    {#await accessModule then mod}
      {#if shown === 'tokens'}
        <div class="grid min-h-0 flex-1 grid-cols-1 overflow-auto xl:grid-cols-2 xl:overflow-hidden">
          <div class="min-h-0 xl:overflow-auto xl:border-r">
            <TokenManager
              {client}
              {arcVersion}
              {currentRole}
              {capability}
              selectable
              selectedId={selectedTokenId}
              {teamsByToken}
              on:select={(e) => (selectedTokenId = e.detail.id)}
              on:changed={() => (reloadKey += 1)}
              on:recheck
            />
          </div>
          <div class="min-h-0 p-4 xl:overflow-auto">
            {#if mod}
              <svelte:component this={mod.default} section="tokens" {orgId} {instanceId} {selectedTokenId} {reloadKey} bind:snapshot on:openTeam={(e) => openTeam(e.detail)} />
            {/if}
            {#if withLimits && selectedTokenId !== null}
              <p class="mt-3 text-sm">
                <button type="button" class="underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" on:click={() => selectedTokenId !== null && openLimits(selectedTokenId)}>Query limits and usage of this token →</button>
              </p>
            {:else if !withAccess}
              <p class="text-sm text-muted-foreground">Select a token's name to see its query limits.</p>
            {/if}
          </div>
        </div>
      {:else if shown === 'limits'}
        <div class="min-h-0 flex-1 overflow-auto p-4">
          {#await import('./QueryLimitsView.svelte') then lim}
            <svelte:component this={lim.default} {orgId} {instanceId} focusTokenId={limitsTokenId} on:openToken={(e) => openToken(e.detail)} />
          {:catch}
            <p class="text-sm text-destructive" role="alert">Could not load this section. Reload the page to try again.</p>
          {/await}
        </div>
      {:else if mod}
        <div class="min-h-0 flex-1 overflow-auto p-4">
          <svelte:component this={mod.default} section="teams" {orgId} {instanceId} {focusTeamId} {reloadKey} bind:snapshot on:openToken={(e) => openToken(e.detail)} />
        </div>
      {/if}
    {:catch}
      <p class="p-4 text-sm text-destructive" role="alert">Could not load this section. Reload the page to try again.</p>
    {/await}
  </div>
{:else}
  <TokenManager {client} {arcVersion} {currentRole} {capability} on:recheck />
{/if}
