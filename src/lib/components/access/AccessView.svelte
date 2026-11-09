<script lang="ts">
  import { createEventDispatcher, tick } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { AccessApiError, applyAccessChange, getAccess } from '$lib/cloudApi';
  import {
    permissionText,
    previewFingerprint,
    tokenAccess,
    type RbacChange,
    type RbacMeasurementPermission,
    type RbacRole,
    type RbacSnapshot,
    type RbacTeam,
  } from '$lib/rbac';
  import { formatAge } from '$lib/format';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import ChangeDialog from './ChangeDialog.svelte';
  import EditDialog, { type EditTarget } from './EditDialog.svelte';
  import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-svelte';

  export let orgId: string;
  export let instanceId: string;
  /** Which part to show: the selected token's access, or teams and roles. */
  export let section: 'tokens' | 'teams';
  /** The token chosen in the token list beside this panel. */
  export let selectedTokenId: number | null = null;
  /** Team to bring into view in the teams section. */
  export let focusTeamId: number | null = null;
  /** Bumped by the parent when tokens change (created, deleted…). */
  export let reloadKey = 0;
  /** Shared with the parent so both sections and the token list use one load. */
  export let snapshot: RbacSnapshot | null = null;

  const dispatch = createEventDispatcher<{ openToken: number; openTeam: number }>();
  let loadError: AccessApiError | null = null;
  let loading = false;
  let now = Date.now();

  let editing: EditTarget | null = null;
  let editInitial: RbacChange | null = null;
  let serverFields: Record<string, string> | null = null;
  let pending: RbacChange | null = null;
  /** The form a change came from, to reopen it when Arc rejects a field. */
  let pendingFrom: EditTarget | null = null;
  let applying = false;
  let addTeamId = '';
  let request = 0;

  async function load() {
    const mine = ++request;
    loading = true;
    try {
      const s = await getAccess(orgId, instanceId);
      if (mine !== request) return;
      snapshot = s;
      loadError = null;
    } catch (err) {
      if (mine !== request) return;
      loadError = err instanceof AccessApiError ? err : new AccessApiError('error', 'Could not load access control');
    } finally {
      if (mine === request) loading = false;
      now = Date.now();
    }
  }
  // Load on first use and when the parent asks; switching sections reuses it.
  // A snapshot handed over by the parent (switching sections) counts as loaded.
  let loadedKey: number | null = snapshot ? reloadKey : null;
  $: if (loadedKey !== reloadKey || !snapshot) {
    loadedKey = reloadKey;
    load();
  }
  $: selectedTokenId, (addTeamId = '');

  // Bring a team into view when another section links to it.
  $: if (section === 'teams' && focusTeamId !== null && snapshot) scrollToTeam(focusTeamId);
  async function scrollToTeam(id: number) {
    await tick();
    document.getElementById(`rbac-team-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  let addMember: Record<number, string> = {};

  function propose(change: RbacChange, from: EditTarget | null = null) {
    editing = null;
    pending = change;
    pendingFrom = from;
  }

  const RESULT_TEXT = {
    applied: 'Change applied',
    applied_after_error: 'Arc reported an error, but the change was applied',
    not_visible: 'Arc reported an error and the change does not show yet. Reload before trying again: in a cluster it may still apply.',
    unknown: 'Arc did not confirm the change. Reload and check before trying again.',
  } as const;

  async function confirm(change: RbacChange) {
    if (!snapshot) return;
    applying = true;
    try {
      const out = await applyAccessChange(orgId, instanceId, change, previewFingerprint(snapshot, change));
      pending = null;
      addTeamId = '';
      (out.result === 'applied' ? toast.success : toast.warning)(RESULT_TEXT[out.result]);
      if (out.snapshot) snapshot = out.snapshot;
      else await load();
      now = Date.now();
    } catch (err) {
      const e = err instanceof AccessApiError ? err : new AccessApiError('error', 'The change failed');
      pending = null;
      if (e.fields && pendingFrom) {
        // Back to the form with what was typed and Arc's objection next to the field.
        serverFields = e.fields;
        editInitial = change;
        editing = pendingFrom;
      } else {
        toast.error(e.message);
        if (e.code === 'stale' || e.code === 'not_found') await load();
      }
    } finally {
      applying = false;
    }
  }

  function edit(target: EditTarget) {
    serverFields = null;
    editInitial = null;
    editing = target;
  }

  // Lookups once per snapshot, not per row per render.
  let teamsByOrg = new Map<number, RbacTeam[]>();
  let rolesByTeam = new Map<number, RbacRole[]>();
  let mpsByRole = new Map<number, RbacMeasurementPermission[]>();
  let teamById = new Map<number, RbacTeam>();
  let orgName = new Map<number, string>();
  let tokensByTeam = new Map<number, number[]>();
  let tokenName = new Map<number, string>();
  $: if (snapshot) {
    const groupBy = <T>(items: T[], key: (t: T) => number) => {
      const m = new Map<number, T[]>();
      for (const it of items) m.set(key(it), [...(m.get(key(it)) ?? []), it]);
      return m;
    };
    teamsByOrg = groupBy(snapshot.teams, (t) => t.orgId);
    rolesByTeam = groupBy(snapshot.roles, (r) => r.teamId);
    mpsByRole = groupBy(snapshot.measurementPermissions, (m) => m.roleId);
    teamById = new Map(snapshot.teams.map((t) => [t.id, t]));
    orgName = new Map(snapshot.orgs.map((o) => [o.id, o.name]));
    tokenName = new Map(snapshot.tokens.map((t) => [t.id, t.name]));
    tokensByTeam = new Map();
    for (const [tokenId, teamIds] of Object.entries(snapshot.memberships)) {
      for (const teamId of teamIds) tokensByTeam.set(teamId, [...(tokensByTeam.get(teamId) ?? []), Number(tokenId)]);
    }
  }

  $: selectedToken = snapshot?.tokens.find((t) => t.id === selectedTokenId) ?? null;
  $: access = snapshot && selectedToken ? tokenAccess(snapshot, selectedToken.id) : null;
  $: memberOf = snapshot && selectedToken ? snapshot.memberships[selectedToken.id] ?? [] : [];
  $: joinable = snapshot ? snapshot.teams.filter((t) => !memberOf.includes(t.id)) : [];

  const teamName = (id: number) => teamById.get(id)?.name ?? snapshot?.teamNames[id] ?? `team ${id}`;
  const orgOfTeam = (id: number) => orgName.get(teamById.get(id)?.orgId ?? -1) ?? '';

  const MODE_LABEL = {
    admin_bypass: 'Admin: access control does not apply to it',
    disabled: 'Disabled or expired: no access',
    rbac: 'Governed by its teams',
    rbac_unknown: 'Governed by its teams (their grants cannot be read without an RBAC license)',
    token: 'Its own permissions, on every database',
  } as const;
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between gap-2">
    <div>
      <h3 class="font-semibold">Access control</h3>
      <p class="text-xs text-muted-foreground">
        Arc decides what each token can read and write. A token in no team uses its own permissions everywhere; once in a
        team it can do only what its teams grant; <code>admin</code> bypasses this. Changes are previewed first and recorded in
        the instance's change history.
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      {#if snapshot}<span class="text-xs text-muted-foreground">loaded {formatAge(now - snapshot.loadedAt)}</span>{/if}
      <Button variant="ghost" size="sm" on:click={load} disabled={loading} aria-label="Reload access control">
        <RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
      </Button>
    </div>
  </div>

  {#if !snapshot && loadError}
    <div class="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm" role="alert">
      Could not load access control: {loadError.message}
      <Button size="sm" variant="outline" class="ml-2" on:click={load}>Try again</Button>
    </div>
  {:else if !snapshot}
    <p class="py-6 text-center text-sm text-muted-foreground">Loading access control…</p>
  {:else}
    {#if !snapshot.licensed}
      <div class="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-100" role="note">
        The license does not include RBAC, so organizations, teams and roles cannot be managed. Tokens still in teams are
        governed by them; removing a token from its teams gives it back its own permissions.
      </div>
    {/if}
    {#if snapshot.truncated}
      <p class="text-sm text-yellow-700 dark:text-yellow-400" role="note">
        This instance has more access-control items than Launchpad loads. Some are not shown, and only removing a token from a
        team can be done here.
      </p>
    {/if}

    {#if section === 'tokens'}
    <!-- The selected token -->
    <section class="rounded-lg border bg-card p-4" aria-labelledby="rbac-token">
      {#if selectedToken && access}
        <h4 id="rbac-token" class="font-mono font-semibold">{selectedToken.name}</h4>
        <p class="mt-1 text-sm">
          {MODE_LABEL[access.mode]}{#if access.mode === 'token'}: {permissionText(access.ownPermissions)}{/if}
        </p>

        {#if access.mode !== 'admin_bypass' && access.mode !== 'disabled'}
          <h5 class="mt-4 text-xs font-semibold uppercase text-muted-foreground">Teams</h5>
          <ul class="mt-1 space-y-1">
            {#each memberOf as teamId (teamId)}
              <li class="flex items-center justify-between text-sm">
                <span>
                  {#if snapshot.licensed}
                    <button type="button" class="underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" on:click={() => dispatch('openTeam', teamId)}>{teamName(teamId)}</button>
                  {:else}{teamName(teamId)}{/if}
                  <span class="text-xs text-muted-foreground">{orgOfTeam(teamId)}</span>
                </span>
                <Button size="sm" variant="ghost" aria-label="Remove {selectedToken.name} from {teamName(teamId)}"
                  on:click={() => selectedToken && propose({ kind: 'membership.remove', tokenId: selectedToken.id, teamId })}>Remove</Button>
              </li>
            {:else}
              <li class="text-sm text-muted-foreground">In no team.</li>
            {/each}
          </ul>
          {#if snapshot.licensed && !snapshot.truncated && joinable.length}
            <form class="mt-2 flex gap-2" on:submit|preventDefault={() => selectedToken && addTeamId && propose({ kind: 'membership.add', tokenId: selectedToken.id, teamId: Number(addTeamId) })}>
              <select bind:value={addTeamId} aria-label="Team to add {selectedToken.name} to" class="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm">
                <option value="">Add to a team…</option>
                {#each joinable as t (t.id)}<option value={String(t.id)}>{t.name} ({orgOfTeam(t.id)})</option>{/each}
              </select>
              <Button size="sm" type="submit" disabled={!addTeamId}>Review</Button>
            </form>
          {/if}
        {/if}

        {#if access.mode === 'rbac'}
          <h5 class="mt-4 text-xs font-semibold uppercase text-muted-foreground">What it can access</h5>
          {#if access.grants.length === 0}
            <p class="mt-1 text-sm font-medium text-destructive">Nothing: its teams grant no access, or are disabled.</p>
          {:else}
            <table class="mt-1 w-full text-sm">
              <thead class="text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" class="py-1 font-medium">Databases</th>
                  <th scope="col" class="py-1 font-medium">Measurements</th>
                  <th scope="col" class="py-1 font-medium">Permissions</th>
                  <th scope="col" class="py-1 font-medium">Via</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                {#each access.grants as g (`${g.roleId}|${g.mpId ?? '-'}`)}
                  <tr>
                    <td class="py-1 font-mono">{g.databasePattern}</td>
                    <td class="py-1 font-mono">{g.measurementPattern ?? 'all'}</td>
                    <td class="py-1">{permissionText(g.permissions)}</td>
                    <td class="py-1 text-xs text-muted-foreground">{teamName(g.teamId)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
          {#if !access.routeGate.query || !access.routeGate.ingest}
            <p class="mt-2 text-xs text-yellow-700 dark:text-yellow-400">
              Arc's SQL and write endpoints also require the token's own
              {!access.routeGate.query && !access.routeGate.ingest ? 'read and write permissions' : !access.routeGate.query ? 'read permission' : 'write permission'}
              (it has: {permissionText(access.ownPermissions)}), so it cannot
              {!access.routeGate.query && !access.routeGate.ingest ? 'query or write' : !access.routeGate.query ? 'query' : 'write'}
              whatever its teams grant.
            </p>
          {/if}
        {/if}
      {:else}
        <p id="rbac-token" class="text-sm text-muted-foreground">Select a token's name to see its teams and what it can access.</p>
      {/if}
    </section>
    {/if}

    {#if section === 'teams' && snapshot.licensed}
      <section class="rounded-lg border bg-card p-4" aria-labelledby="rbac-structure">
        <div class="mb-3 flex items-center justify-between">
          <h4 id="rbac-structure" class="font-semibold">Organizations, teams and roles</h4>
          <Button size="sm" variant="outline" on:click={() => edit({ kind: 'org.create' })} disabled={snapshot.truncated}><Plus class="mr-1 h-4 w-4" />Organization</Button>
        </div>
        {#if snapshot.orgs.length === 0}
          <p class="text-sm text-muted-foreground">No organizations yet. Create one, add a team, then give the team roles.</p>
        {/if}
        <ul class="space-y-4">
          {#each snapshot.orgs as org (org.id)}
            <li>
              <div class="flex items-center justify-between gap-2">
                <div>
                  <span class="font-medium">{org.name}</span>
                  {#if org.description}<span class="ml-2 text-xs text-muted-foreground">{org.description}</span>{/if}
                </div>
                <div class="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" on:click={() => edit({ kind: 'team.create', orgId: org.id })} aria-label="Add a team to {org.name}"><Plus class="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" on:click={() => edit({ kind: 'org.update', orgId: org.id, name: org.name, description: org.description })} aria-label="Edit {org.name}"><Pencil class="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" on:click={() => propose({ kind: 'org.delete', orgId: org.id })} aria-label="Delete {org.name}"><Trash2 class="h-4 w-4 text-destructive" /></Button>
                </div>
              </div>
              <ul class="mt-2 space-y-3 border-l pl-4">
                {#each teamsByOrg.get(org.id) ?? [] as team (team.id)}
                  {@const members = tokensByTeam.get(team.id) ?? []}
                  <li id="rbac-team-{team.id}" class="scroll-mt-4 rounded-md {team.id === focusTeamId ? 'bg-accent/40 p-2' : ''}">
                    <div class="flex items-center justify-between gap-2">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-medium">{team.name}</span>
                        {#if !team.enabled}<Badge variant="secondary">disabled</Badge>{/if}
                      </div>
                      <div class="flex shrink-0 gap-1">
                        <Button size="sm" variant="ghost" on:click={() => edit({ kind: 'role.create', teamId: team.id })} aria-label="Add a role to {team.name}"><Plus class="h-4 w-4" /></Button>
                        <Button size="sm" variant="ghost" aria-label="{team.enabled ? 'Disable' : 'Enable'} team {team.name}" on:click={() => propose({ kind: 'team.update', teamId: team.id, enabled: !team.enabled })}>{team.enabled ? 'Disable' : 'Enable'}</Button>
                        <Button size="sm" variant="ghost" on:click={() => edit({ kind: 'team.update', teamId: team.id, name: team.name, description: team.description })} aria-label="Edit {team.name}"><Pencil class="h-4 w-4" /></Button>
                        <Button size="sm" variant="ghost" on:click={() => propose({ kind: 'team.delete', teamId: team.id })} aria-label="Delete {team.name}"><Trash2 class="h-4 w-4 text-destructive" /></Button>
                      </div>
                    </div>
                    <div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      <span class="text-muted-foreground">Tokens:</span>
                      {#each members as tokenId (tokenId)}
                        <span class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono">
                          <button type="button" class="underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" on:click={() => dispatch('openToken', tokenId)}>{tokenName.get(tokenId) ?? `token ${tokenId}`}</button>
                          <button type="button" class="text-muted-foreground hover:text-destructive" aria-label="Remove {tokenName.get(tokenId) ?? `token ${tokenId}`} from {team.name}"
                            on:click={() => propose({ kind: 'membership.remove', tokenId, teamId: team.id })}>×</button>
                        </span>
                      {:else}
                        <span class="text-muted-foreground">none</span>
                      {/each}
                      {#if !snapshot.truncated}
                        <select
                          aria-label="Add a token to {team.name}"
                          class="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
                          bind:value={addMember[team.id]}
                          on:change={() => {
                            const tokenId = Number(addMember[team.id]);
                            addMember[team.id] = '';
                            if (tokenId) propose({ kind: 'membership.add', tokenId, teamId: team.id });
                          }}
                        >
                          <option value="">+ token…</option>
                          {#each snapshot.tokens.filter((t) => !members.includes(t.id)) as t (t.id)}<option value={String(t.id)}>{t.name}</option>{/each}
                        </select>
                      {/if}
                    </div>
                    <ul class="mt-1 space-y-1 border-l pl-4">
                      {#each rolesByTeam.get(team.id) ?? [] as role (role.id)}
                        {@const mps = mpsByRole.get(role.id) ?? []}
                        <li class="text-sm">
                          <div class="flex items-center justify-between gap-2">
                            <span>
                              <code class="font-mono">{role.databasePattern}</code>:
                              {#if mps.length}
                                <span class="text-muted-foreground line-through">{permissionText(role.permissions)}</span>
                                <span class="sr-only">(replaced by its measurement permissions)</span>
                              {:else}{permissionText(role.permissions)}{/if}
                              <span class="ml-1 text-xs text-muted-foreground">
                                · reaches {members.length} token{members.length === 1 ? '' : 's'}{team.enabled ? '' : ' (team disabled)'}
                              </span>
                            </span>
                            <div class="flex shrink-0 gap-1">
                              <Button size="sm" variant="ghost" aria-label="Limit role {role.databasePattern} of {team.name} to measurements" on:click={() => edit({ kind: 'mp.create', roleId: role.id })}>Limit</Button>
                              <Button size="sm" variant="ghost" on:click={() => edit({ kind: 'role.update', roleId: role.id, databasePattern: role.databasePattern, permissions: role.permissions })} aria-label="Edit role {role.databasePattern} of {team.name}"><Pencil class="h-4 w-4" /></Button>
                              <Button size="sm" variant="ghost" on:click={() => propose({ kind: 'role.delete', roleId: role.id })} aria-label="Delete role {role.databasePattern} of {team.name}"><Trash2 class="h-4 w-4 text-destructive" /></Button>
                            </div>
                          </div>
                          {#if mps.length}
                            <ul class="ml-4 mt-1 space-y-1">
                              {#each mps as mp (mp.id)}
                                <li class="flex items-center justify-between gap-2 text-xs">
                                  <span>measurements <code class="font-mono">{mp.measurementPattern}</code>: {permissionText(mp.permissions)}</span>
                                  <Button size="sm" variant="ghost" on:click={() => propose({ kind: 'mp.delete', mpId: mp.id })} aria-label="Remove measurement permission {mp.measurementPattern} from role {role.databasePattern}"><Trash2 class="h-3.5 w-3.5 text-destructive" /></Button>
                                </li>
                              {/each}
                            </ul>
                          {/if}
                        </li>
                      {:else}
                        <li class="text-xs text-muted-foreground">No roles: members of this team can access nothing.</li>
                      {/each}
                    </ul>
                  </li>
                {:else}
                  <li class="text-xs text-muted-foreground">No teams.</li>
                {/each}
              </ul>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</div>

<EditDialog
  target={editing}
  initial={editInitial}
  bind:serverFields
  on:submit={(e) => editing && propose(e.detail, editing)}
  on:cancel={() => (editing = null)}
/>
{#if snapshot}
  <ChangeDialog change={pending} {snapshot} busy={applying} on:confirm={(e) => confirm(e.detail)} on:cancel={() => (pending = null)} />
{/if}
