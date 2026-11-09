<script lang="ts" context="module">
  import type { RbacPermission } from '$lib/rbac';
  /** What the form edits; the parent turns the submitted values into an RbacChange. */
  export type EditTarget =
    | { kind: 'org.create' }
    | { kind: 'org.update'; orgId: number; name: string; description: string }
    | { kind: 'team.create'; orgId: number }
    | { kind: 'team.update'; teamId: number; name: string; description: string }
    | { kind: 'role.create'; teamId: number }
    | { kind: 'role.update'; roleId: number; databasePattern: string; permissions: RbacPermission[] }
    | { kind: 'mp.create'; roleId: number };
</script>

<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { RBAC_PERMISSIONS, validateChange, type RbacChange } from '$lib/rbac';

  export let target: EditTarget | null;
  /** Field errors from Arc for the last attempt; cleared as soon as the admin edits. */
  export let serverFields: Record<string, string> | null = null;
  /** Values to start from instead of the target's (reopening after Arc rejected them). */
  export let initial: RbacChange | null = null;

  const dispatch = createEventDispatcher<{ submit: RbacChange; cancel: void }>();

  let name = '';
  let description = '';
  let pattern = '';
  let permissions: RbacPermission[] = ['read'];

  let touched = false;
  // Load once per opened target, not on every parent render (that would wipe typing).
  let loadedFor: EditTarget | null = null;
  $: if (target && target !== loadedFor) load(target, initial);
  function load(t: EditTarget, from: RbacChange | null) {
    loadedFor = t;
    touched = false;
    const f = (from ?? {}) as Partial<Record<'name' | 'description' | 'databasePattern' | 'measurementPattern' | 'permissions', unknown>>;
    name = typeof f.name === 'string' ? f.name : 'name' in t ? t.name : '';
    description = typeof f.description === 'string' ? f.description : 'description' in t ? t.description : '';
    pattern = typeof f.databasePattern === 'string' ? f.databasePattern : typeof f.measurementPattern === 'string' ? f.measurementPattern : t.kind === 'role.update' ? t.databasePattern : '';
    permissions = Array.isArray(f.permissions) ? (f.permissions as RbacPermission[]) : t.kind === 'role.update' ? [...t.permissions] : ['read'];
  }
  $: if (!target) loadedFor = null;

  function edited() {
    touched = true;
    serverFields = null;
  }

  $: isOrgOrTeam = !!target && (target.kind.startsWith('org.') || target.kind.startsWith('team.'));
  $: patternLabel = target?.kind === 'mp.create' ? 'Measurement pattern' : 'Database pattern';
  $: title = !target ? '' : {
    'org.create': 'New organization',
    'org.update': 'Edit organization',
    'team.create': 'New team',
    'team.update': 'Edit team',
    'role.create': 'New role',
    'role.update': 'Edit role',
    'mp.create': 'Limit the role to measurements',
  }[target.kind];

  function build(t: EditTarget, name: string, description: string, pattern: string, permissions: RbacPermission[]): RbacChange {
    switch (t.kind) {
      case 'org.create': return { kind: 'org.create', name, description };
      case 'org.update': return { kind: 'org.update', orgId: t.orgId, ...(name !== t.name && { name }), ...(description !== t.description && { description }) };
      case 'team.create': return { kind: 'team.create', orgId: t.orgId, name, description };
      case 'team.update': return { kind: 'team.update', teamId: t.teamId, ...(name !== t.name && { name }), ...(description !== t.description && { description }) };
      case 'role.create': return { kind: 'role.create', teamId: t.teamId, databasePattern: pattern, permissions };
      case 'role.update': {
        const samePerms = [...permissions].sort().join() === [...t.permissions].sort().join();
        return { kind: 'role.update', roleId: t.roleId, ...(pattern !== t.databasePattern && { databasePattern: pattern }), ...(!samePerms && { permissions }) };
      }
      case 'mp.create': return { kind: 'mp.create', roleId: t.roleId, measurementPattern: pattern, permissions };
    }
  }

  // The fields are arguments so Svelte re-runs this as the admin types.
  $: draft = target ? build(target, name, description, pattern, permissions) : null;
  $: validation = draft ? validateChange(draft) ?? {} : {};
  // "Nothing to change" only once something was touched.
  $: errors = Object.fromEntries(
    Object.entries({ ...validation, ...(serverFields ?? {}) }).filter(([k]) => k !== 'form' || touched),
  ) as Record<string, string>;
  $: blocked = Object.keys(validation).length > 0 || !!serverFields;
  $: patternError = errors.databasePattern ?? errors.measurementPattern;

  function toggle(p: RbacPermission) {
    permissions = permissions.includes(p) ? permissions.filter((x) => x !== p) : [...permissions, p];
    edited();
  }
  const inputClass = 'flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  function onOpenChange(open: boolean) {
    if (!open) dispatch('cancel');
  }
