<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { AccessApiError, applyAccessChange, getAccess } from '$lib/cloudApi';
  import {
    permissionText,
    previewFingerprint,
    tokenAccess,
    type RbacChange,
    type RbacSnapshot,
  } from '$lib/rbac';
  import { formatAge } from '$lib/format';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import ChangeDialog from './ChangeDialog.svelte';
  import EditDialog, { type EditTarget } from './EditDialog.svelte';
  import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-svelte';

  export let orgId: string;
  export let instanceId: string;

  let snapshot: RbacSnapshot | null = null;
  let loadError: AccessApiError | null = null;
  let loading = false;
  let now = Date.now();

  let editing: EditTarget | null = null;
  let serverFields: Record<string, string> | null = null;
  let pending: RbacChange | null = null;
  /** The form a change came from, to reopen it when Arc rejects a field. */
  let pendingFrom: EditTarget | null = null;
  let applying = false;

  let selectedTokenId: number | null = null;
  let addTeamId = '';

  async function load() {
    loading = true;
    try {
      snapshot = await getAccess(orgId, instanceId);
      loadError = null;
    } catch (err) {
      loadError = err instanceof AccessApiError ? err : new AccessApiError('error', 'Could not load access control');
    } finally {
      loading = false;
      now = Date.now();
    }
  }
  onMount(() => {
    load();
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  function propose(change: RbacChange, from: EditTarget | null = null) {
    editing = null;
    pending = change;
    pendingFrom = from;
  }

  const RESULT_TEXT = {
    applied: 'Change applied',
    applied_after_error: 'Arc reported an error, but the change was applied',
    not_applied: 'Arc reported an error and the change was not applied; nothing changed',
    unknown: 'Arc did not confirm the change; check the tree below before trying again',
  } as const;

  async function confirm(change: RbacChange) {
    if (!snapshot) return;
    applying = true;
    try {
      const out = await applyAccessChange(orgId, instanceId, change, previewFingerprint(snapshot, change));
      snapshot = out.snapshot;
      now = Date.now();
      pending = null;
      (out.result === 'applied' ? toast.success : toast.warning)(RESULT_TEXT[out.result]);
    } catch (err) {
      const e = err instanceof AccessApiError ? err : new AccessApiError('error', 'The change failed');
      pending = null;
      if (e.code === 'stale') {
        toast.warning(e.message);
        await load();
      } else if (e.code === 'invalid' && e.fields && pendingFrom) {
        serverFields = e.fields;
        editing = pendingFrom;
      } else {
        toast.error(e.message);
      }
    } finally {
      applying = false;
    }
  }

  function edit(target: EditTarget) {
    serverFields = null;
    editing = target;
  }

  $: tokens = snapshot?.tokens ?? [];
  $: selectedToken = tokens.find((t) => t.id === selectedTokenId) ?? null;
  $: access = snapshot && selectedToken ? tokenAccess(snapshot, selectedToken.id) : null;
  $: memberOf = snapshot && selectedToken ? snapshot.memberships[selectedToken.id] ?? [] : [];
  $: joinable = snapshot ? snapshot.teams.filter((t) => !memberOf.includes(t.id)) : [];

  function teamName(id: number): string {
    return snapshot?.teams.find((t) => t.id === id)?.name ?? snapshot?.teamNames[id] ?? `team ${id}`;
  }
  function orgOfTeam(id: number): string {
    const t = snapshot?.teams.find((x) => x.id === id);
    return t ? snapshot?.orgs.find((o) => o.id === t.orgId)?.name ?? '' : '';
  }

  const MODE_LABEL = {
    admin_bypass: 'Admin: RBAC does not apply',
    disabled: 'Disabled: no access',
    rbac: 'Governed by RBAC',
    token: 'Own permissions on every database',
  } as const;
</script>

<div class="flex h-full flex-col overflow-auto p-4 [&>*]:shrink-0">
  <div class="mb-4 flex items-center justify-between gap-4">
    <div>
      <h2 class="text-lg font-semibold">Access</h2>
      <p class="text-xs text-muted-foreground">Arc's role-based access control for this instance.</p>
    </div>
    <div class="flex items-center gap-2">
      {#if snapshot}<span class="text-xs text-muted-foreground">loaded {formatAge(now - snapshot.loadedAt)}</span>{/if}
      <Button variant="ghost" size="sm" on:click={load} disabled={loading} aria-label="Reload access control">
        <RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
      </Button>
    </div>
  </div>

  <div class="mb-4 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
    <p>
      <strong class="text-foreground">Two layers.</strong> Your Launchpad role (owner, admin, member, viewer) decides who can
      manage this instance here. Arc access control, below, decides what each <em>Arc token</em> can read and write.
    </p>
    <p class="mt-2">
      A token in no team keeps its own permissions on every database. Once it joins a team, it can do only what its teams
      grant. A token with <code>admin</code> bypasses all of this. Every change is previewed first and recorded in the
      instance's change history with your name.
    </p>
  </div>

  {#if !snapshot && loadError}
    <div class="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm" role="status">
      Could not load access control: {loadError.message}
      <Button size="sm" variant="outline" class="ml-2" on:click={load}>Try again</Button>
    </div>
  {:else if !snapshot}
    <p class="py-8 text-center text-sm text-muted-foreground">Loading access control…</p>
  {:else}
    {#if !snapshot.licensed}
      <div class="mb-4 rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-100" role="note">
        This instance's license does not include RBAC, so organizations, teams and roles cannot be managed. Tokens that are still
        in teams are governed by them; you can remove a token from a team to give it back its own permissions.
      </div>
    {/if}
    {#if snapshot.truncated}
      <p class="mb-4 text-sm text-yellow-700 dark:text-yellow-400" role="note">This instance has more access-control items than Launchpad loads; some are not shown.</p>
    {/if}

    <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {#if snapshot.licensed}
        <section class="rounded-lg border bg-card p-4" aria-labelledby="rbac-structure">
          <div class="mb-3 flex items-center justify-between">
            <h3 id="rbac-structure" class="font-semibold">Organizations, teams and roles</h3>
            <Button size="sm" variant="outline" on:click={() => edit({ kind: 'org.create' })}><Plus class="mr-1 h-4 w-4" />Organization</Button>
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
                  {#each snapshot.teams.filter((t) => t.orgId === org.id) as team (team.id)}
                    <li>
                      <div class="flex items-center justify-between gap-2">
                        <div class="flex items-center gap-2">
                          <span class="text-sm font-medium">{team.name}</span>
                          {#if !team.enabled}<Badge variant="secondary">disabled</Badge>{/if}
                        </div>
                        <div class="flex shrink-0 gap-1">
                          <Button size="sm" variant="ghost" on:click={() => edit({ kind: 'role.create', teamId: team.id })} aria-label="Add a role to {team.name}"><Plus class="h-4 w-4" /></Button>
                          <Button size="sm" variant="ghost" on:click={() => propose({ kind: 'team.update', teamId: team.id, enabled: !team.enabled })}>{team.enabled ? 'Disable' : 'Enable'}</Button>
                          <Button size="sm" variant="ghost" on:click={() => edit({ kind: 'team.update', teamId: team.id, name: team.name, description: team.description })} aria-label="Edit {team.name}"><Pencil class="h-4 w-4" /></Button>
                          <Button size="sm" variant="ghost" on:click={() => propose({ kind: 'team.delete', teamId: team.id })} aria-label="Delete {team.name}"><Trash2 class="h-4 w-4 text-destructive" /></Button>
                        </div>
                      </div>
                      <ul class="mt-1 space-y-1 border-l pl-4">
                        {#each snapshot.roles.filter((r) => r.teamId === team.id) as role (role.id)}
                          {@const mps = snapshot.measurementPermissions.filter((m) => m.roleId === role.id)}
                          <li class="text-sm">
                            <div class="flex items-center justify-between gap-2">
                              <span>
                                <code class="font-mono">{role.databasePattern}</code>:
                                {#if mps.length}<span class="text-muted-foreground line-through" title="Replaced by its measurement permissions">{permissionText(role.permissions)}</span>{:else}{permissionText(role.permissions)}{/if}
                              </span>
                              <div class="flex shrink-0 gap-1">
                                <Button size="sm" variant="ghost" on:click={() => edit({ kind: 'mp.create', roleId: role.id })}>Limit</Button>
                                <Button size="sm" variant="ghost" on:click={() => edit({ kind: 'role.update', roleId: role.id, databasePattern: role.databasePattern, permissions: role.permissions })} aria-label="Edit role {role.databasePattern}"><Pencil class="h-4 w-4" /></Button>
                                <Button size="sm" variant="ghost" on:click={() => propose({ kind: 'role.delete', roleId: role.id })} aria-label="Delete role {role.databasePattern}"><Trash2 class="h-4 w-4 text-destructive" /></Button>
                              </div>
                            </div>
                            {#if mps.length}
                              <ul class="ml-4 mt-1 space-y-1">
                                {#each mps as mp (mp.id)}
                                  <li class="flex items-center justify-between gap-2 text-xs">
                                    <span>measurements <code class="font-mono">{mp.measurementPattern}</code>: {permissionText(mp.permissions)}</span>
                                    <Button size="sm" variant="ghost" on:click={() => propose({ kind: 'mp.delete', mpId: mp.id })} aria-label="Remove measurement permission {mp.measurementPattern}"><Trash2 class="h-3.5 w-3.5 text-destructive" /></Button>
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

      <section class="rounded-lg border bg-card p-4" aria-labelledby="rbac-tokens">
        <h3 id="rbac-tokens" class="mb-3 font-semibold">Tokens</h3>
        <div class="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Choose a token">
          {#each tokens as tok (tok.id)}
            <button
              type="button"
              aria-pressed={tok.id === selectedTokenId}
              on:click={() => (selectedTokenId = tok.id)}
              class="rounded-md border px-2.5 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                {tok.id === selectedTokenId ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent'}"
            >{tok.name}</button>
          {/each}
        </div>

        {#if selectedToken && access}
          <p class="text-sm">
            <span class="font-medium">{MODE_LABEL[access.mode]}</span>
            {#if access.mode === 'token'}: {permissionText(access.ownPermissions)}{/if}
          </p>

          {#if access.mode !== 'admin_bypass'}
            <h4 class="mt-4 text-xs font-semibold uppercase text-muted-foreground">Teams</h4>
            <ul class="mt-1 space-y-1">
              {#each memberOf as teamId (teamId)}
                <li class="flex items-center justify-between text-sm">
                  <span>{teamName(teamId)} <span class="text-xs text-muted-foreground">{orgOfTeam(teamId)}</span></span>
                  <Button size="sm" variant="ghost" on:click={() => selectedToken && propose({ kind: 'membership.remove', tokenId: selectedToken.id, teamId })}>Remove</Button>
                </li>
              {:else}
                <li class="text-sm text-muted-foreground">In no team.</li>
              {/each}
            </ul>
            {#if snapshot.licensed && joinable.length}
              <form class="mt-2 flex gap-2" on:submit|preventDefault={() => selectedToken && addTeamId && propose({ kind: 'membership.add', tokenId: selectedToken.id, teamId: Number(addTeamId) })}>
                <select bind:value={addTeamId} aria-label="Team to add the token to" class="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm">
                  <option value="">Add to a team…</option>
                  {#each joinable as t (t.id)}<option value={String(t.id)}>{t.name} ({orgOfTeam(t.id)})</option>{/each}
                </select>
                <Button size="sm" type="submit" disabled={!addTeamId}>Review</Button>
              </form>
            {/if}
          {/if}

          {#if access.mode === 'rbac'}
            <h4 class="mt-4 text-xs font-semibold uppercase text-muted-foreground">What it can access</h4>
            {#if access.grants.length === 0}
              <p class="mt-1 text-sm font-medium text-destructive">Nothing: its teams grant no access (or are disabled).</p>
            {:else}
              <table class="mt-1 w-full text-sm">
                <thead class="text-left text-xs text-muted-foreground">
                  <tr><th class="py-1 font-medium">Databases</th><th class="py-1 font-medium">Measurements</th><th class="py-1 font-medium">Permissions</th><th class="py-1 font-medium">Via</th></tr>
                </thead>
                <tbody class="divide-y">
                  {#each access.grants as g (`${g.roleId}|${g.measurementPattern}`)}
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
                (own permissions: {permissionText(access.ownPermissions)}), so it cannot
                {!access.routeGate.query && !access.routeGate.ingest ? 'query or write' : !access.routeGate.query ? 'query' : 'write'}
                yet, whatever its teams grant.
              </p>
            {/if}
          {/if}
        {:else}
          <p class="text-sm text-muted-foreground">Choose a token to see its teams and what it can access.</p>
        {/if}
      </section>
    </div>
  {/if}
</div>

<EditDialog
  target={editing}
  {serverFields}
  on:submit={(e) => editing && propose(e.detail, editing)}
  on:cancel={() => (editing = null)}
/>
{#if snapshot}
  <ChangeDialog change={pending} {snapshot} busy={applying} on:confirm={(e) => confirm(e.detail)} on:cancel={() => (pending = null)} />
{/if}