</script>

<Dialog.Root open={target !== null} onOpenChange={onOpenChange}>
  <Dialog.Content class="max-w-lg">
    {#if target && draft}
      <form class="space-y-4" on:input={edited} on:submit|preventDefault={() => draft && !blocked && dispatch('submit', draft)}>
        <Dialog.Header><Dialog.Title>{title}</Dialog.Title></Dialog.Header>

        {#if isOrgOrTeam}
          <div>
            <label for="rbac-name" class="mb-1 block text-xs text-muted-foreground">Name</label>
            <input id="rbac-name" class={inputClass} bind:value={name} autocomplete="off" aria-invalid={!!errors.name} aria-describedby={errors.name ? 'rbac-name-error' : undefined} />
            {#if errors.name}<p id="rbac-name-error" class="mt-1 text-xs text-destructive">{errors.name}</p>{/if}
          </div>
          <div>
            <label for="rbac-description" class="mb-1 block text-xs text-muted-foreground">Description</label>
            <input id="rbac-description" class={inputClass} bind:value={description} autocomplete="off" aria-invalid={!!errors.description} aria-describedby={errors.description ? 'rbac-description-error' : undefined} />
            {#if errors.description}<p id="rbac-description-error" class="mt-1 text-xs text-destructive">{errors.description}</p>{/if}
          </div>
        {:else}
          <div>
            <label for="rbac-pattern" class="mb-1 block text-xs text-muted-foreground">{patternLabel}</label>
            <input id="rbac-pattern" class="{inputClass} font-mono" bind:value={pattern} placeholder="e.g. prod_*" autocomplete="off" aria-invalid={!!patternError} aria-describedby="rbac-pattern-help" />
            <p id="rbac-pattern-help" class="mt-1 text-xs {patternError ? 'text-destructive' : 'text-muted-foreground'}">
              {patternError ?? 'An exact name, prefix*, *suffix, or * for all.'}
            </p>
          </div>
          <fieldset>
            <legend class="mb-1 text-xs text-muted-foreground">Permissions</legend>
            <div class="flex flex-wrap gap-3">
              {#each RBAC_PERMISSIONS as p}
                <label class="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={permissions.includes(p)} on:change={() => toggle(p)} /> {p}
                </label>
              {/each}
            </div>
            {#if errors.permissions}<p class="mt-1 text-xs text-destructive">{errors.permissions}</p>{/if}
            {#if target.kind === 'mp.create'}
              <p class="mt-2 text-xs text-muted-foreground">
                Once a role has a measurement permission, it grants only its measurement permissions, not its database-wide ones.
              </p>
            {/if}
          </fieldset>
        {/if}
        {#if errors.form}<p class="text-xs text-destructive">{errors.form}</p>{/if}

        <Dialog.Footer>
          <Button type="button" variant="outline" on:click={() => dispatch('cancel')}>Cancel</Button>
          <Button type="submit" disabled={blocked}>Review</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
